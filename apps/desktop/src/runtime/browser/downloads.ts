// Files between an agent's browser and the workspace: uploads only from inside the workspace,
// downloads saved into <workspace>/downloads/<agentId> under a safe name.
// Owns: the workspace path check and the download file name. Never: keeps sessions (service.ts)
// or reads files outside the workspace.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { DownloadLike } from './page.ts';

/** Upload sources must live in the workspace (no arbitrary files from the PC). */
export function workspaceFile(workspace: string, file: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(root + path.sep)) throw new WorkforceError('forbidden', `${file} is outside the workspace; only workspace files can be uploaded.`);
  return target;
}

/** Saves a download; returns its workspace-relative path, or undefined when it failed (logged). */
export async function saveDownload(workspace: string, agentId: string, download: DownloadLike, log: Logger): Promise<string | undefined> {
  try {
    const dir = path.join(workspace, 'downloads', agentId);
    mkdirSync(dir, { recursive: true });
    const name = (download.suggestedFilename() || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
    const target = path.join(dir, `${Date.now().toString(36)}-${name}`);
    await download.saveAs(target);
    return path.relative(workspace, target);
  } catch (error) {
    log.warn('browser download failed', { agentId, error: String(error) });
    return undefined;
  }
}
