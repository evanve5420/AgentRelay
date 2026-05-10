import { joinSession } from "@github/copilot-sdk/extension";
import { getDefaultDatabasePath, openAgentRelayDatabase } from "./db.mjs";
import { AgentRelayRuntime, createAgentRelayTools, readRuntimeConfig } from "./mesh.mjs";
import { LocalSqliteTransport } from "./transport-local-sqlite.mjs";

const dbPath = getDefaultDatabasePath();
const db = await openAgentRelayDatabase(dbPath);
const transport = new LocalSqliteTransport(db, dbPath);
const runtimeConfig = readRuntimeConfig();

let runtime;

const session = await joinSession({
    tools: createAgentRelayTools(() => runtime),
    hooks: {
        onSessionStart: async (input) => {
            if (runtime) {
                runtime.updateCwd(input.cwd);
                runtime.register();
            }
        },
        onUserPromptSubmitted: async (input) => {
            if (runtime) {
                runtime.touch(input.cwd);
                runtime.markTurnRunning(input.timestamp);
            }
        },
    },
});

runtime = new AgentRelayRuntime({
    session,
    transport,
    cwd: process.cwd(),
    ...runtimeConfig,
});

runtime.register();
runtime.runStartupMaintenance();
runtime.start();

await session.log(`AgentRelay loaded. Mailbox: ${dbPath}`, { ephemeral: true });

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
