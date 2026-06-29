# Local Windows prod build, the analog of scripts/dist-mac.sh. Output: release\BlitzOS Setup <version>.exe
#
# Order matters: build the native CU helper FIRST so electron-builder's win.extraResources finds the exe,
# then electron-vite build, then electron-builder --win.
#
# Signing: UNSIGNED by default (electron-builder builds an unsigned installer, which runs fine because the
# helper needs no TCC). For a SIGNED build set the standard electron-builder env vars before running:
#   $env:CSC_LINK = 'path\to\cert.pfx'; $env:CSC_KEY_PASSWORD = '...'
# Signing is a prerequisite for flipping app.manifest uiAccess="true" + a perMachine (Program Files)
# install, which is what lets the helper drive ELEVATED windows. Until then it stays asInvoker.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot               # repo root
Set-Location $root

Write-Host "[dist-win] building native CU helper"
& (Join-Path $root 'native\computer-use-helper\build-win.ps1')
if ($LASTEXITCODE -ne 0) { throw "[dist-win] helper build failed ($LASTEXITCODE)" }

Write-Host "[dist-win] electron-vite build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "[dist-win] electron-vite build failed ($LASTEXITCODE)" }

if (-not $env:CSC_LINK) {
  # No cert provided: build cleanly unsigned instead of letting electron-builder hunt the cert store.
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  Write-Host "[dist-win] UNSIGNED build (set CSC_LINK + CSC_KEY_PASSWORD for a signed installer)"
}

Write-Host "[dist-win] electron-builder --win"
npx electron-builder --win --x64 --publish never
if ($LASTEXITCODE -ne 0) { throw "[dist-win] electron-builder failed ($LASTEXITCODE)" }

Get-ChildItem (Join-Path $root 'release') -ErrorAction SilentlyContinue |
  Where-Object { -not $_.PSIsContainer } | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
