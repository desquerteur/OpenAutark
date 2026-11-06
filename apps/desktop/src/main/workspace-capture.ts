// A picture of a person's tab: the visible page of a loaded tab as JPEG with its viewport size (CSS px) – for Send page to
// chat (ui/workspace/send-page.ts) and Mark a region (ui/workspace/RegionDialog.tsx).
// Owns: that read. Never: reads page content.

import type { WebContentsView } from 'electron';
import type { WorkspaceCapture } from '../shared/api/workspace-browser.ts';

interface CaptureTab { view: WebContentsView; error?: string }

/** The visible page of a loaded tab. */
export async function captureTab(id: string, tab: CaptureTab | undefined): Promise<WorkspaceCapture> {
  if (!tab || tab.view.webContents.isDestroyed() || tab.error) throw new Error('Open the page first.');
  const contents = tab.view.webContents;
  const image = await contents.capturePage();
  if (image.isEmpty()) throw new Error('This page cannot be captured right now.');
  const { width, height } = tab.view.getBounds();
  const url = contents.getURL();
  let host = '';
  try { host = new URL(url).hostname; } catch { /* no host */ }
  return { id, url, host, dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`, width: Math.max(1, width), height: Math.max(1, height) };
}
