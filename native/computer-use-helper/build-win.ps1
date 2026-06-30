# Build the Windows Computer Use helper: ONE self-contained single-file exe, the analog of build.sh
# (which builds the signed BlitzOS Automation.app on macOS). Output:
#   native/computer-use-helper/build/blitz-cu-helper.exe
# electron-builder.yml (win.extraResources) ships it to process.resourcesPath; computer-use-helper.ts
# installedHelperExe() resolves it there. Windows has NO TCC, so no signing is required to RUN the helper;
# Authenticode signing is only needed later to flip app.manifest uiAccess="true" (drive elevated windows).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot                                   # native/computer-use-helper
$proj = Join-Path $here 'win\blitz-cu-helper.csproj'
$out  = Join-Path $here 'build'

Write-Host "[cu-helper] dotnet publish -> $out"
dotnet publish $proj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o $out
if ($LASTEXITCODE -ne 0) { throw "[cu-helper] dotnet publish failed ($LASTEXITCODE)" }

$exe = Join-Path $out 'blitz-cu-helper.exe'
if (-not (Test-Path $exe)) { throw "[cu-helper] publish produced no exe at $exe" }
$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "[cu-helper] built -> $exe ($mb MB)"
