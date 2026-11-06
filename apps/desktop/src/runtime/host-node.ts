// Host for the headless runtime (worker PCs, the CLI, end-to-end tests): no Electron.
// Owns: file-key secret encryption (AES-256-GCM, key file 0600 in the data dir), opening
// URLs/paths with the OS opener, and inert notification/power/idle answers.
// Never: pretends to have a screen – `capture` is absent, so computer use reports
// "unavailable" honestly on a headless host.

import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Host } from './host.ts';

const KEY_FILE = 'runtime.key';

function loadKey(dataDir: string): Buffer {
  const file = path.join(dataDir, KEY_FILE);
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  mkdirSync(dataDir, { recursive: true }); // a fresh --data folder (new worker PC, first run)
  writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

function openWithOs(target: string): Promise<void> {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => resolve());
      child.unref();
    } catch { /* no opener on this machine */ }
    resolve();
  });
}

export interface NodeHostOptions {
  dataDir: string;
  resourcesDir: string;
  version: string;
  /** Called for notifications (CLI prints them; tests collect them). */
  onNotify?(input: { title: string; body: string }): void;
}

export function createNodeHost(options: NodeHostOptions): Host {
  const key = loadKey(options.dataDir);
  return {
    kind: 'node',
    async encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    async decrypt(data) {
      const buffer = Buffer.from(data);
      const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
    },
    async notify(input) {
      options.onNotify?.(input);
      return false;
    },
    openExternal: async (url) => { if (/^(https?:|mailto:)/i.test(url)) await openWithOs(url); },
    openPath: async (target, reveal) => { await openWithOs(reveal ? path.dirname(target) : target); },
    onPower: () => () => {},
    idleSeconds: async () => 3600, // nobody sits at a headless runtime
    keepAwake: () => () => {},
    app: { version: options.version, packaged: false, resourcesDir: options.resourcesDir, dataDir: options.dataDir, executable: process.execPath },
  };
}
