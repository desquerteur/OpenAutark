// Image avatar mirror of the agent folders (B-044 §5 / decision 22): an agent with an image avatar has
// its bytes beside SYSTEM.md as <data>/agents/<id>/avatar.png (avatar.jpg for a JPEG photo), written by
// the app – at start for every agent and on each 'agent.upserted' whose avatar changed – and removed when
// the avatar is no image any more. The file is a readable copy for the open folder and for exports; the
// blob store stays the source (a change made on disk is not read back here).
// Owns: these two files per agent folder and the last mirrored file id per agent. Never: reads
// SYSTEM.md or skills, writes outside agent folders, follows links, or polls.

import { copyFileSync, lstatSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { FileStore, Logger, OrgService } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { agentFolder, isCoreFolderName } from './layout.ts';

export const AVATAR_FILES = { 'image/png': 'avatar.png', 'image/jpeg': 'avatar.jpg' } as const;
const NAMES: readonly string[] = Object.values(AVATAR_FILES);

export interface AvatarMirrorDeps {
  dataDir: string;
  files: Pick<FileStore, 'get' | 'path'>;
  org: () => Pick<OrgService, 'list'>;
  bus: Pick<Bus, 'on'>;
  log: Logger;
}

const isLink = (file: string): boolean => { try { return lstatSync(file).isSymbolicLink(); } catch { return false; } };
const exists = (file: string): boolean => { try { lstatSync(file); return true; } catch { return false; } };

export class AvatarMirror {
  private readonly deps: AvatarMirrorDeps;
  /** Agent id → the file id last mirrored ('' = none). */
  private readonly mirrored = new Map<string, string>();
  private off?: () => void;

  constructor(deps: AvatarMirrorDeps) {
    this.deps = deps;
  }

  /** Mirrors every agent once, then follows avatar changes. */
  start(): void {
    for (const agent of this.deps.org().list({ includeArchived: true })) this.sync(agent);
    this.off ??= this.deps.bus.on('agent.upserted', (agent) => this.sync(agent));
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  /** The agent's folder gets its image avatar's copy, or loses it; a status-only change touches nothing. */
  sync(agent: Pick<Agent, 'id' | 'avatar'>): void {
    if (!isCoreFolderName(agent.id)) return;
    const fileId = agent.avatar.kind === 'image' ? agent.avatar.value : '';
    const folder = agentFolder(this.deps.dataDir, agent.id);
    const ref = fileId ? this.deps.files.get(fileId) : undefined;
    const name = ref ? AVATAR_FILES[ref.mime as keyof typeof AVATAR_FILES] : undefined;
    const target = name ? path.join(folder, name) : undefined;
    if (this.mirrored.get(agent.id) === fileId && (!target || exists(target))) return;
    try {
      for (const other of NAMES) {
        const file = path.join(folder, other);
        if (file !== target && exists(file) && !isLink(file)) rmSync(file, { force: true });
      }
      if (target && ref) {
        if (!exists(folder) || isLink(target)) return; // no folder (yet), or a link the app never follows
        const temp = `${target}.${process.pid}.tmp`;
        try {
          copyFileSync(this.deps.files.path(ref.id), temp);
          renameSync(temp, target);
        } finally {
          rmSync(temp, { force: true });
        }
      }
      this.mirrored.set(agent.id, fileId);
    } catch (error) {
      this.deps.log.warn('avatar copy in the agent folder not written', { agentId: agent.id, error: String(error) });
    }
  }
}
