# Owns: small host-side Java tests. Never: substitutes for a real Android device test.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin' } else { '' }
$javac = if ($java) { Join-Path $java 'javac.exe' } else { 'javac' }
$runtime = if ($java) { Join-Path $java 'java.exe' } else { 'java' }
# The same BouncyCastle the app bundles (app/build.gradle), from Gradle's cache after the first build resolved it.
$bc = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1/org.bouncycastle/bcprov-jdk18on/1.79') -Recurse -Filter 'bcprov-jdk18on-1.79.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $bc) { throw 'bcprov-jdk18on-1.79.jar is not in the Gradle cache yet; run the Gradle build once.' }
$out = Join-Path $root 'app/build/host-tests'
New-Item -ItemType Directory -Force $out | Out-Null
$sources = @(Get-ChildItem (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/relay') -Filter '*.java' | ForEach-Object FullName) +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/ConnectionAddress.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/ScreenTree.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/Gestures.java') +
    @(Get-ChildItem (Join-Path $root 'test') -Filter '*.java' | ForEach-Object FullName) +
    @(Get-ChildItem (Join-Path $root 'test/phoneuse') -Filter '*.java' | ForEach-Object FullName)
& $javac -encoding UTF-8 -Xlint:all -cp $bc.FullName -d $out @sources
if ($LASTEXITCODE -ne 0) { throw 'Host test compilation failed.' }
$classpath = "$out;$($bc.FullName)"
# B-078: the SAS interop vectors (desktop remote/sas.ts) and phone use's screen tree and gestures run here too.
foreach ($test in 'ConnectionAddressTest', 'RelayCryptoTest', 'relay.RemotePairTest', 'phoneuse.ScreenTreeTest') {
    & $runtime -cp $classpath "com.teydralab.autark.android.$test"
    if ($LASTEXITCODE -ne 0) { throw "Host test $test failed." }
}
