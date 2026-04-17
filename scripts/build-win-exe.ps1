Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDirectory = Join-Path $projectRoot "release"
$bundleFile = Join-Path $projectRoot "dist\\bicli.bundle.cjs"
$outputFile = Join-Path $releaseDirectory "bicli.exe"

Push-Location $projectRoot
try {
    npm install
    npm run build

    if (-not (Test-Path $releaseDirectory)) {
        New-Item -ItemType Directory -Path $releaseDirectory | Out-Null
    }

    npx esbuild .\dist\src\pkg-entry.js --bundle --platform=node --target=node20 --format=cjs --outfile=$bundleFile
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
    if (-not (Test-Path $bundleFile)) { throw "Bundle file was not created: $bundleFile" }

    npx pkg $bundleFile --targets node18-win-x64 --output $outputFile
    if ($LASTEXITCODE -ne 0) { throw "pkg failed" }
    if (-not (Test-Path $outputFile)) { throw "Executable was not created: $outputFile" }

    Write-Host ""
    Write-Host "Windows executable created:"
    Write-Host "  $outputFile"
} finally {
    Pop-Location
}
