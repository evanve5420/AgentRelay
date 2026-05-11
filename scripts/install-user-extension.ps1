$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$extensionSourceDir = Join-Path $repoRoot 'src'
$copilotConfigDir = if ($env:COPILOT_CONFIG_DIR) { $env:COPILOT_CONFIG_DIR } else { Join-Path $HOME '.copilot' }
$extensionsDir = Join-Path $copilotConfigDir 'extensions'
$targetDir = Join-Path $extensionsDir 'AgentRelay'

$requiredFiles = @(
    'extension.mjs',
    'config.mjs',
    'db.mjs',
    'mesh.mjs',
    'transport-local-sqlite.mjs',
    'work-context.mjs'
)

foreach ($file in $requiredFiles) {
    $path = Join-Path $extensionSourceDir $file
    if (-not (Test-Path $path)) {
        throw "Required extension source file not found: $path"
    }
}

if (Test-Path $targetDir) {
    Remove-Item -Path $targetDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

foreach ($file in $requiredFiles) {
    Copy-Item -Path (Join-Path $extensionSourceDir $file) -Destination (Join-Path $targetDir $file) -Force
}

@"
Installed from: $repoRoot
Installed at: $(Get-Date -Format o)
"@ | Set-Content -Path (Join-Path $targetDir 'installed-from.txt') -Encoding utf8

Write-Host "AgentRelay extension installed to $targetDir"
Write-Host "Reload Copilot CLI extensions with /clear, restart the session, or ask an agent to call extensions_reload."
