// Entry of the runtime utility process (bundled to app/runtime.mjs, forked by Electron main).
// Owns: the runtime side of the host-bridge lifecycle – wait for `init`, build the runtime,
// answer `ready` with the launch token, serve every transferred MessagePort as an owner-scope
// RPC connection, forward main-produced events onto the bus (B-055: side-browser pointers to the
// pointer hub; B-076: a watched side tab's frames to the side views), drain on `shutdown`. The start is
// guarded (repair/boot.ts, 23.10.2026): a broken upgrade or a crash loop at start runs the repair
// runtime instead (repair screen: retry, restore data from before the update, diagnostics).
// Never: imports electron (the parent port is reached through `process.parentPort`).

import path from 'node:path';
import { HOST_BRIDGE_PROTOCOL, parseMainMessage } from '../shared/api/host-bridge.ts';
import type { AppInfo } from '../shared/api/host-bridge.ts';
import type { EventName } from '../shared/api/events.ts';
import { createElectronHost, HostBridgeClient } from './host-electron.ts';
import { createRuntime, type Runtime } from './main.ts';
import type { RpcConnection } from './rpc/connection.ts';
import { guardedBoot } from './repair/boot.ts';
import { BootJournal } from './repair/journal.ts';
import { startRepairRuntime, type RepairRuntime } from './repair/server.ts';
import { companyWorkspace } from './root/companies.ts';
import { sideViewOf } from './browser/side-view.ts'; // B-076
import { FileLogger } from './system/log.ts';
import { systemClock } from './system/clock.ts';

interface PortMainLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown; ports: PortMainLike[] }) => void): unknown;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('entry-electron must run inside an Electron utility process');
  process.exit(1);
}

const bridge = new HostBridgeClient(parentPort);
let runtime: Runtime | undefined;
let repair: RepairRuntime | undefined;
let journal: BootJournal | undefined;
let booting: Promise<void> | undefined;
const pendingPorts: Array<{ port: PortMainLike; client: 'desktop' | 'main' }> = [];

function portConnection(port: PortMainLike): RpcConnection {
  return {
    send: (frame) => { try { port.postMessage(frame); } catch { /* port closed */ } },
    close: () => { try { port.close(); } catch { /* already closed */ } },
    onMessage: (listener) => { port.on('message', (event) => listener(event.data)); },
    onClose: (listener) => { port.on('close', listener); },
  };
}

/** Main's own port is marked `main` (secrets.fillLogin answers it alone); the window's is plain owner scope. */
function serve(port: PortMainLike, client: 'desktop' | 'main'): void {
  if (!runtime && !repair) { pendingPorts.push({ port, client }); return; }
  if (runtime) runtime.attach(portConnection(port), client === 'main' ? { kind: 'owner', main: true } : { kind: 'owner' });
  else repair!.attach(portConnection(port));
  port.start();
}

async function boot(token: string, app: AppInfo): Promise<void> {
  const host = createElectronHost(bridge, app);
  journal = new BootJournal({ dataDir: app.dataDir });
  const outcome = await guardedBoot({
    journal,
    version: app.version,
    repair: (problem) => startRepairRuntime({ dataDir: app.dataDir, version: app.version, host, journal: journal!, problem, log: new FileLogger({ dir: path.join(app.dataDir, 'logs'), clock: systemClock }) }),
    start: () => createRuntime({
      host,
      dataDir: app.dataDir,
      resourcesDir: path.join(app.resourcesDir, 'resources'),
      staticDir: path.join(app.resourcesDir, 'app', 'ui'),
      launchToken: token,
      version: app.version,
      fakeEngine: process.env.WORKFORCE_FAKE_ENGINE === '1',
      // A test profile and another company (B-072) keep the agents' files too (never the person's ~/Workforce).
      workspaceDir: process.env.WORKFORCE_TEST_DATA ? path.join(process.env.WORKFORCE_TEST_DATA, 'workspace') : companyWorkspace(app),
    }),
  });
  if (outcome.kind === 'runtime') runtime = outcome.runtime;
  else repair = outcome.repair;
  for (const pending of pendingPorts.splice(0)) serve(pending.port, pending.client);
  parentPort!.postMessage({ type: 'ready', token, protocol: HOST_BRIDGE_PROTOCOL });
}

parentPort.on('message', (event) => {
  const message = parseMainMessage(event.data);
  if (!message) return;
  switch (message.type) {
    case 'init':
      if (booting) return;
      booting = boot(message.token, message.app).catch((error) => {
        console.error('runtime failed to start', error);
        process.exit(1);
      });
      break;
    case 'host-result':
      bridge.resolve(message);
      break;
    case 'power':
      bridge.emitPower(message.event);
      break;
    case 'connect':
      if (event.ports?.[0]) serve(event.ports[0], message.client);
      break;
    case 'event':
      runtime?.services.bus.emit(message.event as EventName, message.data as never);
      break;
    case 'pointer': // B-055 F1: the person's pointer / an agent's move in the side browser (main/side-driver)
      runtime?.services.pointers?.point(message.point);
      break;
    case 'side-view': // B-076: a watched side tab's frame or page (main/side-driver/caster.ts)
      if (runtime) sideViewOf(runtime.services).update(message.update);
      break;
    case 'shutdown':
      repair?.close();
      // A requested stop is never a crash – also when the drain fails or main kills the process
      // after its stop timeout (journal.stopped() keeps a pinned repair problem).
      journal?.stopped();
      void (runtime?.shutdown(message.reason) ?? Promise.resolve()).finally(() => {
        bridge.close();
        process.exit(0);
      });
      break;
  }
});
