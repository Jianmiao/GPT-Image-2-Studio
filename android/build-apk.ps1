param(
    [string]$JdkHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$OutputApk = (Join-Path (Split-Path $PSScriptRoot -Parent) 'GPT-Image-2生图工具.apk')
)
$ErrorActionPreference = 'Stop'
$toolCache = Join-Path $env:USERPROFILE '.cache\gpt-image2-android-tools'
if (-not $JdkHome) {
    $cachedJdk = Get-ChildItem -LiteralPath (Join-Path $toolCache 'jdk') -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } | Select-Object -First 1
    if ($cachedJdk) { $JdkHome = $cachedJdk.FullName }
}
if (-not $AndroidSdk) {
    foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Android\Sdk'), (Join-Path $toolCache 'sdk'))) {
        if (Test-Path (Join-Path $candidate 'platforms\android-35\android.jar')) {
            $AndroidSdk = $candidate
            break
        }
    }
}
if (-not $JdkHome -or -not (Test-Path (Join-Path $JdkHome 'bin\java.exe'))) {
    throw 'Set JAVA_HOME to a JDK 17 directory, or pass -JdkHome.'
}
if (-not $AndroidSdk -or -not (Test-Path (Join-Path $AndroidSdk 'platforms\android-35\android.jar'))) {
    throw 'Install Android SDK platform 35 and build-tools 35.0.0, then pass -AndroidSdk or set ANDROID_HOME.'
}
$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $AndroidSdk
$sdkForProperties = $AndroidSdk.Replace('\', '/')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'local.properties'), "sdk.dir=$sdkForProperties`n", [Text.UTF8Encoding]::new($false))
Push-Location $PSScriptRoot
try {
    & (Join-Path $PSScriptRoot 'gradlew.bat') --no-daemon :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Android build failed ($LASTEXITCODE)." }
    $builtApk = Join-Path $PSScriptRoot 'app\build\outputs\apk\debug\app-debug.apk'
    & (Join-Path $AndroidSdk 'build-tools\35.0.0\apksigner.bat') verify --verbose $builtApk
    if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed ($LASTEXITCODE)." }
    Copy-Item -LiteralPath $builtApk -Destination $OutputApk -Force
    Write-Output "APK: $OutputApk"
    Get-FileHash -LiteralPath $OutputApk -Algorithm SHA256 | Format-List
}
finally {
    Pop-Location
}
