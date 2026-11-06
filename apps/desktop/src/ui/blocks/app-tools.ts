// Host side of the ```app bridge requests that reach beyond the frame: the wf_* host tools
// (events, to-do completion, file hand-back – wf_upload, checked and stored by app-upload.ts –,
// persisted state, mermaid), the host context sent on initialize and on theme flips, and
// ui/open-link (always confirmed by the human, one question at a time).
// Owns: what these requests do. Never: treats a call as consent – events reach the agent
// "via mini-app", completion and files only for to-do apps, links only after the human said Open.

import { APP_TOOLS } from '../../shared/blocks/app-bridge.ts';
import type { AppHostContext } from '../../shared/blocks/app-bridge.ts';
import { blockKey } from '../../shared/blocks/parse.ts';
import { isMobile, platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toolError, toolResult } from './app-host.ts';
import type { BridgeResult } from './app-host.ts';
import { appUpload } from './app-upload.ts';
import { openLink, theme, uploadBlob, wfTokens } from './host.ts';
import { renderMermaid } from './mermaid.ts';

export function hostContext(mode: 'inline' | 'fullscreen', frame: HTMLIFrameElement | null): AppHostContext {
  return {
    theme: theme.value,
    styles: { variables: wfTokens() },
    displayMode: mode,
    platform: platform === 'desktop' && !isMobile.value ? 'desktop' : isMobile.value ? 'mobile' : 'web',
    containerDimensions: { width: frame?.clientWidth || undefined, maxHeight: mode === 'fullscreen' ? Math.max(200, innerHeight - 120) : undefined },
    locale: navigator.language,
  };
}

/** One `tools/call` of a wf_* host tool for the app of block (messageId, index). */
export async function callHostTool(block: { messageId: string; index: number; todo: boolean }, name: unknown, args: Record<string, unknown>, record?: (args: Record<string, unknown>) => Promise<BridgeResult>): Promise<BridgeResult> {
  const { messageId, index } = block;
  switch (name) {
    case APP_TOOLS.event: {
      const eventName = typeof args.name === 'string' ? args.name : '';
      await rpc.call('blocks.event', { messageId, blockIndex: index, name: eventName, data: args.data ?? undefined });
      return toolResult({ ok: true });
    }
    case APP_TOOLS.complete:
      if (!block.todo) return toolError('This app is not a to-do.');
      await rpc.call('blocks.answer', { messageId, blockIndex: index, answer: args.data ?? null, clientId: `app:${blockKey(messageId, index)}` });
      return toolResult({ ok: true });
    case APP_TOOLS.stateGet:
      return toolResult({ state: (await rpc.call('blocks.state', { messageId, blockIndex: index })).state ?? null });
    case APP_TOOLS.stateSet:
      await rpc.call('blocks.state', { messageId, blockIndex: index, state: args.state ?? null });
      return toolResult({ ok: true });
    case APP_TOOLS.mermaid: {
      const source = typeof args.source === 'string' ? args.source : '';
      return toolResult({ svg: await renderMermaid(source, theme.value) });
    }
    case APP_TOOLS.record:
      if (!block.todo) return toolError('This app is not a to-do.');
      if (!can('files.uploadChunk') || !can('blocks.file')) return toolError('This device cannot store files for mini-apps.');
      return record ? record(args) : toolError('Recording is not available here.');
    case APP_TOOLS.upload:
      if (!can('files.uploadChunk') || !can('blocks.file')) return toolError('This device cannot store files for mini-apps.');
      return appUpload(block, args, { upload: (blob, fileName) => uploadBlob(blob, fileName), register: (params) => rpc.call('blocks.file', params) });
    default:
      return toolError('Unknown tool.');
  }
}

/**
 * ui/open-link handler for one frame. The human confirms every link: an app opening URLs by
 * itself would be an exfiltration channel around connect-src 'none' (data in the query string).
 * `confirm` is lib/ui.tsx's dialog (passed in by AppFrame, so this module stays plain .ts).
 */
export function linkOpener(confirm: (options: { title: string; body?: string; confirmLabel?: string }) => Promise<boolean>): (raw: unknown) => Promise<BridgeResult> {
  let pending = false;
  return async (raw) => {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!/^(https?:|mailto:)/i.test(url) || url.length > 2048) return { isError: true };
    if (pending) return { isError: true };
    pending = true;
    try {
      if (!await confirm({ title: 'Open link from mini-app?', body: url, confirmLabel: 'Open' })) return { isError: true };
    } finally {
      pending = false;
    }
    openLink(url);
    return {};
  };
}
