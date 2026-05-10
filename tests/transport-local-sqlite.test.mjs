import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateDatabase, openAgentRelayDatabase } from "../src/db.mjs";
import {
    AmbiguousTargetError,
    LocalSqliteTransport,
    UnknownTargetError,
} from "../src/transport-local-sqlite.mjs";

async function withTransport(callback) {
    const dir = await mkdtemp(join(tmpdir(), "agent-relay-"));
    const dbPath = join(dir, "agent-relay.sqlite");
    const db = await openAgentRelayDatabase(dbPath);
    const transport = new LocalSqliteTransport(db, dbPath);
    try {
        await callback(transport, dbPath);
    } finally {
        transport.close();
        await rm(dir, { recursive: true, force: true });
    }
}

test("registers sessions, enqueues, claims, and delivers a message once", async () => {
    await withTransport((transport) => {
        transport.registerSession({ sessionId: "sender", alias: "source", cwd: "C:\\src\\a", now: 1000 });
        transport.registerSession({ sessionId: "target", alias: "dest", cwd: "C:\\src\\b", now: 1000 });

        const queued = transport.enqueueMessage({
            senderSessionId: "sender",
            target: "dest",
            body: "hello from another session",
            now: 1100,
        });

        assert.equal(queued.status, "pending");
        assert.equal(queued.deliveryMode, "queued");
        assert.equal(queued.targetSessionId, "target");

        const claimed = transport.claimPendingMessages({ sessionId: "target", now: 1200 });
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].id, queued.id);

        const secondClaim = transport.claimPendingMessages({ sessionId: "target", now: 1300 });
        assert.deepEqual(secondClaim, []);

        const delivered = transport.markDelivered(queued.id, "target", "assistant-message-1", 1400);
        assert.equal(delivered.status, "delivered");
        assert.equal(delivered.responseMessageId, "assistant-message-1");

        const inbox = transport.listMessages({ sessionId: "target", direction: "inbox", status: "delivered" });
        assert.equal(inbox.length, 1);
        assert.equal(inbox[0].body, "hello from another session");
    });
});

test("persists immediate delivery mode", async () => {
    await withTransport((transport) => {
        transport.registerSession({ sessionId: "sender", alias: "source", now: 1000 });
        transport.registerSession({ sessionId: "target", alias: "dest", now: 1000 });

        const queued = transport.enqueueMessage({
            senderSessionId: "sender",
            target: "dest",
            body: "steer now",
            deliveryMode: "immediate",
            now: 1100,
        });

        assert.equal(queued.deliveryMode, "immediate");
        const [claimed] = transport.claimPendingMessages({ sessionId: "target", now: 1200 });
        assert.equal(claimed.deliveryMode, "immediate");
    });
});

test("rejects unknown and ambiguous aliases", async () => {
    await withTransport((transport) => {
        transport.registerSession({ sessionId: "one", alias: "shared", now: 1000 });
        transport.registerSession({ sessionId: "two", alias: "shared", now: 1000 });

        assert.throws(() => transport.resolveTarget("shared", { now: 1100 }), AmbiguousTargetError);
        assert.throws(() => transport.resolveTarget("missing", { now: 1100 }), UnknownTargetError);
    });
});

test("ignores stale aliases when resolving targets", async () => {
    await withTransport((transport) => {
        transport.registerSession({ sessionId: "old", alias: "worker", now: 1000 });
        transport.registerSession({ sessionId: "fresh", alias: "worker", now: 10000 });

        const resolved = transport.resolveTarget("worker", { now: 10000, staleAfterMs: 5000 });
        assert.equal(resolved.sessionId, "fresh");
    });
});

test("resolves sessions by directory name and repository name", async () => {
    await withTransport((transport) => {
        transport.registerSession({
            sessionId: "devcron",
            alias: "worker",
            cwd: "C:\\src\\DevCronAgents",
            repoRoot: "C:\\src\\DevCronAgents",
            repoName: "DevCronAgents",
            now: 1000,
        });
        transport.registerSession({
            sessionId: "android-one",
            cwd: "C:\\src\\xplat-Android-MDM\\app",
            repoRoot: "C:\\src\\xplat-Android-MDM",
            repoName: "xplat-Android-MDM",
            now: 1000,
        });
        transport.registerSession({
            sessionId: "android-two",
            cwd: "C:\\src\\xplat-Android-MDM\\service",
            repoRoot: "C:\\src\\xplat-Android-MDM",
            repoName: "xplat-Android-MDM",
            now: 1000,
        });

        const [directoryTarget] = transport.resolveTargets("DevCronAgents", {
            targetType: "directory",
            now: 1100,
        });
        assert.equal(directoryTarget.sessionId, "devcron");

        const repoTargets = transport.resolveTargets("xplat-Android-MDM", {
            targetType: "repo",
            allowMultiple: true,
            now: 1100,
        });
        assert.deepEqual(repoTargets.map((session) => session.sessionId).sort(), ["android-one", "android-two"]);
    });
});

test("enqueues to all matching repository sessions when requested", async () => {
    await withTransport((transport) => {
        transport.registerSession({ sessionId: "sender", alias: "sender", cwd: "C:\\src", now: 1000 });
        transport.registerSession({
            sessionId: "one",
            cwd: "C:\\src\\repo\\one",
            repoRoot: "C:\\src\\repo",
            repoName: "repo",
            now: 1000,
        });
        transport.registerSession({
            sessionId: "two",
            cwd: "C:\\src\\repo\\two",
            repoRoot: "C:\\src\\repo",
            repoName: "repo",
            now: 1000,
        });

        assert.throws(
            () =>
                transport.enqueueMessages({
                    senderSessionId: "sender",
                    target: "repo",
                    targetType: "repo",
                    body: "ambiguous unless all",
                    now: 1100,
                }),
            AmbiguousTargetError
        );

        const messages = transport.enqueueMessages({
            senderSessionId: "sender",
            target: "repo",
            targetType: "repo",
            allowMultiple: true,
            body: "all repo agents",
            now: 1100,
        });

        assert.equal(messages.length, 2);
        assert.deepEqual(messages.map((message) => message.targetSessionId).sort(), ["one", "two"]);
    });
});

test("prevents duplicate claims across two database connections", async () => {
    await withTransport(async (first, dbPath) => {
        const secondDb = await openAgentRelayDatabase(dbPath);
        const second = new LocalSqliteTransport(secondDb, dbPath);
        try {
            first.registerSession({ sessionId: "sender", alias: "sender", now: 1000 });
            first.registerSession({ sessionId: "target", alias: "target", now: 1000 });
            first.enqueueMessage({ senderSessionId: "sender", target: "target", body: "only once", now: 1100 });

            const firstClaim = first.claimPendingMessages({ sessionId: "target", now: 1200 });
            const secondClaim = second.claimPendingMessages({ sessionId: "target", now: 1200 });

            assert.equal(firstClaim.length, 1);
            assert.equal(secondClaim.length, 0);
        } finally {
            second.close();
        }
    });
});

test("migrates existing databases before creating repo indexes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-relay-old-schema-"));
    const dbPath = join(dir, "agent-relay.sqlite");
    const db = await openAgentRelayDatabase(dbPath);
    try {
        db.exec("DROP INDEX IF EXISTS idx_sessions_repo_name;");
        db.exec("CREATE TABLE old_sessions AS SELECT session_id, alias, cwd, workspace_path, pid, transport, account_hint, status, created_at, updated_at, last_seen_at FROM sessions;");
        db.exec("DROP TABLE sessions;");
        db.exec("ALTER TABLE old_sessions RENAME TO sessions;");

        migrateDatabase(db);
        const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
        assert.equal(columns.includes("repo_root"), true);
        assert.equal(columns.includes("repo_name"), true);

        db.prepare("INSERT INTO sessions (session_id, cwd, repo_name, status, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
            .run("session", "C:\\src\\repo", "repo", 1000, 1000, 1000);
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
