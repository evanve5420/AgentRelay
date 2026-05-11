import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getDefaultConfigPath, readAgentRelaySettings } from "../src/config.mjs";
import { openAgentRelayDatabase } from "../src/db.mjs";
import { AgentRelayRuntime, createAgentRelayTools, formatRelayPrompt, readRuntimeConfig } from "../src/mesh.mjs";
import { LocalSqliteTransport } from "../src/transport-local-sqlite.mjs";

class FakeSession {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.workspacePath = `C:\\sessions\\${sessionId}`;
        this.sent = [];
        this.logs = [];
    }

    async send(options) {
        this.sent.push(options);
        return `response-${this.sent.length}`;
    }

    async log(message, options = {}) {
        this.logs.push({ message, options });
    }
}

async function withRuntime(callback) {
    const dir = await mkdtemp(join(tmpdir(), "agent-relay-runtime-"));
    const dbPath = join(dir, "agent-relay.sqlite");
    const db = await openAgentRelayDatabase(dbPath);
    const transport = new LocalSqliteTransport(db, dbPath);
    try {
        await callback(transport);
    } finally {
        transport.close();
        await rm(dir, { recursive: true, force: true });
    }
}

test("formats relay prompts with sender metadata and body", () => {
    const prompt = formatRelayPrompt({
        id: 7,
        senderSessionId: "sender-session",
        senderAlias: "sender",
        body: "Please inspect the failing test.",
        createdAt: 1700000000000,
    });

    assert.match(prompt, /AgentRelay message/);
    assert.match(prompt, /sender \(sender-session\)/);
    assert.match(prompt, /Reply guidance:/);
    assert.match(prompt, /agent_relay_send_message/);
    assert.match(prompt, /target: "sender"/);
    assert.match(prompt, /targetType: "alias"/);
    assert.match(prompt, /Please inspect the failing test\./);
});

test("formats relay prompts with session ID reply target when sender has no alias", () => {
    const prompt = formatRelayPrompt({
        id: 8,
        senderSessionId: "sender-session",
        senderAlias: null,
        body: "Status?",
        createdAt: 1700000000000,
    });

    assert.match(prompt, /target: "sender-session"/);
    assert.match(prompt, /targetType: "session"/);
});

test("pollOnce injects claimed messages and marks them delivered", async () => {
    await withRuntime(async (transport) => {
        transport.registerSession({ sessionId: "sender", alias: "sender", now: 1000 });
        transport.registerSession({ sessionId: "target", alias: "target", now: 1000 });
        const queued = transport.enqueueMessage({
            senderSessionId: "sender",
            target: "target",
            body: "Can you check this repo?",
            now: 1100,
        });

        const fakeSession = new FakeSession("target");
        const runtime = new AgentRelayRuntime({
            session: fakeSession,
            transport,
            cwd: "C:\\workspace\\target",
            pollIntervalMs: 1000,
        });

        const result = await runtime.pollOnce();

        assert.equal(result.claimed, 1);
        assert.equal(result.delivered, 1);
        assert.equal(fakeSession.sent.length, 1);
        assert.equal(fakeSession.sent[0].mode, "enqueue");
        assert.match(fakeSession.sent[0].prompt, /Can you check this repo\?/);

        const delivered = transport.getMessage(queued.id);
        assert.equal(delivered.status, "delivered");
        assert.equal(delivered.responseMessageId, "response-1");
    });
});

test("pollOnce uses immediate mode for immediate delivery messages", async () => {
    await withRuntime(async (transport) => {
        transport.registerSession({ sessionId: "sender", alias: "sender", now: 1000 });
        transport.registerSession({ sessionId: "target", alias: "target", now: 1000 });
        transport.enqueueMessage({
            senderSessionId: "sender",
            target: "target",
            body: "Please steer the current run.",
            deliveryMode: "immediate",
            now: 1100,
        });

        const fakeSession = new FakeSession("target");
        const runtime = new AgentRelayRuntime({
            session: fakeSession,
            transport,
            cwd: "C:\\workspace\\target",
            pollIntervalMs: 1000,
        });

        await runtime.pollOnce();

        assert.equal(fakeSession.sent.length, 1);
        assert.equal(fakeSession.sent[0].mode, "immediate");
    });
});

test("uses adaptive poll intervals for running, recent-idle, and long-idle states", async () => {
    await withRuntime(async (transport) => {
        const fakeSession = new FakeSession("target");
        const runtime = new AgentRelayRuntime({
            session: fakeSession,
            transport,
            cwd: "C:\\workspace\\target",
            activePollIntervalMs: 2500,
            recentIdlePollIntervalMs: 10000,
            idlePollIntervalMs: 30000,
            recentIdleWindowMs: 15 * 60 * 1000,
            now: 1000,
        });

        assert.equal(runtime.getCurrentPollInterval(1000), 10000);
        runtime.markTurnRunning(2000);
        assert.equal(runtime.getCurrentPollInterval(2000), 2500);
        runtime.markTurnIdle(3000);
        assert.equal(runtime.getCurrentPollInterval(3000 + 15 * 60 * 1000), 10000);
        assert.equal(runtime.getCurrentPollInterval(3000 + 15 * 60 * 1000 + 1), 30000);
    });
});

test("readRuntimeConfig supports adaptive polling environment overrides", () => {
    const config = readRuntimeConfig({
        AGENT_RELAY_ACTIVE_POLL_MS: "3000",
        AGENT_RELAY_RECENT_IDLE_POLL_MS: "11000",
        AGENT_RELAY_IDLE_POLL_MS: "31000",
        AGENT_RELAY_RECENT_IDLE_WINDOW_MS: "600000",
    });

    assert.equal(config.activePollIntervalMs, 3000);
    assert.equal(config.recentIdlePollIntervalMs, 11000);
    assert.equal(config.idlePollIntervalMs, 31000);
    assert.equal(config.recentIdleWindowMs, 600000);
});

test("legacy AGENT_RELAY_POLL_MS configures active polling", () => {
    const config = readRuntimeConfig({
        AGENT_RELAY_POLL_MS: "3500",
    });

    assert.equal(config.activePollIntervalMs, 3500);
});

test("reads AgentRelay settings from a configured JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-relay-config-"));
    try {
        const configPath = join(dir, "settings.json");
        await writeFile(configPath, JSON.stringify({ activePollIntervalMs: 2750 }), "utf8");

        const result = readAgentRelaySettings({ AGENT_RELAY_CONFIG: configPath });

        assert.equal(result.configPath, configPath);
        assert.equal(result.settings.activePollIntervalMs, 2750);
        assert.equal(getDefaultConfigPath({ COPILOT_CONFIG_DIR: dir }), join(dir, "agent-relay.json"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("readRuntimeConfig uses settings file values and lets environment variables win", () => {
    const config = readRuntimeConfig(
        {
            AGENT_RELAY_ACTIVE_POLL_MS: "4500",
        },
        {
            activePollIntervalMs: 3000,
            recentIdlePollIntervalMs: 12000,
            idlePollIntervalMs: 45000,
            recentIdleWindowMs: 600000,
        }
    );

    assert.equal(config.activePollIntervalMs, 4500);
    assert.equal(config.recentIdlePollIntervalMs, 12000);
    assert.equal(config.idlePollIntervalMs, 45000);
    assert.equal(config.recentIdleWindowMs, 600000);
});

test("pollOnce marks failed messages when session.send fails", async () => {
    await withRuntime(async (transport) => {
        transport.registerSession({ sessionId: "sender", alias: "sender", now: 1000 });
        transport.registerSession({ sessionId: "target", alias: "target", now: 1000 });
        const queued = transport.enqueueMessage({
            senderSessionId: "sender",
            target: "target",
            body: "This will fail.",
            now: 1100,
        });

        const fakeSession = new FakeSession("target");
        fakeSession.send = async () => {
            throw new Error("send failed");
        };

        const runtime = new AgentRelayRuntime({
            session: fakeSession,
            transport,
            cwd: "C:\\workspace\\target",
            pollIntervalMs: 1000,
        });

        const result = await runtime.pollOnce();

        assert.equal(result.failed, 1);
        const failed = transport.getMessage(queued.id);
        assert.equal(failed.status, "failed");
        assert.match(failed.error, /send failed/);
        assert.equal(fakeSession.logs.length, 1);
    });
});

test("send tool can target all sessions in a repository", async () => {
    await withRuntime(async (transport) => {
        const now = Date.now();
        transport.registerSession({
            sessionId: "sender",
            alias: "sender",
            cwd: "C:\\workspace\\sender",
            repoRoot: "C:\\workspace\\sender",
            repoName: "sender",
            now,
        });
        transport.registerSession({
            sessionId: "repo-one",
            cwd: "C:\\workspace\\mobile-app\\one",
            repoRoot: "C:\\workspace\\mobile-app",
            repoName: "mobile-app",
            now,
        });
        transport.registerSession({
            sessionId: "repo-two",
            cwd: "C:\\workspace\\mobile-app\\two",
            repoRoot: "C:\\workspace\\mobile-app",
            repoName: "mobile-app",
            now,
        });

        const fakeSession = new FakeSession("sender");
        const runtime = new AgentRelayRuntime({
            session: fakeSession,
            transport,
            cwd: "C:\\workspace\\sender",
        });
        const sendTool = createAgentRelayTools(() => runtime).find((tool) => tool.name === "agent_relay_send_message");

        const result = sendTool.handler({
            target: "mobile-app",
            targetType: "repo",
            sendToAll: true,
            message: "Please coordinate on the mobile work.",
        });

        assert.match(result, /Queued 2 AgentRelay messages/);
        const messages = transport.listMessages({ sessionId: "repo-one", direction: "inbox" });
        assert.equal(messages.length, 1);
        assert.equal(messages[0].body, "Please coordinate on the mobile work.");
    });
});

test("startup maintenance prunes old delivered and failed messages without exposing a cleanup tool", async () => {
    await withRuntime(async (transport) => {
        transport.registerSession({ sessionId: "sender", alias: "sender", now: 1000 });
        transport.registerSession({ sessionId: "target", alias: "target", now: 1000 });

        const delivered = transport.enqueueMessage({
            senderSessionId: "sender",
            target: "target",
            body: "old delivered",
            now: 1000,
        });
        transport.claimPendingMessages({ sessionId: "target", now: 1100 });
        transport.markDelivered(delivered.id, "target", "response-1", 1200);

        const failed = transport.enqueueMessage({
            senderSessionId: "sender",
            target: "target",
            body: "old failed",
            now: 1300,
        });
        transport.claimPendingMessages({ sessionId: "target", now: 1400 });
        transport.markFailed(failed.id, "target", new Error("old failure"), 1500);

        const fakeSession = new FakeSession("target");
        const runtime = new AgentRelayRuntime({
            session: fakeSession,
            transport,
            cwd: "C:\\workspace\\target",
            startupPruneAfterDays: 1,
        });

        const result = runtime.runStartupMaintenance({
            now: 3 * 24 * 60 * 60 * 1000,
        });

        assert.equal(result.deletedDeliveredMessages, 1);
        assert.equal(result.deletedFailedMessages, 1);

        const tools = createAgentRelayTools(() => runtime).map((tool) => tool.name);
        assert.equal(tools.includes("agent_relay_cleanup"), false);
    });
});
