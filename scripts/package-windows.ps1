[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$NodeLicense,
    [Parameter(Mandatory = $true)][string]$OutputZip,
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

# This release deliberately accepts one verified Windows x64 runtime.
$expectedNodeVersion = 'v24.19.0'
$expectedNodeHash = '3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237'
$nodeSource = 'https://nodejs.org/dist/v24.19.0/win-x64/node.exe'
$nodeChecksums = 'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt'
$licenseSource = 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE'
$launcherName = [regex]::Unescape('\u542f\u52a8\u5de5\u5177.bat')
$releaseNotesName = [regex]::Unescape('\u53d1\u5e03\u8bf4\u660e.txt')
$rootFiles = @('package.json', 'LICENSE', 'README.md', $launcherName, $releaseNotesName)
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$NodeLicense = (Resolve-Path -LiteralPath $NodeLicense).Path
$OutputZip = [System.IO.Path]::GetFullPath($OutputZip)
if ([System.IO.Path]::GetExtension($OutputZip) -ine '.zip') { throw 'OutputZip must end in .zip.' }
foreach ($output in @($OutputZip, ($OutputZip + '.manifest.txt'), ($OutputZip + '.sha256'))) {
    if (Test-Path -LiteralPath $output) { throw 'Refusing to overwrite an existing release output.' }
}
if ((Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash -cne $expectedNodeHash) {
    throw 'Node runtime SHA256 does not match the verified official Windows x64 binary.'
}
$runtimeIdentity = & $NodeExe -p '[process.version,process.platform,process.arch].join(String.fromCharCode(32))'
if ($LASTEXITCODE -ne 0 -or $runtimeIdentity -cne ($expectedNodeVersion + ' win32 x64')) {
    throw 'Node runtime version or architecture is incorrect.'
}
$licenseText = [System.IO.File]::ReadAllText($NodeLicense)
if ($licenseText.Length -lt 1000 -or $licenseText -notmatch 'Node\.js is licensed for use' -or $licenseText -notmatch 'Permission is hereby granted') {
    throw 'NodeLicense must contain the complete official Node.js LICENSE.'
}

# Only Git-tracked files in these explicit source categories are candidates.
# In particular, do not walk the workspace or copy directories recursively.
$trackedEntries = @(& git -c core.quotepath=false -C $SourceRoot ls-files --stage -- server web test package.json LICENSE README.md $launcherName $releaseNotesName)
if ($LASTEXITCODE -ne 0) { throw 'SourceRoot must be a Git checkout.' }
$selected = New-Object 'System.Collections.Generic.List[string]'
foreach ($entry in $trackedEntries) {
    if ($entry -notmatch '^(\d{6}) [0-9a-f]+ ([0-3])\t(.+)$') { throw 'Unexpected Git index entry.' }
    $mode = $Matches[1]
    $indexStage = $Matches[2]
    $relative = $Matches[3]
    $allowed = ($rootFiles -ccontains $relative) -or
        ($relative -cmatch '^server/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.js$') -or
        ($relative -cmatch '^web/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(js|html|css)$') -or
        ($relative -cmatch '^test/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.js$')
    if (-not $allowed) { continue }
    if ($mode -notin @('100644', '100755') -or $indexStage -ne '0') { throw 'Selected source must be a regular, conflict-free tracked file.' }
    if ($relative -match '(^|/)\.|(^|/)(node_modules|runtime)(/|$)') { throw 'Hidden or generated paths are not release source.' }
    $source = Join-Path $SourceRoot $relative
    $current = Get-Item -LiteralPath $source -Force
    if ($current -is [System.IO.DirectoryInfo]) { throw 'Selected source is not a regular file.' }
    while ($current.FullName -ne $SourceRoot) {
        if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Release source cannot use symbolic links or junctions.' }
        $current = if ($current -is [System.IO.DirectoryInfo]) { $current.Parent } else { $current.Directory }
        if ($null -eq $current) { throw 'Selected source escaped SourceRoot.' }
    }
    $selected.Add($relative)
}
foreach ($required in $rootFiles + @('server/cli.js', 'web/index.html')) {
    if (-not $selected.Contains($required)) { throw ('Required tracked release file is missing: ' + $required) }
}
$package = [System.IO.File]::ReadAllText((Join-Path $SourceRoot 'package.json')) | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Package version must be a release version.' }
$archiveRoot = 'GPT-Image-2-Studio-v' + $package.version + '-Windows-x64'
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('gptimage2-package-stage-' + [guid]::NewGuid().ToString('N'))
$tempZip = Join-Path $stage 'package.zip'
[System.IO.Directory]::CreateDirectory($stage) | Out-Null
$manifest = New-Object 'System.Collections.Generic.List[string]'
$files = New-Object 'System.Collections.Generic.List[string]'
try {
    foreach ($relative in $selected) {
        $source = Join-Path $SourceRoot $relative
        $destination = Join-Path $stage ('files/' + $relative)
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
        if ($relative -ceq 'README.md') {
            # Screenshots are intentionally not distributed in the Windows bundle.
            $readme = [System.IO.File]::ReadAllText($source)
            $readme = [regex]::Replace($readme, '(?m)^\s*!\[[^\]]*\]\(docs/ui-preview\.png\)\s*\r?\n?', '')
            [System.IO.File]::WriteAllText($destination, $readme, $utf8)
        } else {
            [System.IO.File]::Copy($source, $destination, $false)
        }
        $files.Add($relative)
    }
    $runtimeDir = Join-Path $stage 'files/runtime'
    [System.IO.Directory]::CreateDirectory($runtimeDir) | Out-Null
    [System.IO.File]::Copy($NodeExe, (Join-Path $runtimeDir 'node.exe'), $false)
    [System.IO.File]::Copy($NodeLicense, (Join-Path $runtimeDir 'LICENSE.txt'), $false)
    $licenseHash = (Get-FileHash -LiteralPath $NodeLicense -Algorithm SHA256).Hash.ToLowerInvariant()
    $origin = @(
        ('Node.js ' + $expectedNodeVersion + ' (Windows x64)'),
        ('Binary source: ' + $nodeSource),
        ('Official checksums: ' + $nodeChecksums),
        ('Binary SHA256: ' + $expectedNodeHash.ToLowerInvariant()),
        ('License source: ' + $licenseSource),
        ('License SHA256: ' + $licenseHash),
        '',
        'The executable and license are supplied explicitly by the packager caller.',
        'No user configuration, generated images, API keys or system Node installation is bundled.'
    ) -join "`n"
    [System.IO.File]::WriteAllText((Join-Path $runtimeDir 'ORIGIN.txt'), $origin + "`n", $utf8)
    foreach ($relative in @('runtime/node.exe', 'runtime/LICENSE.txt', 'runtime/ORIGIN.txt')) { $files.Add($relative) }
    $ordered = @($files.ToArray())
    [Array]::Sort($ordered, [StringComparer]::Ordinal)
    foreach ($relative in $ordered) {
        $hash = (Get-FileHash -LiteralPath (Join-Path $stage ('files/' + $relative)) -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifest.Add($hash + '  ' + $relative)
    }
    $manifestText = ($manifest -join "`n") + "`n"
    [System.IO.File]::WriteAllText((Join-Path $stage 'files/PACKAGE-MANIFEST.sha256'), $manifestText, $utf8)
    $ordered += 'PACKAGE-MANIFEST.sha256'
    [Array]::Sort($ordered, [StringComparer]::Ordinal)
    Add-Type -AssemblyName System.IO.Compression
    $output = [System.IO.File]::Open($tempZip, [System.IO.FileMode]::CreateNew)
    $zip = New-Object System.IO.Compression.ZipArchive($output, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($relative in $ordered) {
            $entry = $zip.CreateEntry(($archiveRoot + '/' + $relative), [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = New-Object System.DateTimeOffset(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $input = [System.IO.File]::OpenRead((Join-Path $stage ('files/' + $relative)))
            $stream = $entry.Open()
            try { $input.CopyTo($stream) } finally { $stream.Dispose(); $input.Dispose() }
        }
    } finally { $zip.Dispose(); $output.Dispose() }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutputZip)) | Out-Null
    [System.IO.File]::Move($tempZip, $OutputZip)
    [System.IO.File]::WriteAllText(($OutputZip + '.manifest.txt'), $manifestText, $utf8)
    $zipHash = (Get-FileHash -LiteralPath $OutputZip -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(($OutputZip + '.sha256'), $zipHash + '  ' + [System.IO.Path]::GetFileName($OutputZip) + "`n", $utf8)
    [pscustomobject]@{ Zip = $OutputZip; SHA256 = $zipHash; Files = $ordered.Count; Node = $runtimeIdentity } | ConvertTo-Json
} finally {
    $resolvedStage = [System.IO.Path]::GetFullPath($stage)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    if ([System.IO.Path]::GetDirectoryName($resolvedStage) -ne $tempRoot -or
        -not [System.IO.Path]::GetFileName($resolvedStage).StartsWith('gptimage2-package-stage-')) {
        throw 'Refusing to clean a path outside the temporary package stage.'
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
