$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
if (-not $distRoot.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar)) {
  throw 'Refusing to package outside the project workspace.'
}

& node (Join-Path $projectRoot 'scripts/validate-manifest.mjs')
& node (Join-Path $projectRoot 'scripts/check.mjs')

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
$zipPath = Join-Path $distRoot "dablaja-v$packageVersion.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal

$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  if (-not ($archive.Entries | Where-Object FullName -eq 'manifest.json')) {
    throw 'Packaged ZIP is missing manifest.json at archive root.'
  }
  Write-Output "Created $zipPath with $($archive.Entries.Count) files."
} finally {
  $archive.Dispose()
}
