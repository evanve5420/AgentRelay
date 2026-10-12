# AGENTS.md


## Agent configuration

Canonical agent configuration lives in `.agents/skills/` (skills) and `AGENTS.md` (instructions). MCP servers are managed user-wide in `~/.agents/mcp-servers.json`. Tool-specific paths (`.claude/skills`, `.github/skills`, `.github/copilot-instructions.md`) are relative symlinks committed to git, and `CLAUDE.md` imports `AGENTS.md`; always edit the canonical copy. On a machine without symlink support (Windows without Developer Mode), run `scripts/link-agents.ps1` after cloning.

