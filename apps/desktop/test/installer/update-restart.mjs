// Real Windows NSIS upgrade through the shipped desktop, preload, updater and renderer.
// Owns: an isolated product ID, install/profile/cache and two upgrade steps. Never: the real installation or accounts.
// Run after building: node test/installer/update-restart.mjs (Windows only; creates/removes its own shortcuts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

assert.equal(process.platform, 'win32', 'this test runs Windows installers');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resume = process.env.WORKFORCE_INSTALLER_RESUME;
const fixedOnly = process.env.WORKFORCE_INSTALLER_FIXED_ONLY === '1';
if (resume) assert.ok(path.resolve(resume).startsWith(path.join(root, 'test-results') + path.sep) && /^installer-[a-f0-9]{8}$/.test(path.basename(resume)), 'resume only this test\'s generated fixtures');
const id = resume ? path.basename(resume).slice('installer-'.length) : randomBytes(4).toString('hex');
const product = `Workforce update test ${id}`;
const out = path.join(root, 'test-results', `installer-${id}`);
const project = path.join(out, 'project');
const oldConfig = resume ? JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) : null;
const install = path.join(out, 'installed');
const profile = path.join(out, 'profile');
const exe = path.join(install, product + '.exe');
const marker = path.join(out, 'installed-version.txt');
const launches = path.join(profile, 'launches.jsonl');
const menuLink = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs', product + '.lnk');
const desktop = path.join(os.homedir(), 'Desktop', product + '.lnk');
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_COMPRESSION_LEVEL: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKFORCE_TEST_DATA;
await mkdir(profile, { recursive: true });
await mkdir(project, { recursive: true });
const say = text => console.log(new Date().toISOString() + ' ' + text);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, args, log, timeout = 180_000) {
  const { createWriteStream } = await import('node:fs');
  const sink = createWriteStream(path.join(out, log), { flags: 'a' });
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(sink, { end: false });
    child.stderr.pipe(sink, { end: false });
    const timer = setTimeout(() => {
      // Only this child and its installer helpers belong to the test.
      spawn(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      reject(new Error(`${log} exceeded ${timeout} ms (pid ${child.pid})`));
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${log}: exit ${code}`)); });
  }).finally(() => sink.end());
}

// Wait on file changes (not a polling interval). The timeout is only the failure bound.
async function fileWhere(file, predicate, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      try { const text = await readFile(file, 'utf8'); if (predicate(text)) { finish(); resolve(text); } } catch { /* not written yet */ }
    };
    const watcher = watch(path.dirname(file), (_event, name) => { if (String(name) === path.basename(file)) void check(); });
    const timer = setTimeout(() => { finish(); reject(new Error(`No matching ${path.basename(file)} within ${timeout} ms`)); }, timeout);
    function finish() { clearTimeout(timer); watcher.close(); }
    void check();
  });
}

const ps = text => `'${text.replace(/'/g, "''")}'`;
async function shortcut(target, args = '') {
  const command = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${ps(menuLink)});$s.TargetPath=${ps(target)};$s.Arguments=${ps(args)};$s.WindowStyle=7;$s.Save()`;
  await run(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], 'shortcut.log');
}

let feedVersion = '0.0.2';
const built = new Map();
const server = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
    if (name !== 'latest.yml' && !/^0\.0\.[123]-installer\.exe(?:\.blockmap)?$/.test(name)) throw new Error('unknown asset');
    const source = path.join(built.get(name === 'latest.yml' ? feedVersion : name.slice(0, 5)), name);
    const { stat } = await import('node:fs/promises');
    const size = (await stat(source)).size;
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(source).pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(oldConfig ? Number(new URL(oldConfig.build.publish.url).port) : 0, '127.0.0.1', resolve));
const port = server.address().port;
const debug = http.createServer();
await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve));
let debugPort = debug.address().port;
await new Promise(resolve => debug.close(resolve));

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const base = process.env.WORKFORCE_INSTALLER_BASE ? path.resolve(process.env.WORKFORCE_INSTALLER_BASE) : root;
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
// Reuse the exact verified production dependency layout; a node_modules junction is not a package graph.
if (!resume) {
  asar.extractAll(path.join(base, 'dist/win-unpacked/resources/app.asar'), project);
  await cp(path.join(root, 'assets'), path.join(project, 'assets'), { recursive: true });
  await cp(path.join(base, 'app/main.cjs'), path.join(project, 'app/main.cjs'));
} else {
  debugPort = Number(/remote-debugging-port',"(\d+)"/.exec(await readFile(path.join(project, 'bootstrap.cjs'), 'utf8'))?.[1]);
  assert.ok(debugPort > 0 && oldConfig.productName === product);
}
const fixtureName = `workforce-update-test-${id}`;
const bootstrap = `process.env.WORKFORCE_FAKE_ENGINE='1';delete process.env.WORKFORCE_TEST_DATA;
const {app,utilityProcess}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(profile)});
const fork=utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork=(module,args,options)=>fork(module,args,{...options,env:{...options.env,WORKFORCE_TEST_DATA:${JSON.stringify(profile)}}});
app.commandLine.appendSwitch('remote-debugging-port',${JSON.stringify(String(debugPort))});
app.on('browser-window-created',(_e,w)=>w.webContents.once('did-finish-load',()=>fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({version:app.getVersion(),pid:process.pid})+'\\n')));
require('./app/main.cjs');`;
if (!resume) await writeFile(path.join(project, 'bootstrap.cjs'), bootstrap);
const builder = path.join(root, 'scripts/package-desktop.mjs');
const hook = /!macro customInstall\s+([\s\S]*?)!macroend/.exec(await readFile(path.join(root, 'assets/installer.nsh'), 'utf8'))?.[1];
assert.ok(hook, 'the production direct-launch hook exists');

let app, appProcess, rpc, reopenedPid, runtimeToken;
try {
  for (const version of fixedOnly ? ['0.0.2', '0.0.3'] : ['0.0.1', '0.0.2', '0.0.3']) {
    const dist = path.join(out, version);
    built.set(version, dist);
    if (resume) continue;
    const config = {
      ...pkg, name: fixtureName, productName: product, version, main: 'bootstrap.cjs',
      build: {
        ...pkg.build, appId: `com.teydralab.workforce.update-test.${id}`, productName: product,
        electronVersion: pkg.devDependencies.electron,
        compression: 'normal', npmRebuild: false, directories: { output: dist, buildResources: 'assets' },
        files: [...pkg.build.files, 'bootstrap.cjs'], publish: { provider: 'generic', url: `http://127.0.0.1:${port}/` },
        win: { ...pkg.build.win, artifactName: `${version}-installer.exe` },
        nsis: { ...pkg.build.nsis, differentialPackage: false, shortcutName: product },
      },
    };
    await writeFile(path.join(project, 'package.json'), JSON.stringify(config, null, 2));
    // Only the tested relaunch hook is copied. The real uninstall hook must never touch the real login entry.
    await writeFile(path.join(project, 'assets/installer.nsh'), `!macro customInstall\n${version === '0.0.3' ? hook : ''}\nFileOpen $9 "${marker.replaceAll('$', '$$')}" w\nFileWrite $9 "${version}"\nFileClose $9\n!macroend\n`);
    say('Building isolated NSIS ' + version);
    await run(process.execPath, [builder, '--win', '--x64', '--publish', 'never'], 'build-' + version + '.log', 300_000);
  }
  const resumeBaseline = resume && process.env.WORKFORCE_INSTALLER_RESUME_BASELINE === '1';
  if (resumeBaseline) {
    assert.equal((await readFile(marker, 'utf8')).trim(), '0.0.2');
    assert.equal(JSON.parse(asar.extractFile(path.join(install, 'resources/app.asar'), 'package.json').toString()).version, '0.0.2');
    assert.ok(!(await readFile(launches, 'utf8')).includes('"version":"0.0.2"'), 'the installed baseline has never relaunched');
    say('Resuming verified installed 0.0.2 baseline without an automatic launch');
  } else {
    const initial = fixedOnly ? '0.0.2' : '0.0.1';
    say('Installing isolated ' + initial);
    await run(path.join(built.get(initial), initial + '-installer.exe'), ['/S', '/currentuser', `/D=${install}`], 'initial-install.log', 300_000);
    assert.equal((await readFile(marker, 'utf8')).trim(), initial);
  }
  const desktopHash = createHash('sha256').update(await readFile(desktop)).digest('hex');

  const open = async () => {
    app = await electron.launch({ executablePath: exe, env, cwd: install, timeout: 120_000 });
    appProcess = app.process(); // retain the handle before Playwright disposes the app channel on quit
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1280, 820); w.restore(); w.show(); w.focus(); });
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.locator('.shell').waitFor({ timeout: 120_000 });
    const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
    runtimeToken = info.token;
    rpc = await connect(info.port, info.token);
    assert.ok((await stat(path.join(profile, 'workspace'))).isDirectory());
    await rpc.call('settings.update', { onboarding: { completed: true, step: 'done' }, preferences: { autoDownloadUpdates: true } });
    await page.locator('.update-button.status-downloaded:visible').first().waitFor({ timeout: 180_000 });
    await page.evaluate(() => window.workforce.updates.defer());
    return page;
  };
  const restart = async page => {
    const action = page.getByRole('button', { name: 'Restart', exact: true });
    // The auto-restart countdown may already have opened the menu before Later/defer stopped it.
    if (!(await action.isVisible())) await page.locator('.update-button.status-downloaded:visible').first().click({ force: true, timeout: 60_000 });
    await action.click({ force: true, timeout: 60_000 }).catch(error => {
      if (!page.isClosed()) throw error; // the intended quit can disconnect Playwright before click returns
    });
  };
  let page, task;
  if (!resumeBaseline && !fixedOnly) {
  page = await open();
  task = (await rpc.call('day.add', { text: 'Preserve this installer-test task' })).tasks[0];
  // A kept shortcut can be stale. This benign obsolete launcher exits without opening the app.
  await shortcut(path.join(process.env.SystemRoot, 'System32/cmd.exe'), '/c exit 0');
  say('Baseline: Restart through an obsolete Start-menu link');
  rpc.close(); rpc = undefined;
  const installed2 = fileWhere(marker, text => text.trim() === '0.0.2');
  installed2.catch(() => {}); // a failed click must not interrupt cleanup through an unhandled timeout
  await restart(page);
  await installed2;
  assert.notEqual(appProcess.exitCode, null, 'the original app process exited');
  app = undefined;
  await pause(25_000);
  assert.ok(!(await readFile(launches, 'utf8')).includes('"version":"0.0.2"'), 'baseline did not automatically reopen within 25 seconds');
  say('Baseline reproduced: installed, but did not reopen');
  }

  feedVersion = '0.0.3';
  page = await open(); // explicit recovery from the baseline failure, before testing the fix
  if (fixedOnly) task = (await rpc.call('day.add', { text: 'Preserve this installer-test task' })).tasks[0];
  task ??= (await rpc.call('tasks.list')).find(item => item.title === 'Preserve this installer-test task');
  assert.ok(task, 'the task was created before the baseline upgrade');
  await shortcut(path.join(out, 'missing', 'No app.exe'));
  rpc.close(); rpc = undefined;
  const relaunched = fileWhere(launches, text => text.includes('"version":"0.0.3"'));
  relaunched.catch(() => {});
  await writeFile(path.join(out, 'before-upgrade.json'), JSON.stringify({ taskId: task.id, desktopHash, at: Date.now() }));
  say('Fixed: Restart with a missing shortcut target');
  await restart(page);
  await relaunched;
  assert.notEqual(appProcess.exitCode, null, 'the old app process exited');
  reopenedPid = JSON.parse((await readFile(launches, 'utf8')).trim().split('\n').find(line => line.includes('"version":"0.0.3"'))).pid;
  app = undefined;
  // Observe the actual relaunched runtime and main state, without enabling a second debug connection.
  const info = JSON.parse(await fileWhere(path.join(profile, 'runtime.json'), text => JSON.parse(text).token !== runtimeToken));
  rpc = await connect(info.port, info.token);
  const system = await rpc.call('system.info');
  assert.equal(system.version, '0.0.3');
  assert.equal(path.relative(profile, system.dataDir), '');
  assert.ok((await rpc.call('tasks.list')).some(item => item.id === task.id));
  // Windows may defer fs.watch notifications for a log whose stream remains open.
  // The runtime is ready; allow the 3 s startup check to finish, then inspect the written state.
  await pause(10_000);
  const mainLog = await readFile(path.join(profile, 'logs/main.log'), 'utf8');
  const start = mainLog.lastIndexOf('starting 0.0.3');
  assert.ok(start >= 0 && mainLog.slice(start).includes('update state: current'));
  assert.equal(createHash('sha256').update(await readFile(desktop)).digest('hex'), desktopHash, 'the existing desktop shortcut was retained');
  await writeFile(path.join(out, 'verification.json'), JSON.stringify({ baseline: fixedOnly ? 'not run in this probe' : 'updated without reopening through stale link', fixed: 'automatically reopened 0.0.3 with missing shortcut target', taskPreserved: true, updateState: 'current', updateStateEvidence: 'new process main log', desktopShortcutRetained: true, isolatedRuntimeWorkspace: true, product, appId: configId(id), realInstallationTouched: false }, null, 2));
  say('PASS: automatic new-version restart, retained data/shortcut, no repeated update offer');
} catch (error) {
  console.error(error); // retain the actual failure even if cleanup also fails
  if (app) {
    console.log(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds() }))).catch(() => 'window closed'));
    await app.windows()[0]?.screenshot({ path: path.join(out, 'failure.png'), timeout: 10_000 }).catch(() => {});
  }
  throw error;
} finally {
  rpc?.close();
  if (reopenedPid) { try { process.kill(reopenedPid); } catch { /* already closed */ } }
  if (app) {
    const ownPid = appProcess?.exitCode === null ? appProcess.pid : undefined;
    await Promise.race([app.close().catch(() => {}), pause(5000)]);
    if (ownPid) { try { process.kill(ownPid); } catch { /* already closed */ } }
  }
  const uninstall = (await readdir(install).catch(() => [])).find(name => /^Uninstall .*\.exe$/.test(name));
  if (uninstall) {
    const target = path.resolve(install, uninstall);
    assert.ok(target.startsWith(path.resolve(out) + path.sep) && product.startsWith('Workforce update test '));
    const cleanup = path.join(out, 'cleanup-uninstaller.exe');
    await cp(target, cleanup);
    // Running outside the install folder with _?= avoids NSIS's asynchronous self-copy.
    await run(cleanup, ['/S', `_?=${install}`], 'uninstall.log', 300_000).catch(error => { console.error('Test cleanup failed:', error); process.exitCode = 1; });
  }
  await new Promise(resolve => server.close(resolve));
  say('Evidence: ' + out);
}

function configId(id) { return `com.teydralab.workforce.update-test.${id}`; }

// A detached Playwright driver can outlive Electron after an installer quits it.
// All owned app/installer cleanup above is awaited before ending this standalone probe.
await new Promise(resolve => process.stdout.write('', resolve));
process.exit(process.exitCode ?? 0);
