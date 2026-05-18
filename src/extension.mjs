import { joinSession } from "@github/copilot-sdk/extension";
import { readAgentRelaySettings } from "./config.mjs";
import { getDefaultDatabasePath, openAgentRelayDatabase } from "./db.mjs";
import { AgentRelayRuntime, createAgentRelayCommands, createAgentRelayTools, readRuntimeConfig } from "./mesh.mjs";
import { LocalSqliteTransport } from "./transport-local-sqlite.mjs";

const { configPath, settings } = readAgentRelaySettings();
const dbPath = getDefaultDatabasePath();
const db = await openAgentRelayDatabase(dbPath);
const transport = new LocalSqliteTransport(db, dbPath);
const runtimeConfig = readRuntimeConfig(process.env, settings);

let runtime;
let session;

session = await joinSession({
    tools: createAgentRelayTools(() => runtime),
    commands: createAgentRelayCommands(
        () => runtime,
        () => session
    ),
    hooks: {
        onSessionStart: async (input) => {
            if (runtime) {
                await registerRuntime({ cwd: input.cwd });
            }
        },
        onUserPromptSubmitted: async (input) => {
            if (runtime) {
                await touchRuntime(input.cwd);
                runtime.markTurnRunning(input.timestamp);
            }
        },
    },
});

runtime = new AgentRelayRuntime({
    session,
    transport,
    cwd: process.cwd(),
    configPath,
    ...runtimeConfig,
});

await registerRuntime();
runtime.runStartupMaintenance();
runtime.start();

await session.log(`AgentRelay loaded. Mailbox: ${dbPath}. Config: ${configPath}`, { ephemeral: true });

session.on("assistant.turn_start", () => {
    runtime.markTurnRunning();
});

session.on("tool.execution_start", () => {
    runtime.markTurnRunning();
});

session.on("session.idle", () => {
    runtime.markTurnIdle();
});

session.on("session.shutdown", () => {
    runtime.stop("closed");
    transport.close();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        runtime?.stop("closed");
        transport.close();
        process.exit(0);
    });
}

async function registerRuntime(extra = {}) {
    runtime.register({
        ...extra,
        friendlyName: await getFriendlyNameForRegistration(),
    });
}

async function touchRuntime(cwd) {
    runtime.touch(cwd, {
        friendlyName: await getFriendlyNameForRegistration(),
    });
}

async function getFriendlyNameForRegistration() {
    try {
        return await runtime.getFriendlyName();
    } catch (error) {
        await session.log(`AgentRelay could not read Copilot CLI session name: ${formatError(error)}`, {
            level: "warning",
        });
        return undefined;
    }
}

function formatError(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}
