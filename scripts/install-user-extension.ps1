$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourceDir = Join-Path $repoRoot 'src'
$copilotConfigDir = if ($env:COPILOT_CONFIG_DIR) { $env:COPILOT_CONFIG_DIR } else { Join-Path $HOME '.copilot' }
$extensionsDir = Join-Path $copilotConfigDir 'extensions'
$targetDir = Join-Path $extensionsDir 'AgentRelay'

$requiredFiles = @(
    'extension.mjs',
    'db.mjs',
    'mesh.mjs',
    'transport-local-sqlite.mjs'
)

foreach ($file in $requiredFiles) {
    $path = Join-Path $sourceDir $file
    if (-not (Test-Path $path)) {
        throw "Required source file not found: $path"
    }
}

if (Test-Path $targetDir) {
    Remove-Item -Path $targetDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

foreach ($file in $requiredFiles) {
    Copy-Item -Path (Join-Path $sourceDir $file) -Destination (Join-Path $targetDir $file) -Force
}

@"
Installed from: $repoRoot
Installed at: $(Get-Date -Format o)
"@ | Set-Content -Path (Join-Path $targetDir 'installed-from.txt') -Encoding utf8

Write-Host "AgentRelay extension installed to $targetDir"
Write-Host "Reload Copilot CLI extensions with /clear, restart the session, or ask an agent to call extensions_reload."
