param(
  [ValidateSet('dev', 'release')]
  [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
if (-not $distRoot.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar)) {
  throw 'Refusing to package outside the project workspace.'
}

if ($Mode -eq 'release') {
  # Release mode: validate-manifest refuses while the Plus development
  # preview is enabled and enforces package/manifest version parity.
  $env:DABLAJA_RELEASE = '1'
} else {
  Remove-Item Env:\DABLAJA_RELEASE -ErrorAction SilentlyContinue
}

& node (Join-Path $projectRoot 'scripts/validate-manifest.mjs')
if ($LASTEXITCODE -ne 0) {
  throw "Manifest validation failed (mode: $Mode); no package was created."
}
& node (Join-Path $projectRoot 'scripts/check.mjs')
if ($LASTEXITCODE -ne 0) {
  throw "Static checks failed (mode: $Mode); no package was created."
}

if (Test-Path -LiteralPath $distRoot) {
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}
$stage = Join-Path $distRoot 'dablaja'
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($item in @('manifest.json', 'src', 'icons', 'privacy.html', 'privacy.css')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $stage -Recurse -Force
}

$forbidden = Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $_.Name -match '(\.map$|\.pem$|\.env|\.log$|secret|test)' -or
  $_.FullName -match 'node_modules|__pycache__|\.git'
}
if ($forbidden) {
  throw "Forbidden files found in package: $($forbidden.FullName -join ', ')"
}

$packageVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json).version
# A preview build must never share a filename with a future Store upload.
$zipName = if ($Mode -eq 'release') { "dablaja-v$packageVersion.zip" } else { "dablaja-v$packageVersion-DEVELOPMENT-PREVIEW.zip" }
$zipPath = Join-Path $distRoot $zipName
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  if (-not ($archive.Entries | Where-Object FullName -eq 'manifest.json')) {
    throw 'Packaged ZIP is missing manifest.json at archive root.'
  }
  Write-Output "Created $zipPath with $($archive.Entries.Count) files."
} finally {
  $archive.Dispose()
}
