# AgentRelay

AgentRelay is a daemon-free Copilot CLI extension that lets local Copilot CLI sessions message each other across repositories on the same machine.

The v0 design is intentionally local-only: every participating session loads a user-scoped extension, registers itself in a shared SQLite mailbox, polls for messages addressed to its session ID or alias, and injects delivered messages with `session.send()`.

## Requirements

- Copilot CLI with extension support.
- Node.js 24 or newer for the built-in `node:sqlite` module.
- Windows PowerShell for the install scripts.

## Install locally

From this repository:

```powershell
npm test
powershell -ExecutionPolicy Bypass -File .\scripts\install-user-extension.ps1
```

Then reload Copilot CLI extensions by starting a new session, using `/clear`, or asking a session with tool access to call `extensions_reload`.

The installer copies the extension files to:

```text
%USERPROFILE%\.copilot\extensions\AgentRelay
```

If `COPILOT_CONFIG_DIR` is set, the installer uses that directory instead of `%USERPROFILE%\.copilot`.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-user-extension.ps1
```

## Mailbox location

By default, AgentRelay stores its mailbox at:

```text
%LOCALAPPDATA%\AgentRelay\agent-relay.sqlite
```

Set `AGENT_RELAY_DB` to override this path for testing or development.

## Tools

AgentRelay registers these Copilot CLI extension tools:

| Tool | Purpose |
| --- | --- |
| `agent_relay_whoami` | Show this session's AgentRelay identity, alias, cwd, workspace, and database path. |
| `agent_relay_set_alias` | Set a short alias for the current session. |
| `agent_relay_list_sessions` | List active or recent local sessions. |
| `agent_relay_send_message` | Send a message for another session by alias or session ID. Defaults to queued delivery and can request immediate delivery. |
| `agent_relay_read_messages` | Read this session's AgentRelay message history without injecting messages. |

Example flow:

1. In each participating Copilot CLI session, ask it to call `agent_relay_set_alias` with a memorable alias like `api` or `frontend`.
2. Ask one session to call `agent_relay_list_sessions`.
3. Ask one session to call `agent_relay_send_message` with a target alias, message, and optional `deliveryMode`.
4. The target session polls the mailbox, claims the pending message, and receives it as a prompt.

`agent_relay_send_message` supports these delivery modes:

| Mode | SDK send mode | Use when |
| --- | --- | --- |
| `queued` | `enqueue` | Default. The target should handle the message after earlier queued work. |
| `immediate` | `immediate` | The message is intended as steering for the currently active target session. It is still picked up by AgentRelay's local poller first. |

## Runtime settings

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RELAY_DB` | `%LOCALAPPDATA%\AgentRelay\agent-relay.sqlite` | SQLite mailbox path. |
| `AGENT_RELAY_ACTIVE_POLL_MS` | `2500` | Poll interval while a target session turn appears to be running. Legacy `AGENT_RELAY_POLL_MS` also sets this value. |
| `AGENT_RELAY_RECENT_IDLE_POLL_MS` | `10000` | Poll interval for the first recent-idle window after a turn finishes. |
| `AGENT_RELAY_RECENT_IDLE_WINDOW_MS` | `900000` | Recent-idle window after `session.idle`; defaults to 15 minutes. |
| `AGENT_RELAY_IDLE_POLL_MS` | `30000` | Poll interval after the recent-idle window expires. |
| `AGENT_RELAY_STALE_MS` | `300000` | Last-seen age before a session is considered stale. |
| `AGENT_RELAY_CLAIM_LIMIT` | `20` | Maximum pending messages claimed per poll. |
| `AGENT_RELAY_PRUNE_DAYS` | `30` | Delivered and failed messages older than this are pruned on extension startup. |

Polling is adaptive: AgentRelay polls every 2.5 seconds while a turn is running, every 10 seconds for 15 minutes after the session becomes idle, then every 30 seconds after that.

AgentRelay does not expose a cleanup tool. On extension startup or reload, it marks stale sessions and prunes delivered or failed messages older than `AGENT_RELAY_PRUNE_DAYS`.

## Sharing with coworkers

AgentRelay has no npm dependencies and does not require a broker service. A coworker can clone or copy the repository, run the install script, and reload Copilot CLI extensions.

The local SQLite transport is isolated behind a small storage boundary so a future transport can route to other machines under the same GitHub account without rewriting the extension tools or delivery loop.

## Current limitations

- v0 only routes messages between sessions on the same machine.
- Existing Copilot CLI sessions must reload extensions or restart before they participate.
- Aliases are not globally reserved. If multiple active sessions use the same alias, sending by alias fails and asks for a session ID.
- Copilot CLI session names are evolving. AgentRelay currently routes by session ID or alias; CLI-friendly-name routing can be added once the name exposed by the SDK is stable enough for addressing.
- `node:sqlite` is currently experimental in Node.js, so Node may emit an experimental warning.
