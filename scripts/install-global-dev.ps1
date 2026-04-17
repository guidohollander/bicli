Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    npm install
    npm link

    Write-Host ""
    Write-Host "Global commands installed:"
    Write-Host "  bicli      -> compiled CLI (run 'npm run build' after code changes)"
    Write-Host "  bicli-dev  -> source-backed CLI (always reflects current source)"
    Write-Host ""
    Write-Host "Recommended for development:"
    Write-Host "  bicli-dev validate <files...> --bi-home <path> --project-root <path>"
} finally {
    Pop-Location
}
