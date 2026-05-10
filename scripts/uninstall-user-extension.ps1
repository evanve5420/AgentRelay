$ErrorActionPreference = 'Stop'

$copilotConfigDir = if ($env:COPILOT_CONFIG_DIR) { $env:COPILOT_CONFIG_DIR } else { Join-Path $HOME '.copilot' }
$targetDir = Join-Path (Join-Path $copilotConfigDir 'extensions') 'AgentRelay'

if (Test-Path $targetDir) {
    Remove-Item -Path $targetDir -Recurse -Force
    Write-Host "AgentRelay extension removed from $targetDir"
} else {
    Write-Host "AgentRelay extension was not installed at $targetDir"
}
