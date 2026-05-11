param(
    [switch]$SkipPull,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$installScript = Join-Path $scriptDir 'install-user-extension.ps1'

if (-not (Test-Path $installScript)) {
    throw "Install script not found: $installScript"
}

Push-Location $repoRoot
try {
    if (-not $SkipPull) {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            throw "Git is required to pull updates. Install Git or rerun with -SkipPull after updating the repository manually."
        }

        if (-not (Test-Path (Join-Path $repoRoot '.git'))) {
            throw "This update script expects a Git checkout. Rerun with -SkipPull after updating the files manually, or use install-user-extension.ps1 directly."
        }

        $status = git status --porcelain
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to check Git status."
        }

        if ($status) {
            throw "Working tree has uncommitted changes. Commit, stash, or discard them before updating."
        }

        git pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            throw "Git pull failed."
        }
    }

    if (-not $SkipTests) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "npm is required to run tests. Install Node.js 24 or newer, or rerun with -SkipTests."
        }

        npm test
        if ($LASTEXITCODE -ne 0) {
            throw "Tests failed. Extension was not reinstalled."
        }
    }

    & $installScript
}
finally {
    Pop-Location
}

Write-Host "AgentRelay update complete. Reload Copilot CLI extensions with /clear, restart the session, or ask an agent to call extensions_reload."
