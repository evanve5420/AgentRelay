import { getDefaultDatabasePath } from "./db.mjs";
import {
    DEFAULT_MESSAGE_LIMIT,
    DEFAULT_STALE_AFTER_MS,
    AmbiguousTargetError,
    UnknownTargetError,
    ValidationError,
    normalizeFriendlyName,
} from "./transport-local-sqlite.mjs";
import { createWorkContext } from "./work-context.mjs";

export const DEFAULT_POLL_INTERVAL_MS = 2500;
export const DEFAULT_RECENT_IDLE_POLL_INTERVAL_MS = 10000;
export const DEFAULT_IDLE_POLL_INTERVAL_MS = 30000;
export const DEFAULT_RECENT_IDLE_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_STARTUP_PRUNE_AFTER_DAYS = 30;

export class AgentRelayRuntime {
    constructor(options) {
        this.session = options.session;
        this.transport = options.transport;
        this.workContext = createWorkContext(options.cwd ?? process.cwd());
        this.cwd = this.workContext.cwd;
        this.activePollIntervalMs = parsePositiveInteger(
            options.activePollIntervalMs ?? options.pollIntervalMs,
            DEFAULT_POLL_INTERVAL_MS,
            250,
            60000
        );
        this.recentIdlePollIntervalMs = parsePositiveInteger(
            options.recentIdlePollIntervalMs,
            DEFAULT_RECENT_IDLE_POLL_INTERVAL_MS,
            1000,
            60000
        );
        this.idlePollIntervalMs = parsePositiveInteger(
            options.idlePollIntervalMs,
            DEFAULT_IDLE_POLL_INTERVAL_MS,
            1000,
            5 * 60 * 1000
        );
        this.recentIdleWindowMs = parsePositiveInteger(
            options.recentIdleWindowMs,
            DEFAULT_RECENT_IDLE_WINDOW_MS,
            1000,
            24 * 60 * 60 * 1000
        );
        this.staleAfterMs = parsePositiveInteger(
            options.staleAfterMs,
            DEFAULT_STALE_AFTER_MS,
            5000,
            24 * 60 * 60 * 1000
        );
        this.claimLimit = parsePositiveInteger(options.claimLimit, DEFAULT_MESSAGE_LIMIT, 1, 50);
        this.startupPruneAfterMs = daysToMs(options.startupPruneAfterDays ?? DEFAULT_STARTUP_PRUNE_AFTER_DAYS);
        this.configPath = options.configPath ?? null;
        this.timer = null;
        this.isPolling = false;
        this.isTurnRunning = false;
        this.lastIdleAt = normalizeNow(options.now);
        this.isStarted = false;
    }

    get sessionId() {
        return this.session.sessionId;
    }

    updateCwd(cwd) {
        if (!cwd) return;
        this.workContext = createWorkContext(cwd);
        this.cwd = this.workContext.cwd;
    }

    register(extra = {}) {
        if (extra.cwd) this.updateCwd(extra.cwd);
        return this.transport.registerSession({
            sessionId: this.sessionId,
            friendlyName: extra.friendlyName,
            cwd: this.workContext.cwd,
            repoRoot: this.workContext.repoRoot,
            repoName: this.workContext.repoName,
            workspacePath: this.session.workspacePath,
            pid: process.pid,
            now: extra.now,
        });
    }

    touch(cwd = this.cwd, extra = {}) {
        this.updateCwd(cwd);
        return this.transport.touchSession(this.sessionId, {
            friendlyName: extra.friendlyName,
            cwd: this.workContext.cwd,
            repoRoot: this.workContext.repoRoot,
            repoName: this.workContext.repoName,
            workspacePath: this.session.workspacePath,
            pid: process.pid,
        });
    }

    setAlias(alias) {
        return this.transport.setAlias(this.sessionId, alias, {
            cwd: this.workContext.cwd,
            repoRoot: this.workContext.repoRoot,
            repoName: this.workContext.repoName,
            workspacePath: this.session.workspacePath,
            pid: process.pid,
        });
    }

    async getFriendlyName() {
        const getName = this.session.rpc?.name?.get;
        if (typeof getName !== "function") return null;

        const result = await getName.call(this.session.rpc.name);
        return normalizeFriendlyName(result?.name);
    }

    sendMessage(target, message, options = {}) {
        const deliveryMode = typeof options === "string" ? options : options.deliveryMode ?? "queued";
        this.touch();
        return this.transport.enqueueMessages({
            senderSessionId: this.sessionId,
            target,
            body: message,
            deliveryMode,
            targetType: typeof options === "string" ? "auto" : options.targetType,
            allowMultiple: typeof options === "string" ? false : Boolean(options.sendToAll),
            includeSelf: typeof options === "string" ? false : Boolean(options.includeSelf),
            baseCwd: this.cwd,
            staleAfterMs: this.staleAfterMs,
        });
    }

    runStartupMaintenance(options = {}) {
        return this.transport.cleanup({
            now: options.now,
            staleAfterMs: this.staleAfterMs,
            deliveredOlderThanMs: this.startupPruneAfterMs,
            failedOlderThanMs: this.startupPruneAfterMs,
        });
    }

    describeSelf() {
        this.touch();
        return {
            ...this.transport.getSession(this.sessionId),
            databasePath: this.transport.dbPath ?? getDefaultDatabasePath(),
            configPath: this.configPath,
            pollIntervalMs: this.getCurrentPollInterval(),
            activePollIntervalMs: this.activePollIntervalMs,
            recentIdlePollIntervalMs: this.recentIdlePollIntervalMs,
            idlePollIntervalMs: this.idlePollIntervalMs,
            recentIdleWindowMs: this.recentIdleWindowMs,
            staleAfterMs: this.staleAfterMs,
            startupPruneAfterMs: this.startupPruneAfterMs,
        };
    }

    start() {
        if (this.isStarted) return;
        this.isStarted = true;
        this.scheduleNextPoll();
    }

    stop(status = "closed") {
        this.isStarted = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.transport.closeSession(this.sessionId, status);
    }

    markTurnRunning(now = Date.now()) {
        this.isTurnRunning = true;
        this.lastActivityAt = normalizeNow(now);
        this.reschedulePoll();
    }

    markTurnIdle(now = Date.now()) {
        this.isTurnRunning = false;
        this.lastIdleAt = normalizeNow(now);
        this.reschedulePoll();
    }

    getCurrentPollInterval(now = Date.now()) {
        if (this.isTurnRunning) return this.activePollIntervalMs;
        const idleForMs = normalizeNow(now) - this.lastIdleAt;
        if (idleForMs <= this.recentIdleWindowMs) return this.recentIdlePollIntervalMs;
        return this.idlePollIntervalMs;
    }

    reschedulePoll() {
        if (!this.isStarted) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.scheduleNextPoll();
    }

    scheduleNextPoll(delayMs = this.getCurrentPollInterval()) {
        if (!this.isStarted) return;
        this.timer = setTimeout(async () => {
            this.timer = null;
            try {
                await this.pollOnce();
            } catch (error) {
                this.lastPollError = error;
                if (this.session.log) {
                    await this.session
                        .log(`AgentRelay polling failed: ${formatError(error)}`, { level: "error" })
                        .catch(() => undefined);
                }
            } finally {
                this.scheduleNextPoll();
            }
        }, delayMs);
    }

    async pollOnce() {
        if (this.isPolling) return { skipped: true, delivered: 0, failed: 0 };

        this.isPolling = true;
        try {
            this.touch();
            const messages = this.transport.claimPendingMessages({
                sessionId: this.sessionId,
                limit: this.claimLimit,
            });

            let delivered = 0;
            let failed = 0;
            for (const message of messages) {
                const result = await this.deliverMessage(message);
                if (result.ok) delivered += 1;
                else failed += 1;
            }

            return { skipped: false, claimed: messages.length, delivered, failed };
        } finally {
            this.isPolling = false;
        }
    }

    async deliverMessage(message) {
        const prompt = formatRelayPrompt(message);
        try {
            const responseMessageId = await this.session.send({
                prompt,
                mode: toSessionSendMode(message.deliveryMode),
            });
            this.transport.markDelivered(message.id, this.sessionId, responseMessageId);
            return { ok: true, responseMessageId };
        } catch (error) {
            this.transport.markFailed(message.id, this.sessionId, error);
            if (this.session.log) {
                await this.session.log(`AgentRelay could not inject message ${message.id}: ${formatError(error)}`, {
                    level: "error",
                });
            }
            return { ok: false, error };
        }
    }
}

export function createAgentRelayTools(getRuntime) {
    return [
        {
            name: "agent_relay_whoami",
            description: "Shows this Copilot CLI session's AgentRelay identity, alias, cwd, and mailbox path.",
            parameters: emptySchema(),
            skipPermission: true,
            handler: () => formatWhoami(requireRuntime(getRuntime).describeSelf()),
        },
        {
            name: "agent_relay_set_alias",
            description: "Sets a short alias for this AgentRelay session so other sessions can address it.",
            parameters: {
                type: "object",
                properties: {
                    alias: {
                        type: "string",
                        description:
                            "Alias for this session. Use letters, numbers, dots, underscores, or dashes.",
                    },
                },
                required: ["alias"],
                additionalProperties: false,
            },
            skipPermission: true,
            handler: (args) => {
                const runtime = requireRuntime(getRuntime);
                const session = runtime.setAlias(args.alias);
                return `AgentRelay alias set to '${session.alias}' for session ${session.sessionId}.`;
            },
        },
        {
            name: "agent_relay_list_sessions",
            description: "Lists active or recent AgentRelay sessions on this machine.",
            parameters: {
                type: "object",
                properties: {
                    includeStale: {
                        type: "boolean",
                        description: "Include stale sessions in the result.",
                        default: false,
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum sessions to return.",
                        minimum: 1,
                        maximum: 100,
                        default: 25,
                    },
                },
                additionalProperties: false,
            },
            skipPermission: true,
            handler: (args = {}) => {
                const runtime = requireRuntime(getRuntime);
                runtime.touch();
                const sessions = runtime.transport.listSessions({
                    includeStale: Boolean(args.includeStale),
                    limit: args.limit ?? 25,
                    staleAfterMs: runtime.staleAfterMs,
                });
                return formatSessions(sessions);
            },
        },
        {
            name: "agent_relay_send_message",
            description: "Sends a message to another active AgentRelay session by alias or session ID.",
            parameters: {
                type: "object",
                properties: {
                    target: {
                        type: "string",
                        description:
                            "Target session ID, AgentRelay alias, Copilot CLI friendly session name, directory name/path, or repository name/path.",
                    },
                    message: {
                        type: "string",
                        description: "Message to send to the target session.",
                    },
                    deliveryMode: {
                        type: "string",
                        enum: ["queued", "immediate"],
                        description:
                            "How the target session should receive the message. 'queued' waits behind active work; 'immediate' attempts steering-style injection.",
                        default: "queued",
                    },
                    targetType: {
                        type: "string",
                        enum: ["auto", "session", "alias", "name", "directory", "repo"],
                        description:
                            "How to interpret target. 'auto' tries session ID, alias, Copilot CLI friendly name, directory, then repo.",
                        default: "auto",
                    },
                    sendToAll: {
                        type: "boolean",
                        description:
                            "When true, send to all matching sessions instead of failing on multiple matches.",
                        default: false,
                    },
                    includeSelf: {
                        type: "boolean",
                        description:
                            "When true with sendToAll, include the sending session if it also matches the target.",
                        default: false,
                    },
                },
                required: ["target", "message"],
                additionalProperties: false,
            },
            skipPermission: true,
            handler: (args) => {
                const runtime = requireRuntime(getRuntime);
                try {
                    const messages = runtime.sendMessage(args.target, args.message, {
                        deliveryMode: args.deliveryMode ?? "queued",
                        targetType: args.targetType ?? "auto",
                        sendToAll: Boolean(args.sendToAll),
                        includeSelf: Boolean(args.includeSelf),
                    });
                    return formatSendResult(messages);
                } catch (error) {
                    if (
                        error instanceof UnknownTargetError ||
                        error instanceof AmbiguousTargetError ||
                        error instanceof ValidationError
                    ) {
                        return {
                            resultType: "failure",
                            textResultForLlm: error.message,
                            error: error.message,
                        };
                    }
                    throw error;
                }
            },
        },
        {
            name: "agent_relay_read_messages",
            description: "Reads AgentRelay message history for this session without injecting messages.",
            parameters: {
                type: "object",
                properties: {
                    direction: {
                        type: "string",
                        enum: ["inbox", "sent", "all"],
                        description: "Which messages to read.",
                        default: "inbox",
                    },
                    status: {
                        type: "string",
                        enum: ["pending", "claimed", "delivered", "failed"],
                        description: "Optional status filter.",
                    },
                    limit: {
                        type: "integer",
                        minimum: 1,
                        maximum: 100,
                        default: 20,
                    },
                },
                additionalProperties: false,
            },
            skipPermission: true,
            handler: (args = {}) => {
                const runtime = requireRuntime(getRuntime);
                runtime.touch();
                const messages = runtime.transport.listMessages({
                    sessionId: runtime.sessionId,
                    direction: args.direction ?? "inbox",
                    status: args.status,
                    limit: args.limit ?? 20,
                });
                return formatMessages(messages);
            },
        },
    ];
}

export function createAgentRelayCommands(getRuntime, getSession) {
    return [
        {
            name: "agent-relay-sessions",
            description: "Show local AgentRelay sessions that can receive messages.",
            handler: async () => {
                const runtime = requireRuntime(getRuntime);
                runtime.touch();
                const sessions = runtime.transport.listSessions({
                    includeStale: false,
                    limit: 25,
                    staleAfterMs: runtime.staleAfterMs,
                });
                await logCommandResult(getSession, formatSessions(sessions));
            },
        },
        {
            name: "agent-relay-whoami",
            description: "Show this session's AgentRelay identity.",
            handler: async () => {
                const runtime = requireRuntime(getRuntime);
                await logCommandResult(getSession, formatWhoami(runtime.describeSelf()));
            },
        },
        {
            name: "agent-relay-alias",
            description: "Set this session's AgentRelay alias. Usage: /agent-relay-alias <alias>",
            handler: async (context) => {
                const alias = String(context?.args ?? "").trim();
                if (!alias) {
                    await logCommandResult(getSession, "Usage: /agent-relay-alias <alias>");
                    return;
                }

                const runtime = requireRuntime(getRuntime);
                try {
                    const session = runtime.setAlias(alias);
                    await logCommandResult(
                        getSession,
                        `AgentRelay alias set to '${session.alias}' for session ${session.sessionId}.`
                    );
                } catch (error) {
                    if (error instanceof ValidationError) {
                        await logCommandResult(getSession, error.message, { level: "error" });
                        return;
                    }
                    throw error;
                }
            },
        },
    ];
}

export function readRuntimeConfig(env = process.env, settings = {}) {
    return {
        pollIntervalMs: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_POLL_MS, settings.pollIntervalMs),
            DEFAULT_POLL_INTERVAL_MS,
            250,
            60000
        ),
        activePollIntervalMs: parsePositiveInteger(
            firstConfigValue(
                env.AGENT_RELAY_ACTIVE_POLL_MS,
                env.AGENT_RELAY_POLL_MS,
                settings.activePollIntervalMs,
                settings.pollIntervalMs
            ),
            DEFAULT_POLL_INTERVAL_MS,
            250,
            60000
        ),
        recentIdlePollIntervalMs: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_RECENT_IDLE_POLL_MS, settings.recentIdlePollIntervalMs),
            DEFAULT_RECENT_IDLE_POLL_INTERVAL_MS,
            1000,
            60000
        ),
        idlePollIntervalMs: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_IDLE_POLL_MS, settings.idlePollIntervalMs),
            DEFAULT_IDLE_POLL_INTERVAL_MS,
            1000,
            5 * 60 * 1000
        ),
        recentIdleWindowMs: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_RECENT_IDLE_WINDOW_MS, settings.recentIdleWindowMs),
            DEFAULT_RECENT_IDLE_WINDOW_MS,
            1000,
            24 * 60 * 60 * 1000
        ),
        staleAfterMs: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_STALE_MS, settings.staleAfterMs),
            DEFAULT_STALE_AFTER_MS,
            5000,
            24 * 60 * 60 * 1000
        ),
        claimLimit: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_CLAIM_LIMIT, settings.claimLimit),
            DEFAULT_MESSAGE_LIMIT,
            1,
            50
        ),
        startupPruneAfterDays: parsePositiveInteger(
            firstConfigValue(env.AGENT_RELAY_PRUNE_DAYS, settings.startupPruneAfterDays),
            DEFAULT_STARTUP_PRUNE_AFTER_DAYS,
            1,
            365
        ),
    };
}

export function formatRelayPrompt(message) {
    const sender = message.senderAlias
        ? `${message.senderAlias} (${message.senderSessionId})`
        : message.senderSessionId;
    const replyTarget = message.senderAlias ?? message.senderSessionId;
    const replyTargetType = message.senderAlias ? "alias" : "session";
    return [
        "You received an AgentRelay message from another local Copilot CLI session.",
        "",
        `From: ${sender}`,
        `Message ID: ${message.id}`,
        `Sent at: ${new Date(message.createdAt).toISOString()}`,
        "",
        "Reply guidance:",
        "If a reply is needed, do not just write the reply in this chat.",
        `Use agent_relay_send_message with target: ${JSON.stringify(replyTarget)}, targetType: ${JSON.stringify(
            replyTargetType
        )}, and message set to your response.`,
        "If no reply is needed, continue with the requested work normally.",
        "",
        "Message:",
        message.body,
    ].join("\n");
}

function requireRuntime(getRuntime) {
    const runtime = getRuntime();
    if (!runtime) throw new Error("AgentRelay runtime is not initialized yet.");
    return runtime;
}

function emptySchema() {
    return {
        type: "object",
        properties: {},
        additionalProperties: false,
    };
}

function formatWhoami(info) {
    return [
        "AgentRelay session",
        `- Session ID: ${info.sessionId}`,
        `- Alias: ${info.alias ?? "(not set)"}`,
        `- Copilot CLI name: ${info.friendlyName ?? "(not set)"}`,
        `- Repo: ${info.repoName ?? "(none)"}`,
        `- Repo root: ${info.repoRoot ?? "(none)"}`,
        `- Status: ${info.status}`,
        `- CWD: ${info.cwd ?? "(unknown)"}`,
        `- Workspace: ${info.workspacePath ?? "(none)"}`,
        `- Database: ${info.databasePath}`,
        `- Config: ${info.configPath ?? "(none)"}`,
        `- Current poll interval: ${info.pollIntervalMs} ms`,
        `- Active poll interval: ${info.activePollIntervalMs} ms`,
        `- Recent-idle poll interval: ${info.recentIdlePollIntervalMs} ms`,
        `- Long-idle poll interval: ${info.idlePollIntervalMs} ms`,
        `- Recent-idle window: ${info.recentIdleWindowMs} ms`,
        `- Stale after: ${info.staleAfterMs} ms`,
        `- Startup prune after: ${Math.round(info.startupPruneAfterMs / (24 * 60 * 60 * 1000))} days`,
    ].join("\n");
}

function formatSessions(sessions) {
    if (sessions.length === 0) return "No AgentRelay sessions found.";
    const lines = [
        "| Alias | Copilot CLI name | Repo | Status | Session ID | Last seen | CWD |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const session of sessions) {
        lines.push(
            `| ${escapeCell(session.alias ?? "")} | ${escapeCell(session.friendlyName ?? "")} | ${escapeCell(
                session.repoName ?? ""
            )} | ${escapeCell(session.status)} | ${escapeCell(session.sessionId)} | ${escapeCell(
                new Date(session.lastSeenAt).toISOString()
            )} | ${escapeCell(session.cwd ?? "")} |`
        );
    }
    return lines.join("\n");
}

async function logCommandResult(getSession, text, options = {}) {
    const session = getSession();
    if (!session?.log) throw new Error("AgentRelay slash commands require session.log support.");
    await session.log(text, options);
}

function formatMessages(messages) {
    if (messages.length === 0) return "No AgentRelay messages found.";
    const lines = [
        "| ID | Status | Delivery | From | To | Created | Body |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const message of messages) {
        lines.push(
            `| ${message.id} | ${escapeCell(message.status)} | ${escapeCell(message.deliveryMode)} | ${escapeCell(
                message.senderAlias ?? message.senderSessionId
            )} | ${escapeCell(message.targetAlias ?? message.targetSessionId)} | ${escapeCell(
                new Date(message.createdAt).toISOString()
            )} | ${escapeCell(truncate(message.body, 120))} |`
        );
    }
    return lines.join("\n");
}

function formatTarget(message) {
    return message.targetAlias ? `${message.targetAlias} (${message.targetSessionId})` : message.targetSessionId;
}

function formatSendResult(messages) {
    if (messages.length === 1) {
        const message = messages[0];
        return `Queued AgentRelay message ${message.id} for ${formatTarget(message)} with ${message.deliveryMode} delivery.`;
    }
    return [
        `Queued ${messages.length} AgentRelay messages:`,
        ...messages.map((message) => `- ${message.id}: ${formatTarget(message)} (${message.deliveryMode})`),
    ].join("\n");
}

function parsePositiveInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function firstConfigValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        if (typeof value === "string" && value.trim() === "") continue;
        return value;
    }
    return undefined;
}

function normalizeNow(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : Date.now();
}

function daysToMs(days) {
    return parsePositiveInteger(days, 7, 1, 365) * 24 * 60 * 60 * 1000;
}

function toSessionSendMode(deliveryMode) {
    return deliveryMode === "immediate" ? "immediate" : "enqueue";
}

function escapeCell(value) {
    return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function truncate(value, maxLength) {
    const text = String(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
