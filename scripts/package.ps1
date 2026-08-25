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
& node (Join-Path $projectRoot 'scripts/validate-store-assets.mjs')
if ($LASTEXITCODE -ne 0) {
  throw "Chrome Web Store asset validation failed (mode: $Mode); no package was created."
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

# Explicit runtime allowlist — only these files may enter the ZIP.
# Any unused asset, test, preview, mock, profile, source map, secret or dev file is excluded by default.
$allowList = @(
  'manifest.json',
  'privacy.html',
  'privacy.css',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'src/service-worker.js',
  'src/shared/constants.js',
  'src/shared/lifecycle.js',
  'src/shared/usage-stats.js',
  'src/shared/telemetry.js',
  'src/shared/checkout-url.js',
  'src/shared/key-validation.js',
  'src/shared/plus-entitlement.js',
  'src/shared/license-refresh-coordinator.js',
  'src/shared/rotation-controller.js',
  'src/shared/plus-draft-controller.js',
  'src/shared/plus-messages.js',
  'src/shared/plus-db.js',
  'src/shared/plus-session.js',
  'src/shared/site-profiles.js',
  'src/shared/plus-search.js',
  'src/shared/plus-export.js',
  'src/shared/plus-backup.js',
  'src/shared/protocol.js',
  'src/shared/audio-utils.js',
  'src/shared/audio-control.js',
  'src/shared/caption-utils.js',
  'src/shared/note-flush.js',
  'src/shared/normalize-origin.js',
  'src/popup/popup.html',
  'src/popup/popup.js',
  'src/popup/popup.css',
  'src/popup/wordmark.png',
  'src/popup/wave.png',
  'src/popup/mascot.png',
  'src/offscreen/offscreen.html',
  'src/offscreen/offscreen.js',
  'src/worklets/capture-processor.js',
  'src/worklets/playback-processor.js',
  'src/sidepanel/sidepanel.html',
  'src/sidepanel/sidepanel.js',
  'src/sidepanel/sidepanel.css',
  'src/library/library.html',
  'src/library/library.js',
  'src/library/library.css',
  'src/library/assets/dablaja-logo.png',
  'src/library/assets/mascot.png',
  'src/library/assets/thumbnail-fallback.png',
  'src/stats/stats.html',
  'src/stats/stats.js',
  'src/stats/stats.css',
  'src/stats/yzn.jpg',
  'src/diagnostics/diagnostics.html',
  'src/diagnostics/diagnostics.js',
  'src/diagnostics/diagnostics.css'
)

foreach ($relative in $allowList) {
  $source = Join-Path $projectRoot $relative
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Allowlisted file missing: $relative (required for runtime)"
  }
  $dest = Join-Path $stage $relative
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $dest -Force
}

$stageFiles = Get-ChildItem -LiteralPath $stage -Recurse -File

$forbidden = $stageFiles | Where-Object {
  $_.Name -match '(\.map$|\.pem$|\.env|\.log$|secret|test)' -or
  $_.FullName -match 'node_modules|__pycache__|\.git|preview|mock'
}
if ($forbidden) {
  throw "Forbidden files found in package: $($forbidden.FullName -join ', ')"
}

$packageVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json).version
# A preview build must never share a filename with a future Store upload.
$zipName = if ($Mode -eq 'release') { "dablaja-v$packageVersion.zip" } else { "dablaja-v$packageVersion-DEVELOPMENT-PREVIEW.zip" }
$zipPath = Join-Path $distRoot $zipName

# Compress-Archive writes backslash entry separators on Windows PowerShell 5.1,
# which the Chrome Web Store rejects. Write entries explicitly with forward
# slashes via System.IO.Compression instead.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $stageFiles) {
    $relative = $file.FullName.Substring($stage.Length).TrimStart('\', '/') -replace '\\', '/'
    if (-not $relative) { continue }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $archive.Dispose()
  $archiveStream.Dispose()
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$readback = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  if (-not ($readback.Entries | Where-Object FullName -eq 'manifest.json')) {
    throw 'Packaged ZIP is missing manifest.json at archive root.'
  }
  $badSeparators = @($readback.Entries | Where-Object { $_.FullName -match '\\' })
  if ($badSeparators.Count) {
    throw ("ZIP entries use backslash separators: $($badSeparators[0].FullName)")
  }
  Write-Output "Created $zipPath with $($readback.Entries.Count) files."
} finally {
  $readback.Dispose()
}
