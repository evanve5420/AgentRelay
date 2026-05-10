import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG_FILE_NAME = "agent-relay.json";

export function getDefaultConfigPath(env = process.env) {
    const override = env.AGENT_RELAY_CONFIG?.trim();
    if (override) return override;

    const copilotConfigDir = env.COPILOT_CONFIG_DIR?.trim() || join(homedir(), ".copilot");
    return join(copilotConfigDir, DEFAULT_CONFIG_FILE_NAME);
}

export function readAgentRelaySettings(env = process.env) {
    const configPath = getDefaultConfigPath(env);
    if (!existsSync(configPath)) return { configPath, settings: {} };

    let raw;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return { configPath, settings: {} };
        throw new Error(`Failed to read AgentRelay config at ${configPath}: ${formatError(error)}`);
    }

    const trimmed = raw.trim();
    if (!trimmed) return { configPath, settings: {} };

    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Failed to parse AgentRelay config at ${configPath}: ${formatError(error)}`);
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error(`AgentRelay config at ${configPath} must be a JSON object.`);
    }

    return { configPath, settings: parsed };
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
