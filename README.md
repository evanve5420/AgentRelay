# AgentRelay

AgentRelay is a daemon-free Copilot CLI extension that lets local Copilot CLI sessions message each other across repositories on the same machine.

The v0 design is intentionally local-only: every participating session loads a user-scoped extension, registers itself in a shared SQLite mailbox, polls for messages addressed to its session ID or alias, and injects delivered messages with `session.send()`.

## Requirements

- Copilot CLI with extension support, experimental mode enabled, and an active Copilot subscription.
- Node.js 24 or newer. AgentRelay uses the built-in `node:sqlite` module. `npm` is bundled with normal Node.js installs and is used only for the test/update scripts.
- Windows PowerShell 6 or newer for the install, update, and uninstall scripts.
- Git, if using the update script to pull newer versions from the repository.

## Quick handoff checklist

1. Install Copilot CLI and sign in.
2. Enable experimental mode by launching with `copilot --experimental` or using `/experimental` inside Copilot CLI. The setting is persisted after it is enabled.
3. Install Node.js 24 or newer. A normal Node.js install includes `npm`.
4. Clone or copy this repository.
5. From the repository root, run:

```powershell
npm test
npm run install:extension
```

6. Reload Copilot CLI extensions by starting a new session, using `/clear`, or asking a session with tool access to call `extensions_reload`.
7. On first launch in a directory, approve AgentRelay's extension permission prompt. Choose the "always allow" option if you want Copilot CLI to remember that decision for that directory.

## Extension runtime note

Copilot CLI currently requires extension entry points to be JavaScript ES modules named `extension.mjs`. The `.mjs` extension means "ECMAScript module"; it lets Node load the file with ESM `import` syntax instead of CommonJS `require`.

The extension entry point must be `.mjs`, but it can hand work to other languages. For example, a tool handler can call PowerShell, a native executable, Python, or an HTTP service with Node's child-process or fetch APIs.

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

There is no build step or package restore. The installer validates the required `.mjs` files, copies them into the Copilot extensions directory, and writes `installed-from.txt` for troubleshooting.

Manual copy should produce this flat layout:

```text
%USERPROFILE%\.copilot\extensions\AgentRelay\
  extension.mjs
  config.mjs
  db.mjs
  mesh.mjs
  transport-local-sqlite.mjs
  work-context.mjs
```

Copilot CLI discovers the extension from `extension.mjs`; AgentRelay does not install npm dependencies in the extension directory.

If the extension is not discovered after copying those files, first confirm Copilot CLI experimental mode is enabled. Without experimental mode, Copilot CLI may ignore user extensions even when the files are in the correct directory.

If the extension is discovered but fails at runtime, check `node --version`. AgentRelay is tested and supported on Node.js 24+ because it depends on the built-in `node:sqlite` module.

## Update locally

If this repository was cloned with Git:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update-user-extension.ps1
```

The update script runs `git pull --ff-only`, runs `npm test`, then runs the install script. If you already updated the repository manually, use `-SkipPull`. If you need to reinstall without running tests, use `-SkipTests`.

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
| `agent_relay_whoami` | Show this session's AgentRelay identity, alias, Copilot CLI friendly name, repo, cwd, workspace, and database path. |
| `agent_relay_set_alias` | Set a short alias for the current session. |
| `agent_relay_list_sessions` | List active or recent local sessions, including Copilot CLI friendly name, repo, and cwd. |
| `agent_relay_send_message` | Send a message by session ID, alias, Copilot CLI friendly name, directory, or repo. Defaults to queued delivery and can request immediate delivery. |
| `agent_relay_read_messages` | Read this session's AgentRelay message history without injecting messages. |

AgentRelay also registers these Copilot CLI slash commands when the host TUI supports extension commands:

| Slash command | Purpose |
| --- | --- |
| `/agent-relay-sessions` | Show active local AgentRelay sessions directly in the timeline. |
| `/agent-relay-whoami` | Show this session's AgentRelay identity directly in the timeline. |
| `/agent-relay-alias <alias>` | Set this session's AgentRelay alias without asking the agent to call a tool. |

Example flow:

1. In each participating Copilot CLI session, ask it to call `agent_relay_set_alias` with a memorable alias like `api` or `frontend`.
2. Ask one session to call `agent_relay_list_sessions`.
3. Ask one session to call `agent_relay_send_message` with a target, message, and optional routing options.
4. The target session polls the mailbox, claims the pending message, and receives it as a prompt.
5. Delivered prompts include reply guidance telling the receiving agent which `agent_relay_send_message` target and `targetType` to use if a response is needed.

`agent_relay_send_message` supports these routing options:

| Option | Values | Purpose |
| --- | --- | --- |
| `target` | string | Session ID, AgentRelay alias, Copilot CLI friendly session name, directory name/path, or repository name/path. |
| `targetType` | `auto`, `session`, `alias`, `name`, `directory`, `repo` | How to interpret `target`. `auto` tries session ID, AgentRelay alias, Copilot CLI friendly name, directory, then repo. |
| `sendToAll` | boolean | Send to every matching session instead of failing on multiple matches. Useful for "all agents working in this repo." |
| `includeSelf` | boolean | Include the sending session when `sendToAll` is used. Defaults to false. |

Examples:

- "Tell the agent working on the `scheduler-service` directory to rerun the scheduler tests" -> use `target: "scheduler-service"`, `targetType: "directory"`.
- "Tell all agents working in `mobile-app` repo to sync on auth changes" -> use `target: "mobile-app"`, `targetType: "repo"`, `sendToAll: true`.
- "Tell the session renamed to `frontend review` to check the UI" -> use `target: "frontend review"`, `targetType: "name"`.

`agent_relay_send_message` supports these delivery modes:

| Mode | SDK send mode | Use when |
| --- | --- | --- |
| `queued` | `enqueue` | Default. The target should handle the message after earlier queued work. |
| `immediate` | `immediate` | The message is intended as steering for the currently active target session. It is still picked up by AgentRelay's local poller first. |

## Runtime settings

AgentRelay reads optional settings from:

```text
%USERPROFILE%\.copilot\agent-relay.json
```

If `COPILOT_CONFIG_DIR` is set, AgentRelay looks there instead. Set `AGENT_RELAY_CONFIG` to point at a different JSON file. Environment variables override file settings.

Example:

```json
{
  "activePollIntervalMs": 2500,
  "recentIdlePollIntervalMs": 10000,
  "recentIdleWindowMs": 900000,
  "idlePollIntervalMs": 30000
}
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RELAY_DB` | `%LOCALAPPDATA%\AgentRelay\agent-relay.sqlite` | SQLite mailbox path. |
| `AGENT_RELAY_CONFIG` | `%USERPROFILE%\.copilot\agent-relay.json` | Optional JSON settings file path. |
| `AGENT_RELAY_ACTIVE_POLL_MS` | `2500` | Poll interval while a target session turn appears to be running. Legacy `AGENT_RELAY_POLL_MS` also sets this value. |
| `AGENT_RELAY_RECENT_IDLE_POLL_MS` | `10000` | Poll interval for the first recent-idle window after a turn finishes. |
| `AGENT_RELAY_RECENT_IDLE_WINDOW_MS` | `900000` | Recent-idle window after `session.idle`; defaults to 15 minutes. |
| `AGENT_RELAY_IDLE_POLL_MS` | `30000` | Poll interval after the recent-idle window expires. |
| `AGENT_RELAY_STALE_MS` | `300000` | Last-seen age before a session is considered stale. |
| `AGENT_RELAY_CLAIM_LIMIT` | `20` | Maximum pending messages claimed per poll. |
| `AGENT_RELAY_PRUNE_DAYS` | `30` | Delivered and failed messages older than this are pruned on extension startup. |

Polling is adaptive: AgentRelay polls every 2.5 seconds while a turn is running, every 10 seconds for 15 minutes after the session becomes idle, then every 30 seconds after that.

```text
          active turn                       recent idle window                 long idle
    |----------------------|------------------------------------------------|------------->
    turn starts/runs       session.idle                                     idle + 15 min
        poll 2.5s              poll 10s                                         poll 30s
```

AgentRelay does not expose a cleanup tool. On extension startup or reload, it marks stale sessions and prunes delivered or failed messages older than `AGENT_RELAY_PRUNE_DAYS`.

## Current limitations

- v0 only routes messages between sessions on the same machine.
- Existing Copilot CLI sessions must reload extensions or restart before they participate.
- Aliases are not globally reserved. If multiple active sessions use the same alias, sending by alias fails and asks for a session ID.
- Copilot CLI friendly names are not globally reserved and can be long, duplicated, mutable, or fallback summaries. If multiple active sessions use the same friendly name, sending by name fails clearly unless `sendToAll` is set.
- AgentRelay aliases remain the recommended short, stable override when friendly names are ambiguous or inconvenient.
- `node:sqlite` is currently experimental in Node.js, so Node may emit an experimental warning.
