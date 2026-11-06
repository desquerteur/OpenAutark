# Owns: one bounded build on the shared PC: the preview (debug) build by default; with -Release the APK signed with the
# release key from outside the repo (new-release-key.ps1 made it), checked with apksigner, copied to
# app/build/outputs/apk/release/autark-android.apk with its record autark-android.json (version, SHA-256, signer), which
# the release PC's publish scripts take. Never: installs, publishes or restarts Autark, or
# prints or stores the key's password.
param(
    [switch]$Release,
    # Where new-release-key.ps1 put the key; the default is the same folder.
    [string]$KeyFolder = (Join-Path $env:USERPROFILE '.autark-release/android')
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$repository = [IO.Path]::GetFullPath((Join-Path $root '../..'))
$lock = Join-Path $repository '.local/einfach/tc.lock'
$debugSigner = '97630dc5'  # start of the preview's debug certificate SHA-256 (README): a release APK must not carry it

function Invoke-Native([string]$file, [string[]]$arguments) {
    # Windows PowerShell otherwise treats a tool's stderr notes as terminating errors, even on exit 0.
    $ErrorActionPreference = 'Continue'
    $output = & $file @arguments 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    return @{ code = $code; output = @($output) }
}

[IO.Directory]::CreateDirectory((Split-Path $lock)) | Out-Null
try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null }
catch { throw "Another heavy check owns $lock. Run this build after that check finishes." }
try {
    & (Join-Path $root 'test.ps1')
    $gradle = Join-Path $root 'gradlew.bat'
    if (-not (Test-Path -LiteralPath $gradle -PathType Leaf)) { throw 'Gradle wrapper is missing.' }
    $signer = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat'
    if (-not (Test-Path -LiteralPath $signer -PathType Leaf)) { throw 'Android Build Tools 36.0.0 apksigner is missing.' }

    if ($Release) {
        $keystore = Join-Path $KeyFolder 'autark-release.jks'
        $secret = Join-Path $KeyFolder 'autark-release.password'
        if (-not (Test-Path -LiteralPath $keystore -PathType Leaf) -or -not (Test-Path -LiteralPath $secret -PathType Leaf)) {
            throw "No release key in $KeyFolder. Make it once with new-release-key.ps1 (and keep a backup: without it no later APK updates the installed app)."
        }
        if ($KeyFolder.StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) { throw 'The release key belongs outside the repository.' }
        # The password is stored DPAPI-protected for this Windows user (new-release-key.ps1).
        $secure = Get-Content -LiteralPath $secret | ConvertTo-SecureString
        $env:AUTARK_ANDROID_KEYSTORE = $keystore
        $env:AUTARK_ANDROID_KEYSTORE_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password
        $env:AUTARK_ANDROID_KEY_ALIAS = 'autark'
        try {
            $run = Invoke-Native $gradle @('-p', $root, ':app:assembleRelease', '--no-daemon', '--max-workers=1')
        } finally {
            Remove-Item Env:AUTARK_ANDROID_KEYSTORE_PASSWORD, Env:AUTARK_ANDROID_KEYSTORE, Env:AUTARK_ANDROID_KEY_ALIAS -ErrorAction SilentlyContinue
        }
        $run.output | ForEach-Object { $_ }
        if ($run.code -ne 0) { throw "Android release build failed (exit $($run.code))." }
        $outputs = Join-Path $root 'app/build/outputs/apk/release'
        $built = Join-Path $outputs 'app-release.apk'
        if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw 'No signed app-release.apk (an unsigned build means the key was not passed in).' }
        $check = Invoke-Native $signer @('verify', '--verbose', '--print-certs', $built)
        $check.output | ForEach-Object { $_ }
        if ($check.code -ne 0) { throw 'APK signature verification failed.' }
        $line = $check.output | Where-Object { $_ -match 'certificate SHA-256 digest: ([0-9a-f]{64})' } | Select-Object -First 1
        if (-not $line -or $line -notmatch 'certificate SHA-256 digest: ([0-9a-f]{64})') { throw 'apksigner printed no certificate digest.' }
        $certificate = $Matches[1]
        if ($certificate.StartsWith($debugSigner)) { throw 'The release APK carries the debug key.' }
        $gradleText = Get-Content -LiteralPath (Join-Path $root 'app/build.gradle') -Raw
        if ($gradleText -notmatch "(?m)^\s*versionCode = (\d+)\s*$") { throw 'versionCode not found in build.gradle.' }
        $versionCode = [int]$Matches[1]
        if ($gradleText -notmatch "(?m)^\s*versionName = '([^']+)'\s*$") { throw 'versionName not found in build.gradle.' }
        $versionName = $Matches[1]
        $apk = Join-Path $outputs 'autark-android.apk'
        Copy-Item -LiteralPath $built -Destination $apk -Force
        $sha = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
        $record = [ordered]@{
            versionCode = $versionCode; versionName = $versionName; sha256 = $sha; bytes = (Get-Item -LiteralPath $apk).Length
            signer = $certificate; debugSigner = $debugSigner; signatureVerified = $true; builtAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        # UTF-8 without BOM and LF: python's json reads it either way, the repo keeps LF.
        [IO.File]::WriteAllText((Join-Path $outputs 'autark-android.json'), (($record | ConvertTo-Json) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
        Write-Output "autark-android.apk $versionName (versionCode $versionCode) sha256 $sha signer $certificate"
    } else {
        $run = Invoke-Native $gradle @('-p', $root, ':app:assembleDebug', ':app:lintDebug', '--no-daemon', '--max-workers=1')
        $run.output | ForEach-Object { $_ }
        if ($run.code -ne 0) { throw "Android build or lint failed (exit $($run.code))." }
        $apk = Join-Path $root 'app/build/outputs/apk/debug/app-debug.apk'
        $check = Invoke-Native $signer @('verify', '--verbose', '--print-certs', $apk)
        $check.output | ForEach-Object { $_ }
        if ($check.code -ne 0) { throw 'APK signature verification failed.' }
        Get-FileHash -LiteralPath $apk -Algorithm SHA256
    }
} finally {
    # This lock is the exact directory created above; it contains no files.
    Remove-Item -LiteralPath $lock -ErrorAction Stop
}
