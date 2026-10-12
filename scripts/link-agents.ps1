# Idempotent per-repo setup: canonical .agents/skills + AGENTS.md, with tool-specific paths as links.
# Run from anywhere: pwsh scripts/link-agents.ps1   (repo root = parent of this script's folder, or -Root)
# Preferred: relative symlinks, committed to git (needs Developer Mode on Windows + core.symlinks=true).
# Fallback when symlinks are unavailable: dirs -> junctions, copilot-instructions.md -> hard link, marked
# skip-worktree so git does not see the swap. CLAUDE.md is always a plain "@AGENTS.md" import.
param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
$canon = Join-Path $Root '.agents\skills'
New-Item -ItemType Directory $canon -Force | Out-Null
$isGit = Test-Path (Join-Path $Root '.git')

# Can this machine/user create symlinks?
$probe = Join-Path $env:TEMP "symprobe_$PID"
$canSym = $false
try { cmd /c mklink "$probe" "$env:ComSpec" 2>&1 | Out-Null; $canSym = Test-Path $probe } finally { if (Test-Path $probe) { Remove-Item $probe -Force } }
if ($canSym -and $isGit) { git -C $Root config core.symlinks true }

function Remove-Link($p) {
  $i = Get-Item $p -Force
  if ($i.PSIsContainer) { cmd /c rmdir "$p" | Out-Null } else { Remove-Item $p -Force }  # rmdir removes the link only, never the target
}

# Make $rel a link to $relTarget (relative to the link's folder). $dir: directory link or file link.
function Ensure-Link($rel, $relTarget, [bool]$dir) {
  $p = Join-Path $Root $rel
  $abs = [IO.Path]::GetFullPath((Join-Path (Split-Path $p -Parent) $relTarget))
  New-Item -ItemType Directory (Split-Path $p -Parent) -Force | Out-Null
  if (Test-Path $p) {
    $i = Get-Item $p -Force
    if ($i.LinkType -eq 'SymbolicLink') { return }
    if ($i.LinkType -and -not $canSym) { return }                                   # junction/hard link fallback already in place
    if (-not $i.LinkType -and -not ($i.PSIsContainer -eq $false -and (Get-Content $p -Raw).Trim() -eq $relTarget.Replace('\', '/'))) {
      Write-Warning "$rel is a real file/dir, not a link; review manually"; return
    }
    Remove-Link $p                                                                  # old junction/hard link, or a symlink checked out as text
  }
  if ($canSym) {
    if ($dir) { cmd /c mklink /D "$p" "$relTarget" | Out-Null } else { cmd /c mklink "$p" "$relTarget" | Out-Null }
    "symlink $rel -> $relTarget"
  } else {
    if ($dir) { New-Item -ItemType Junction -Path $p -Target $abs | Out-Null } else { New-Item -ItemType HardLink -Path $p -Target $abs | Out-Null }
    "fallback link $rel -> $relTarget"
    if ($isGit) { git -C $Root update-index --skip-worktree -- $rel.Replace('\', '/') 2>$null }
  }
}

# 1. Skills: absorb any real tool-specific skills dirs into the canonical one, then link them back.
foreach ($rel in '.github\skills', '.claude\skills') {
  $p = Join-Path $Root $rel
  $i = if (Test-Path $p) { Get-Item $p -Force }
  if ($i -and $i.PSIsContainer -and -not $i.LinkType) {
    foreach ($c in Get-ChildItem $p -Force) {
      $dest = Join-Path $canon $c.Name
      if (Test-Path $dest) { Write-Warning "CONFLICT, left in place: $($c.FullName)"; continue }
      Move-Item $c.FullName $dest; "moved $rel\$($c.Name) -> .agents\skills"
    }
    if (-not (Get-ChildItem $p -Force)) { Remove-Item $p -Force } else { Write-Warning "$rel not empty; not linking it"; continue }
  }
  Ensure-Link $rel '..\.agents\skills' $true
}

# 2. Instructions: AGENTS.md canonical.
$agents = Join-Path $Root 'AGENTS.md'
$cop = Join-Path $Root '.github\copilot-instructions.md'
if (-not (Test-Path $agents)) {
  if ((Test-Path $cop) -and -not (Get-Item $cop).LinkType) { Move-Item $cop $agents; "moved copilot-instructions.md -> AGENTS.md" }
  else { Set-Content $agents "# AGENTS.md`n" -Encoding utf8; "created AGENTS.md" }
}
$rule = 'Canonical agent configuration lives in `.agents/skills/` (skills) and `AGENTS.md` (instructions). MCP servers are managed user-wide in `~/.agents/mcp-servers.json`. Tool-specific paths (`.claude/skills`, `.github/skills`, `.github/copilot-instructions.md`) are relative symlinks committed to git, and `CLAUDE.md` imports `AGENTS.md`; always edit the canonical copy. On a machine without symlink support (Windows without Developer Mode), run `scripts/link-agents.ps1` after cloning.'
$text = Get-Content $agents -Raw
if ($text -notmatch 'Canonical agent configuration lives in') { Add-Content $agents "`n## Agent configuration`n`n$rule`n" -Encoding utf8; "backstop rule appended" }
elseif (-not $text.Contains($rule)) {
  Set-Content $agents ([regex]::Replace($text, '(?m)^Canonical agent configuration lives in.*$', { $rule })) -Encoding utf8 -NoNewline; "backstop rule updated"
}

# 3. Claude Code: CLAUDE.md imports AGENTS.md (a normal tracked file; works everywhere).
$claude = Join-Path $Root 'CLAUDE.md'
if (-not (Test-Path $claude)) { Set-Content $claude "@AGENTS.md`n" -Encoding utf8; "created CLAUDE.md" }
elseif (-not (Select-String -Path $claude -SimpleMatch '@AGENTS.md' -Quiet)) { Write-Warning "CLAUDE.md exists without @AGENTS.md import; review manually" }

# 4. Copilot: link to AGENTS.md (newer Copilot versions also read AGENTS.md natively).
if ((Test-Path $cop) -and -not (Get-Item $cop).LinkType -and -not ((fsutil hardlink list $cop) -match 'AGENTS\.md')) {
  if ((Get-Content $cop -Raw).Trim() -ne '../AGENTS.md') { Write-Warning "copilot-instructions.md is a separate real file; review manually" }
}
Ensure-Link '.github\copilot-instructions.md' '..\AGENTS.md' $false

# 5. Git: with symlinks, track the links and drop the old ignore block; without, keep links ignored-in-place.
if ($isGit -and $canSym) {
  $gi = Join-Path $Root '.gitignore'
  if (Test-Path $gi) {
    $lines = Get-Content $gi
    $drop = '# agent-config links (created by scripts/link-agents.ps1)', '/.claude/skills', '/.github/skills', '/.github/copilot-instructions.md'
    $kept = $lines | ? { $drop -notcontains $_ }
    if ($kept.Count -ne $lines.Count) {
      Set-Content $gi (($kept -join "`n").TrimEnd() + "`n") -Encoding utf8 -NoNewline; "gitignore: removed link entries"
    }
  }
  Push-Location $Root
  try {
    foreach ($w in '.claude/skills', '.github/skills', '.github/copilot-instructions.md') { git update-index --no-skip-worktree -- $w 2>$null }
    git add -- .claude/skills .github/skills .github/copilot-instructions.md
  } finally { Pop-Location }
}
