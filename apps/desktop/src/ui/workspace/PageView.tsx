// Pane tab › a view from <data>/pages: the file in a frame of its own (opaque origin, wf-sandbox://page/<name>) that fills the tab
// and speaks the mini-tools' bridge (shared/blocks/app-bridge.ts) with the same helper wf.js, plus the app's RPC (wf.rpc) and
// events (wf.listen). Whoever wrote the file may do what the window may do; nothing here reviews it. A changed file reloads
// (the frame's key is the file's time), the theme follows, and a link opens in a tab of the same surface.
// Owns: that frame and its bridge. Never: reads the file itself (main's protocol does) or limits a page's calls.

import { useEffect, useRef } from 'preact/hooks';
import { APP_BRIDGE_PROTOCOL, APP_METHODS, APP_TOOLS } from '../../shared/blocks/app-bridge.ts';
import { parseFrame, toolError, toolResult, type BridgeFrame, type BridgeResult } from '../blocks/app-host.ts';
import { hostContext } from '../blocks/app-tools.ts';
import { theme } from '../blocks/host.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { EmptyState } from '../lib/ui.tsx';
import { openWebsite } from './pages.ts';
import { useSpace } from './space.ts';
import { userPages } from './user-pages.ts';

const STATE_KEY = 'wf.pageState.';

function readState(name: string): unknown {
  try { return JSON.parse(localStorage.getItem(STATE_KEY + name) ?? 'null') ?? undefined; } catch { return undefined; }
}

function PageFrame(props: { name: string }) {
  const { name } = props;
  const ref = useRef<HTMLIFrameElement>(null);
  const space = useSpace();
  const currentTheme = theme.value;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    const offs = new Map<string, () => void>();
    const post = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
    const tool = async (tool: unknown, args: Record<string, unknown>): Promise<BridgeResult> => {
      switch (tool) {
        case APP_TOOLS.rpc: return toolResult({ result: await rpc.call(String(args.method) as never, (args.params ?? undefined) as never) });
        case APP_TOOLS.listen: {
          const event = String(args.event);
          if (!offs.has(event)) offs.set(event, rpc.on(event as never, (data: unknown) => post({ method: `event/${event}`, params: data })));
          return toolResult({ ok: true });
        }
        case APP_TOOLS.stateGet: return toolResult({ state: readState(name) });
        case APP_TOOLS.stateSet:
          try { localStorage.setItem(STATE_KEY + name, JSON.stringify(args.state ?? null)); } catch { /* storage may be blocked */ }
          return toolResult({ ok: true });
        default: return toolError(`${String(tool)} belongs to mini-tools in a chat.`);
      }
    };
    const handle = async (msg: BridgeFrame): Promise<BridgeResult | undefined> => {
      switch (msg.method) {
        case APP_METHODS.initialize: return { protocolVersion: APP_BRIDGE_PROTOCOL, hostContext: hostContext('fullscreen', frame), hostCapabilities: { openLinks: {}, serverTools: {} } };
        case APP_METHODS.toolsCall: return tool(msg.params.name, (msg.params.arguments ?? {}) as Record<string, unknown>);
        case 'ui/open-link': await openWebsite(String(msg.params.url), { space }); return {};
        case APP_METHODS.displayMode: return { mode: 'fullscreen' };
        default: return msg.id === undefined ? undefined : toolError(`${msg.method} is not available in a page.`);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (!frame.contentWindow || event.source !== frame.contentWindow) return; // only our frame
      const msg = parseFrame(event.data);
      if (!msg) return;
      handle(msg).then(
        (result) => { if (msg.id !== undefined) post({ id: msg.id, result: result ?? {} }); },
        (error: unknown) => { if (msg.id !== undefined) post({ id: msg.id, result: toolError(errorText(error)) }); },
      );
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); for (const off of offs.values()) off(); };
  }, [name, space]);

  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method: APP_METHODS.hostContextChanged, params: hostContext('fullscreen', ref.current) }, '*');
  }, [currentTheme]);

  return <iframe ref={ref} class="pane-page-frame" src={`wf-sandbox://page/${encodeURIComponent(name)}`} title={name} sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" />;
}

export function PageView(props: { name: string }) {
  const { name } = props;
  const pages = userPages.value;
  const page = pages?.find((item) => item.name === name);
  if (pages && !page) return <div class="pane-view"><div class="new-tab"><EmptyState>This page is gone: no file for it in the pages folder.</EmptyState></div></div>;
  if (!page) return <div class="pane-view" />;
  return <div class="pane-view"><PageFrame key={`${name}:${page.updatedAt}`} name={name} /></div>;
}
