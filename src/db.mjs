import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 3;

export function getDefaultDatabasePath(env = process.env) {
    const override = env.AGENT_RELAY_DB?.trim();
    if (override) return override;

    const baseDir =
        env.LOCALAPPDATA ||
        env.XDG_DATA_HOME ||
        (process.platform === "win32"
            ? join(homedir(), "AppData", "Local")
            : join(homedir(), ".local", "share"));

    return join(baseDir, "AgentRelay", "agent-relay.sqlite");
}

export async function openAgentRelayDatabase(dbPath = getDefaultDatabasePath(), options = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    configureDatabase(db, options);
    migrateDatabase(db);
    return db;
}

export function configureDatabase(db, options = {}) {
    const busyTimeoutMs = clampInteger(options.busyTimeoutMs, 1, 60000, 5000);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    db.exec("PRAGMA foreign_keys = ON;");
}

export function migrateDatabase(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            alias TEXT,
            cwd TEXT,
            repo_root TEXT,
            repo_name TEXT,
            workspace_path TEXT,
            pid INTEGER,
            transport TEXT NOT NULL DEFAULT 'local-sqlite',
            account_hint TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_alias ON sessions(alias);
        CREATE INDEX IF NOT EXISTS idx_sessions_status_last_seen ON sessions(status, last_seen_at);

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_session_id TEXT NOT NULL,
            sender_alias TEXT,
            target_session_id TEXT NOT NULL,
            target_alias TEXT,
            body TEXT NOT NULL,
            delivery_mode TEXT NOT NULL DEFAULT 'queued',
            status TEXT NOT NULL DEFAULT 'pending',
            claimed_by_session_id TEXT,
            response_message_id TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            claimed_at INTEGER,
            delivered_at INTEGER,
            failed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_messages_target_status_created
            ON messages(target_session_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_sender_created
            ON messages(sender_session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_status_updated
            ON messages(status, updated_at);
    `);

    addColumnIfMissing(db, "sessions", "repo_root", "TEXT");
    addColumnIfMissing(db, "sessions", "repo_name", "TEXT");
    addColumnIfMissing(db, "messages", "delivery_mode", "TEXT NOT NULL DEFAULT 'queued'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_repo_name ON sessions(repo_name);");

    db.prepare(`
        INSERT INTO metadata (key, value)
        VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
}

function addColumnIfMissing(db, table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

export function runExclusive(db, callback) {
    db.exec("BEGIN IMMEDIATE;");
    try {
        const result = callback();
        db.exec("COMMIT;");
        return result;
    } catch (error) {
        try {
            db.exec("ROLLBACK;");
        } catch (rollbackError) {
            if (error instanceof Error) {
                error.rollbackError = rollbackError;
            }
        }
        throw error;
    }
}

export function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}
