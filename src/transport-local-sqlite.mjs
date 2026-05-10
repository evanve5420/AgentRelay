import { clampInteger, getDefaultDatabasePath, openAgentRelayDatabase, runExclusive } from "./db.mjs";

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_MESSAGE_LIMIT = 20;
export const MAX_MESSAGE_LENGTH = 20000;

const MESSAGE_STATUSES = new Set(["pending", "claimed", "delivered", "failed"]);
const MESSAGE_DIRECTIONS = new Set(["inbox", "sent", "all"]);
const DELIVERY_MODES = new Set(["queued", "immediate"]);

export class AgentRelayError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}

export class ValidationError extends AgentRelayError {}
export class UnknownTargetError extends AgentRelayError {}
export class AmbiguousTargetError extends AgentRelayError {}
export class InvalidMessageStateError extends AgentRelayError {}

export async function createLocalSqliteTransport(options = {}) {
    const dbPath = options.dbPath ?? getDefaultDatabasePath();
    const db = await openAgentRelayDatabase(dbPath, options);
    return new LocalSqliteTransport(db, dbPath);
}

export class LocalSqliteTransport {
    constructor(db, dbPath = undefined) {
        this.db = db;
        this.dbPath = dbPath;
        this.closed = false;
    }

    close() {
        if (this.closed) return;
        this.db.close();
        this.closed = true;
    }

    registerSession(session) {
        const now = normalizeTimestamp(session.now);
        const sessionId = normalizeSessionId(session.sessionId);
        const alias = session.alias === undefined ? null : normalizeAlias(session.alias);
        const cwd = nullableString(session.cwd);
        const workspacePath = nullableString(session.workspacePath);
        const pid = Number.isInteger(session.pid) ? session.pid : process.pid;
        const transport = nullableString(session.transport) ?? "local-sqlite";
        const accountHint = nullableString(session.accountHint);

        this.db.prepare(`
            INSERT INTO sessions (
                session_id, alias, cwd, workspace_path, pid, transport, account_hint,
                status, created_at, updated_at, last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                alias = COALESCE(excluded.alias, sessions.alias),
                cwd = excluded.cwd,
                workspace_path = excluded.workspace_path,
                pid = excluded.pid,
                transport = excluded.transport,
                account_hint = excluded.account_hint,
                status = 'active',
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at
        `).run(sessionId, alias, cwd, workspacePath, pid, transport, accountHint, now, now, now);

        return this.getSession(sessionId);
    }

    touchSession(sessionId, updates = {}) {
        const now = normalizeTimestamp(updates.now);
        const cwd = updates.cwd === undefined ? undefined : nullableString(updates.cwd);
        const workspacePath =
            updates.workspacePath === undefined ? undefined : nullableString(updates.workspacePath);
        const session = this.getSession(sessionId);
        if (!session) {
            return this.registerSession({
                sessionId,
                cwd,
                workspacePath,
                pid: updates.pid,
                now,
            });
        }

        this.db.prepare(`
            UPDATE sessions
            SET cwd = COALESCE(?, cwd),
                workspace_path = COALESCE(?, workspace_path),
                pid = COALESCE(?, pid),
                status = 'active',
                updated_at = ?,
                last_seen_at = ?
            WHERE session_id = ?
        `).run(cwd, workspacePath, Number.isInteger(updates.pid) ? updates.pid : null, now, now, sessionId);

        return this.getSession(sessionId);
    }

    closeSession(sessionId, status = "closed", now = Date.now()) {
        this.db.prepare(`
            UPDATE sessions
            SET status = ?, updated_at = ?
            WHERE session_id = ?
        `).run(status, normalizeTimestamp(now), normalizeSessionId(sessionId));
    }

    setAlias(sessionId, alias, details = {}) {
        const normalizedAlias = normalizeAlias(alias);
        const existing = this.getSession(sessionId);
        if (!existing) {
            return this.registerSession({
                sessionId,
                alias: normalizedAlias,
                cwd: details.cwd,
                workspacePath: details.workspacePath,
                pid: details.pid,
                now: details.now,
            });
        }

        const now = normalizeTimestamp(details.now);
        this.db.prepare(`
            UPDATE sessions
            SET alias = ?, status = 'active', updated_at = ?, last_seen_at = ?
            WHERE session_id = ?
        `).run(normalizedAlias, now, now, normalizeSessionId(sessionId));

        return this.getSession(sessionId);
    }

    getSession(sessionId) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE session_id = ?")
            .get(normalizeSessionId(sessionId));
        return row ? mapSession(row) : null;
    }

    expireStaleSessions(options = {}) {
        const now = normalizeTimestamp(options.now);
        const staleAfterMs = normalizeDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
        const cutoff = now - staleAfterMs;
        const result = this.db.prepare(`
            UPDATE sessions
            SET status = 'stale', updated_at = ?
            WHERE status = 'active' AND last_seen_at < ?
        `).run(now, cutoff);
        return result.changes;
    }

    listSessions(options = {}) {
        const now = normalizeTimestamp(options.now);
        const staleAfterMs = normalizeDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
        const limit = normalizeLimit(options.limit, 50);
        this.expireStaleSessions({ now, staleAfterMs });

        const rows = options.includeStale
            ? this.db
                  .prepare("SELECT * FROM sessions ORDER BY last_seen_at DESC LIMIT ?")
                  .all(limit)
            : this.db
                  .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_seen_at DESC LIMIT ?")
                  .all(limit);

        return rows.map(mapSession);
    }

    resolveTarget(target, options = {}) {
        const value = String(target ?? "").trim();
        if (!value) throw new ValidationError("Target alias or session ID is required.");

        const now = normalizeTimestamp(options.now);
        const staleAfterMs = normalizeDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
        this.expireStaleSessions({ now, staleAfterMs });

        const direct = this.getSession(value);
        if (direct) {
            if (direct.status !== "active") {
                throw new UnknownTargetError(`Session '${value}' exists but is not active.`);
            }
            return direct;
        }

        const alias = normalizeAlias(value);
        const rows = this.db
            .prepare(`
                SELECT *
                FROM sessions
                WHERE alias = ? AND status = 'active'
                ORDER BY last_seen_at DESC
            `)
            .all(alias);

        if (rows.length === 0) {
            throw new UnknownTargetError(`No active AgentRelay session found for '${value}'.`);
        }
        if (rows.length > 1) {
            const sessionIds = rows.map((row) => row.session_id).join(", ");
            throw new AmbiguousTargetError(
                `Alias '${alias}' matches multiple active sessions: ${sessionIds}. Use a session ID.`
            );
        }

        return mapSession(rows[0]);
    }

    enqueueMessage(input) {
        const now = normalizeTimestamp(input.now);
        const senderSessionId = normalizeSessionId(input.senderSessionId);
        const body = normalizeMessageBody(input.body);
        const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
        const target = this.resolveTarget(input.target, {
            now,
            staleAfterMs: input.staleAfterMs,
        });
        const sender = this.getSession(senderSessionId);
        const senderAlias = sender?.alias ?? null;

        const result = this.db.prepare(`
            INSERT INTO messages (
                sender_session_id, sender_alias, target_session_id, target_alias, body, delivery_mode,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(senderSessionId, senderAlias, target.sessionId, target.alias, body, deliveryMode, now, now);

        return this.getMessage(Number(result.lastInsertRowid));
    }

    getMessage(id) {
        const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(normalizeId(id));
        return row ? mapMessage(row) : null;
    }

    claimPendingMessages(options) {
        const sessionId = normalizeSessionId(options.sessionId);
        const now = normalizeTimestamp(options.now);
        const limit = normalizeLimit(options.limit, DEFAULT_MESSAGE_LIMIT);

        return runExclusive(this.db, () => {
            const pendingRows = this.db
                .prepare(`
                    SELECT id
                    FROM messages
                    WHERE target_session_id = ? AND status = 'pending'
                    ORDER BY created_at ASC, id ASC
                    LIMIT ?
                `)
                .all(sessionId, limit);

            if (pendingRows.length === 0) return [];

            const ids = pendingRows.map((row) => row.id);
            const placeholders = ids.map(() => "?").join(", ");
            this.db.prepare(`
                UPDATE messages
                SET status = 'claimed',
                    claimed_by_session_id = ?,
                    claimed_at = ?,
                    updated_at = ?
                WHERE target_session_id = ?
                    AND status = 'pending'
                    AND id IN (${placeholders})
            `).run(sessionId, now, now, sessionId, ...ids);

            return this.db.prepare(`
                SELECT *
                FROM messages
                WHERE claimed_by_session_id = ?
                    AND status = 'claimed'
                    AND id IN (${placeholders})
                ORDER BY created_at ASC, id ASC
            `).all(sessionId, ...ids).map(mapMessage);
        });
    }

    markDelivered(id, sessionId, responseMessageId, now = Date.now()) {
        const result = this.db.prepare(`
            UPDATE messages
            SET status = 'delivered',
                response_message_id = ?,
                delivered_at = ?,
                updated_at = ?,
                error = NULL
            WHERE id = ?
                AND claimed_by_session_id = ?
                AND status = 'claimed'
        `).run(nullableString(responseMessageId), normalizeTimestamp(now), normalizeTimestamp(now), normalizeId(id), normalizeSessionId(sessionId));

        if (result.changes !== 1) {
            throw new InvalidMessageStateError(`Message ${id} is not claimed by session ${sessionId}.`);
        }
        return this.getMessage(id);
    }

    markFailed(id, sessionId, error, now = Date.now()) {
        const result = this.db.prepare(`
            UPDATE messages
            SET status = 'failed',
                failed_at = ?,
                updated_at = ?,
                error = ?
            WHERE id = ?
                AND claimed_by_session_id = ?
                AND status = 'claimed'
        `).run(normalizeTimestamp(now), normalizeTimestamp(now), stringifyError(error), normalizeId(id), normalizeSessionId(sessionId));

        if (result.changes !== 1) {
            throw new InvalidMessageStateError(`Message ${id} is not claimed by session ${sessionId}.`);
        }
        return this.getMessage(id);
    }

    listMessages(options) {
        const sessionId = normalizeSessionId(options.sessionId);
        const direction = options.direction ?? "inbox";
        if (!MESSAGE_DIRECTIONS.has(direction)) {
            throw new ValidationError(`Invalid message direction '${direction}'.`);
        }

        const status = options.status ?? null;
        if (status !== null && !MESSAGE_STATUSES.has(status)) {
            throw new ValidationError(`Invalid message status '${status}'.`);
        }

        const limit = normalizeLimit(options.limit, DEFAULT_MESSAGE_LIMIT);
        const where = [];
        const params = [];

        if (direction === "inbox") {
            where.push("target_session_id = ?");
            params.push(sessionId);
        } else if (direction === "sent") {
            where.push("sender_session_id = ?");
            params.push(sessionId);
        } else {
            where.push("(target_session_id = ? OR sender_session_id = ?)");
            params.push(sessionId, sessionId);
        }

        if (status) {
            where.push("status = ?");
            params.push(status);
        }

        return this.db.prepare(`
            SELECT *
            FROM messages
            WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        `).all(...params, limit).map(mapMessage);
    }

    cleanup(options = {}) {
        const now = normalizeTimestamp(options.now);
        const staleAfterMs = normalizeDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
        const deliveredOlderThanMs = normalizeDuration(options.deliveredOlderThanMs, 7 * 24 * 60 * 60 * 1000);
        const failedOlderThanMs = normalizeDuration(options.failedOlderThanMs, 7 * 24 * 60 * 60 * 1000);

        const staleSessions = this.expireStaleSessions({ now, staleAfterMs });
        const delivered = this.db.prepare(`
            DELETE FROM messages
            WHERE status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < ?
        `).run(now - deliveredOlderThanMs).changes;
        const failed = this.db.prepare(`
            DELETE FROM messages
            WHERE status = 'failed' AND failed_at IS NOT NULL AND failed_at < ?
        `).run(now - failedOlderThanMs).changes;

        return { staleSessions, deletedDeliveredMessages: delivered, deletedFailedMessages: failed };
    }
}

export function normalizeAlias(alias) {
    const normalized = String(alias ?? "").trim().toLowerCase();
    if (!normalized) throw new ValidationError("Alias is required.");
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(normalized)) {
        throw new ValidationError(
            "Alias must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes."
        );
    }
    return normalized;
}

function normalizeSessionId(sessionId) {
    const value = String(sessionId ?? "").trim();
    if (!value) throw new ValidationError("Session ID is required.");
    return value;
}

function normalizeMessageBody(body) {
    const value = String(body ?? "").trim();
    if (!value) throw new ValidationError("Message body is required.");
    if (value.length > MAX_MESSAGE_LENGTH) {
        throw new ValidationError(`Message body must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
    }
    return value;
}

export function normalizeDeliveryMode(mode) {
    const normalized = String(mode ?? "queued").trim().toLowerCase();
    if (!DELIVERY_MODES.has(normalized)) {
        throw new ValidationError("Delivery mode must be 'queued' or 'immediate'.");
    }
    return normalized;
}

function normalizeTimestamp(value) {
    if (value === undefined || value === null) return Date.now();
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new ValidationError("Timestamp must be a non-negative number.");
    }
    return Math.trunc(timestamp);
}

function normalizeDuration(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return clampInteger(value, 1, Number.MAX_SAFE_INTEGER, fallback);
}

function normalizeLimit(value, fallback) {
    return clampInteger(value ?? fallback, 1, 200, fallback);
}

function normalizeId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Message ID must be a positive integer.");
    return id;
}

function nullableString(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text.length === 0 ? null : text;
}

function stringifyError(error) {
    if (error instanceof Error) return error.stack || error.message;
    return String(error);
}

function mapSession(row) {
    return {
        sessionId: row.session_id,
        alias: row.alias,
        cwd: row.cwd,
        workspacePath: row.workspace_path,
        pid: row.pid,
        transport: row.transport,
        accountHint: row.account_hint,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
    };
}

function mapMessage(row) {
    return {
        id: row.id,
        senderSessionId: row.sender_session_id,
        senderAlias: row.sender_alias,
        targetSessionId: row.target_session_id,
        targetAlias: row.target_alias,
        body: row.body,
        deliveryMode: row.delivery_mode ?? "queued",
        status: row.status,
        claimedBySessionId: row.claimed_by_session_id,
        responseMessageId: row.response_message_id,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        claimedAt: row.claimed_at,
        deliveredAt: row.delivered_at,
        failedAt: row.failed_at,
    };
}
