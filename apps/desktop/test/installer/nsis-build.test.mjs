// Owns: real compiler output, icon reconstruction, CRC rejection and non-execution of build helpers.
// Never: installs an app, executes generated EXEs, changes trust or uses real accounts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { UninstallerReader, verifyNsisIntegrity } from '../../scripts/vendor/nsis-reader.ts';
import { enableStaticUninstaller } from '../../scripts/nsis-build.mjs';

const require = createRequire(import.meta.url);
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js');
const { spawnAndWriteWithOutput } = require('builder-util');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });

async function generator(icon, compressed = true) {
  const dir = await mkdtemp(path.join(results, 'nsis-reader-'));
  const compiler = await getMakeNsisPath();
  const file = path.join(dir, 'generator.exe');
  const script = [
    'Unicode true', compressed ? 'SetCompressor zlib' : 'SetCompress off',
    `OutFile "${file}"`, 'RequestExecutionLevel user', 'SilentInstall silent',
    ...(icon ? ['Icon "${NSISDIR}/Contrib/Graphics/Icons/modern-install.ico"', `UninstallIcon "\${NSISDIR}/Contrib/Graphics/Icons/${icon}"`] : []),
    'Section "install"', 'WriteUninstaller "$EXEDIR\\uninstaller.exe"', 'SectionEnd',
    'Section "Uninstall"', 'DetailPrint "uninstall"', 'SectionEnd',
  ].join('\n');
  await spawnAndWriteWithOutput(compiler.path, ['-WX', '-V2', '-'], script, { env: { ...process.env, ...compiler.env } });
  return { file, output: path.join(dir, 'uninstaller.exe') };
}

for (const compressed of [false, true]) {
  for (const icon of [null, 'modern-install.ico', 'modern-uninstall.ico']) {
    test(`real NSIS data reconstructs ${icon ?? 'default icons'}, compressed=${compressed}`, async () => {
      const { file, output } = await generator(icon, compressed);
      verifyNsisIntegrity(await readFile(file));
      await UninstallerReader.exec(file, output);
      const extracted = await readFile(output);
      verifyNsisIntegrity(extracted);
      assert.equal(extracted.readUInt16LE(0), 0x5a4d);
      const corrupted = Buffer.from(extracted);
      corrupted[2048] ^= 0xff;
      assert.throws(() => verifyNsisIntegrity(corrupted), /CRC32/);
    });
  }
}

test('corrupt exehead fails extraction without writing an invalid uninstaller', async () => {
  const { file, output } = await generator('modern-uninstall.ico');
  const data = await readFile(file);
  data[2048] ^= 0xff;
  await writeFile(file, data);
  await assert.rejects(UninstallerReader.exec(file, output), /CRC32/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('the build adapter extracts the real compiler output and never calls native execution', async () => {
  const { file } = await generator(null);
  let nativeCalls = 0;
  class Vm { exec() { nativeCalls++; throw new Error('must never execute'); } }
  enableStaticUninstaller(name => name.endsWith('package.json') ? { version: '26.15.3' } : { WineVmManager: Vm });
  await new Vm().exec(file, [], { env: { __COMPAT_LAYER: 'RunAsInvoker' } });
  verifyNsisIntegrity(await readFile(path.join(path.dirname(file), 'generator.__uninstaller.exe')));
  await assert.rejects(new Vm().exec(file, ['/S'], {}), /refusing to execute/);
  assert.equal(nativeCalls, 0);
});

test('toolchain drift and non-NSIS data fail closed', () => {
  assert.throws(() => enableStaticUninstaller(() => ({ version: 'different' })), /Review the static NSIS adapter/);
  assert.throws(() => verifyNsisIntegrity(Buffer.alloc(4096)), /NSIS header not found/);
});
