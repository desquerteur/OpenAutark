# Owns: making the phone app's release key once, outside the repository: a PKCS12 keystore (RSA 4096, valid 30 years,
# alias autark) and its random password, stored DPAPI-protected for this Windows user, in %USERPROFILE%\.autark-release\android.
# build.ps1 -Release reads both. Never: overwrites an existing key (every later APK must carry the same one, or installed
# phones stop taking updates), prints the password, or writes anything into the repository.
# Run it once by hand, then keep the keystore and its password in a safe second place (a password manager holds both).
param(
    [string]$KeyFolder = (Join-Path $env:USERPROFILE '.autark-release/android'),
    [string]$Name = 'Autark'
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$KeyFolder = [IO.Path]::GetFullPath($KeyFolder)
if ($KeyFolder.StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) { throw 'The release key belongs outside the repository.' }
$keystore = Join-Path $KeyFolder 'autark-release.jks'
$secret = Join-Path $KeyFolder 'autark-release.password'
if ((Test-Path -LiteralPath $keystore) -or (Test-Path -LiteralPath $secret)) {
    throw "A release key already exists in $KeyFolder. It stays: a new key would cut every installed phone off from updates."
}
$keytool = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/keytool.exe' } else { 'keytool' }
New-Item -ItemType Directory -Force -Path $KeyFolder | Out-Null

# 32 random bytes as the password (base64url, no characters a shell or Gradle could misread).
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

# keytool reads the passwords from the environment (:env), so they never stand on a command line.
$env:AUTARK_NEW_KEY_PASSWORD = $password
try {
    $ErrorActionPreference = 'Continue'
    & $keytool -genkeypair -v -storetype PKCS12 -keystore $keystore -alias autark -keyalg RSA -keysize 4096 -validity 10950 `
        -dname "CN=$Name, O=Teydra" -storepass:env AUTARK_NEW_KEY_PASSWORD -keypass:env AUTARK_NEW_KEY_PASSWORD 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw "keytool failed (exit $code)." }
    ConvertTo-SecureString -String $password -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $secret -Encoding ascii
} finally {
    Remove-Item Env:AUTARK_NEW_KEY_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
}
# Only this user reads the folder.
& icacls $KeyFolder /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
Write-Output "Release key made: $keystore (alias autark). Back it up now, with its password: the password file opens only for this Windows user on this PC."
Write-Output "For the backup, read the password once into a password manager: [Net.NetworkCredential]::new('', (Get-Content '$secret' | ConvertTo-SecureString)).Password"
