import { clampInteger, getDefaultDatabasePath, openAgentRelayDatabase, runExclusive } from "./db.mjs";
import { basenameKey, isPathLike, nameKey, pathKey } from "./work-context.mjs";

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_MESSAGE_LIMIT = 20;
export const MAX_MESSAGE_LENGTH = 20000;

const MESSAGE_STATUSES = new Set(["pending", "claimed", "delivered", "failed"]);
const MESSAGE_DIRECTIONS = new Set(["inbox", "sent", "all"]);
const DELIVERY_MODES = new Set(["queued", "immediate"]);
const TARGET_TYPES = new Set(["auto", "session", "alias", "directory", "repo"]);

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
        const repoRoot = nullableString(session.repoRoot);
        const repoName = nullableString(session.repoName);
        const workspacePath = nullableString(session.workspacePath);
        const pid = Number.isInteger(session.pid) ? session.pid : process.pid;
        const transport = nullableString(session.transport) ?? "local-sqlite";
        const accountHint = nullableString(session.accountHint);

        this.db.prepare(`
            INSERT INTO sessions (
                session_id, alias, cwd, repo_root, repo_name, workspace_path, pid, transport, account_hint,
                status, created_at, updated_at, last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                alias = COALESCE(excluded.alias, sessions.alias),
                cwd = excluded.cwd,
                repo_root = excluded.repo_root,
                repo_name = excluded.repo_name,
                workspace_path = excluded.workspace_path,
                pid = excluded.pid,
                transport = excluded.transport,
                account_hint = excluded.account_hint,
                status = 'active',
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at
        `).run(sessionId, alias, cwd, repoRoot, repoName, workspacePath, pid, transport, accountHint, now, now, now);

        return this.getSession(sessionId);
    }

    touchSession(sessionId, updates = {}) {
        const now = normalizeTimestamp(updates.now);
        const cwd = updates.cwd === undefined ? undefined : nullableString(updates.cwd);
        const repoRoot = updates.repoRoot === undefined ? undefined : nullableString(updates.repoRoot);
        const repoName = updates.repoName === undefined ? undefined : nullableString(updates.repoName);
        const workspacePath =
            updates.workspacePath === undefined ? undefined : nullableString(updates.workspacePath);
        const session = this.getSession(sessionId);
        if (!session) {
            return this.registerSession({
                sessionId,
                cwd,
                repoRoot,
                repoName,
                workspacePath,
                pid: updates.pid,
                now,
            });
        }

        this.db.prepare(`
            UPDATE sessions
            SET cwd = COALESCE(?, cwd),
                repo_root = COALESCE(?, repo_root),
                repo_name = COALESCE(?, repo_name),
                workspace_path = COALESCE(?, workspace_path),
                pid = COALESCE(?, pid),
                status = 'active',
                updated_at = ?,
                last_seen_at = ?
            WHERE session_id = ?
        `).run(cwd, repoRoot, repoName, workspacePath, Number.isInteger(updates.pid) ? updates.pid : null, now, now, sessionId);

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
                repoRoot: details.repoRoot,
                repoName: details.repoName,
                workspacePath: details.workspacePath,
                pid: details.pid,
                now: details.now,
            });
        }

        const now = normalizeTimestamp(details.now);
        this.db.prepare(`
            UPDATE sessions
            SET alias = ?,
                cwd = COALESCE(?, cwd),
                repo_root = COALESCE(?, repo_root),
                repo_name = COALESCE(?, repo_name),
                workspace_path = COALESCE(?, workspace_path),
                pid = COALESCE(?, pid),
                status = 'active',
                updated_at = ?,
                last_seen_at = ?
            WHERE session_id = ?
        `).run(
            normalizedAlias,
            nullableString(details.cwd),
            nullableString(details.repoRoot),
            nullableString(details.repoName),
            nullableString(details.workspacePath),
            Number.isInteger(details.pid) ? details.pid : null,
            now,
            now,
            normalizeSessionId(sessionId)
        );

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
                  .prepare("SELECT * FROM sessions ORDER BY last_seen_at DESC, session_id ASC LIMIT ?")
                  .all(limit)
            : this.db
                  .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_seen_at DESC, session_id ASC LIMIT ?")
                  .all(limit);

        return rows.map(mapSession);
    }

    resolveTarget(target, options = {}) {
        const matches = this.resolveTargets(target, { ...options, allowMultiple: false });
        return matches[0];
    }

    resolveTargets(target, options = {}) {
        const value = String(target ?? "").trim();
        if (!value) throw new ValidationError("Target alias or session ID is required.");

        const now = normalizeTimestamp(options.now);
        const staleAfterMs = normalizeDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
        const targetType = normalizeTargetType(options.targetType);
        const allowMultiple = Boolean(options.allowMultiple);
        this.expireStaleSessions({ now, staleAfterMs });

        let matches = [];
        let matchedBy = targetType;

        if (targetType === "session" || targetType === "auto") {
            const direct = this.getSession(value);
            if (direct) {
                if (direct.status !== "active") {
                    throw new UnknownTargetError(`Session '${value}' exists but is not active.`);
                }
                matches = [direct];
                matchedBy = "session";
            }
        }

        if (matches.length === 0 && (targetType === "alias" || targetType === "auto")) {
            matches = this.findAliasTargets(value);
            matchedBy = "alias";
        }

        if (matches.length === 0 && (targetType === "directory" || targetType === "auto")) {
            matches = this.findDirectoryTargets(value, options);
            matchedBy = "directory";
        }

        if (matches.length === 0 && (targetType === "repo" || targetType === "auto")) {
            matches = this.findRepoTargets(value, options);
            matchedBy = "repo";
        }

        matches = uniqueSessions(matches);
        if (options.includeSelf !== true && options.senderSessionId && allowMultiple && matchedBy !== "session") {
            matches = matches.filter((session) => session.sessionId !== options.senderSessionId);
        }

        if (matches.length === 0) {
            throw new UnknownTargetError(`No active AgentRelay session found for '${value}'.`);
        }

        if (matches.length > 1 && !allowMultiple) {
            const sessionIds = matches.map((session) => session.sessionId).join(", ");
            throw new AmbiguousTargetError(
                `Target '${value}' matched multiple active ${matchedBy} sessions: ${sessionIds}. Set sendToAll=true or use a session ID.`
            );
        }

        return matches;
    }

    findAliasTargets(value) {
        let alias;
        try {
            alias = normalizeAlias(value);
        } catch {
            return [];
        }
        return this.db
            .prepare(`
                SELECT *
                FROM sessions
                WHERE alias = ? AND status = 'active'
                ORDER BY last_seen_at DESC
            `)
            .all(alias)
            .map(mapSession);
    }

    findDirectoryTargets(value, options = {}) {
        const sessions = this.listSessions({ includeStale: false, limit: 200, now: options.now, staleAfterMs: options.staleAfterMs });
        const baseCwd = options.baseCwd ?? process.cwd();
        if (isPathLike(value)) {
            const targetPath = pathKey(value, baseCwd);
            return sessions.filter((session) =>
                [session.cwd, session.repoRoot].some((candidate) => candidate && pathKey(candidate, baseCwd) === targetPath)
            );
        }

        const targetName = nameKey(value);
        return sessions.filter((session) =>
            [basenameKey(session.cwd), basenameKey(session.repoRoot), nameKey(session.repoName)].some(
                (candidate) => candidate === targetName
            )
        );
    }

    findRepoTargets(value, options = {}) {
        const sessions = this.listSessions({ includeStale: false, limit: 200, now: options.now, staleAfterMs: options.staleAfterMs });
        const baseCwd = options.baseCwd ?? process.cwd();
        if (isPathLike(value)) {
            const targetPath = pathKey(value, baseCwd);
            return sessions.filter((session) =>
                [session.repoRoot, session.cwd].some((candidate) => candidate && pathKey(candidate, baseCwd) === targetPath)
            );
        }

        const targetName = nameKey(value);
        return sessions.filter((session) =>
            [nameKey(session.repoName), basenameKey(session.repoRoot), basenameKey(session.cwd)].some(
                (candidate) => candidate === targetName
            )
        );
    }

    enqueueMessage(input) {
        const messages = this.enqueueMessages({ ...input, allowMultiple: false });
        return messages[0];
    }

    enqueueMessages(input) {
        const now = normalizeTimestamp(input.now);
        const senderSessionId = normalizeSessionId(input.senderSessionId);
        const body = normalizeMessageBody(input.body);
        const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
        const targets = this.resolveTargets(input.target, {
            now,
            staleAfterMs: input.staleAfterMs,
            targetType: input.targetType,
            allowMultiple: input.allowMultiple,
            includeSelf: input.includeSelf,
            senderSessionId,
            baseCwd: input.baseCwd,
        });
        const sender = this.getSession(senderSessionId);
        const senderAlias = sender?.alias ?? null;
        const insert = this.db.prepare(`
            INSERT INTO messages (
                sender_session_id, sender_alias, target_session_id, target_alias, body, delivery_mode,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `);

        return runExclusive(this.db, () =>
            targets.map((target) => {
                const result = insert.run(senderSessionId, senderAlias, target.sessionId, target.alias, body, deliveryMode, now, now);
                return this.getMessage(Number(result.lastInsertRowid));
            })
        );
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

export function normalizeTargetType(type) {
    const normalized = String(type ?? "auto").trim().toLowerCase();
    if (!TARGET_TYPES.has(normalized)) {
        throw new ValidationError("Target type must be 'auto', 'session', 'alias', 'directory', or 'repo'.");
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
        repoRoot: row.repo_root,
        repoName: row.repo_name,
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

function uniqueSessions(sessions) {
    const seen = new Set();
    const unique = [];
    for (const session of sessions) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        unique.push(session);
    }
    return unique;
}
