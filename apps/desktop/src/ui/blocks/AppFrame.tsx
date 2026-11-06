// ```app mini-tools: opaque sandbox frames on desktop (wf-sandbox:) and PWA (short-lived URLs
// from blocks.sandboxUrl). Owns: frame lifecycle and the
// MCP Apps bridge (shared/blocks/app-bridge.ts), theme, height, wf_* calls, user-confirmed links
// and fullscreen. app-tools.ts implements host calls; AppRecording reuses the host recorder.
// frame-budget.ts limits live frames; placeholders keep their height, state resumes via wf.state.
// The metadata-only call ring feeds AppActivity below the frame. app-guard.ts freezes frames
// that block for over 2 s, until Resume.
// Owns: frame lifecycle and bridge handling. Never: allow-same-origin, popups or top
// navigation; never treats a bridge message as consent (events go to the agent "via mini-app");
// never logs payload content.

import { useEffect, useRef, useState } from 'preact/hooks';
import { APP_BRIDGE_LIMITS, APP_BRIDGE_PROTOCOL, APP_METHODS } from '../../shared/blocks/app-bridge.ts';
import { LIMITS } from '../../shared/blocks/catalog.ts';
import { blockKey } from '../../shared/blocks/parse.ts';
import type { AppAttrs } from '../../shared/blocks/parse.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { Dialog, Icon, IconButton, confirm } from '../lib/ui.tsx';
import { AppActivity } from './AppActivity.tsx';
import { useAppRecording } from './AppRecording.tsx';
import { appCalls, isReply, logCall } from './app-calls.ts';
import { frameElementId, guardFrame } from './app-guard.ts';
import type { FrameGuard } from './app-guard.ts';
import { BridgeLimiter, clampHeight, frameBytes, isAction, isSizeChange, messageText, parseFrame, toolError } from './app-host.ts';
import type { BridgeFrame, BridgeResult } from './app-host.ts';
import { readGrants, saveGrant, useSandboxSrc } from './app-src.ts';
import { callHostTool, hostContext, linkOpener } from './app-tools.ts';
import { FrameBudget } from './frame-budget.ts';
import { theme } from './host.ts';

const budget = new FrameBudget(LIMITS.liveAppFrames);
const heights = new Map<string, number>(); // last reported height per block (placeholders)
const frozen = new Set<string>(); // blocks paused by the CPU watchdog until the human resumes them
const MIN_HEIGHT = 120;
const PERMISSION_LABEL: Record<string, string> = { microphone: 'microphone', camera: 'camera', 'clipboard-write': 'clipboard' };

class MethodNotFound extends Error {}

type AppProps = { messageId: string; index: number; attrs: AppAttrs };
interface LiveFrameProps extends AppProps {
  mode: 'inline' | 'fullscreen';
  allow: string;
  height?: number;
  onHeight?: (height: number) => void;
  onDisplayMode: (mode: 'inline' | 'fullscreen') => void;
  /** The CPU watchdog tripped: the frame must go. */
  onFreeze: () => void;
}

/** One live iframe with its bridge. */
function LiveFrame(props: LiveFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const [shown, setShown] = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(revealTimer.current), []);
  const currentTheme = theme.value;
  const frameSrc = useSandboxSrc(props.messageId, props.index);
  const recording = useAppRecording({ ...props, todo: props.attrs.todo });
  const record = useRef(recording.record);
  record.current = recording.record;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const limiter = new BridgeLimiter();
    const { messageId, index } = latest.current;
    const key = blockKey(messageId, index);
    let pendingHeight = 0;
    let raf = 0;
    const openLinkOnce = linkOpener(confirm); // one confirm question at a time per frame
    const post = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
    const fail = (id: BridgeFrame['id'], code: number, message: string) => { if (id !== undefined) post({ id, error: { code, message } }); };
    const guard: FrameGuard = guardFrame({ elementId: frame.id, post, onTrip: () => latest.current.onFreeze() });

    const handle = async (msg: BridgeFrame): Promise<BridgeResult | undefined> => {
      switch (msg.method) {
        case APP_METHODS.initialize:
          return { protocolVersion: APP_BRIDGE_PROTOCOL, hostContext: hostContext(latest.current.mode, frame), hostCapabilities: { openLinks: {}, serverTools: {} } };
        case APP_METHODS.initialized:
          ready.current = true;
          setShown(true);
          guard.initialized();
          return undefined;
        case APP_METHODS.toolsCall:
          return callHostTool({ messageId, index, todo: latest.current.attrs.todo }, msg.params.name, (msg.params.arguments ?? {}) as Record<string, unknown>, (args) => record.current(args));
        case APP_METHODS.message: {
          const text = messageText(msg.params);
          if (!text) return toolError('Empty message.');
          await rpc.call('blocks.event', { messageId, blockIndex: index, name: 'prompt', data: { text } });
          return {};
        }
        case 'ui/open-link':
          return openLinkOnce(msg.params.url); // only after the human said Open
        case APP_METHODS.displayMode: {
          const mode = msg.params.mode === 'fullscreen' ? 'fullscreen' : 'inline';
          latest.current.onDisplayMode(mode);
          return { mode };
        }
        default:
          throw new MethodNotFound(msg.method);
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (!frame.contentWindow || event.source !== frame.contentWindow) return; // only our frame
      guard.alive();
      const bytes = frameBytes(event.data);
      if (bytes > APP_BRIDGE_LIMITS.messageBytes) {
        logCall(appCalls, key, event.data, bytes, 'too-large');
        const id = (event.data as { id?: number | string } | null)?.id;
        fail(typeof id === 'number' || typeof id === 'string' ? id : undefined, -32600, 'Message too large');
        return;
      }
      const msg = parseFrame(event.data);
      if (!msg) { if (!isReply(event.data)) logCall(appCalls, key, event.data, bytes, 'invalid'); return; }
      if (isSizeChange(msg)) {
        logCall(appCalls, key, msg, bytes, 'ok');
        const height = clampHeight(msg.params.height);
        if (height === undefined) return;
        pendingHeight = height;
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; latest.current.onHeight?.(pendingHeight); });
        return;
      }
      if (!limiter.allow(isAction(msg), Date.now())) { logCall(appCalls, key, msg, bytes, 'limited'); fail(msg.id, -32000, 'Too many requests'); return; }
      const call = logCall(appCalls, key, msg, bytes, 'pending');
      handle(msg).then(
        (result) => { appCalls.finish(call, result?.isError ? 'error' : 'ok'); if (msg.id !== undefined) post({ id: msg.id, result: result ?? {} }); },
        (error: unknown) => {
          appCalls.finish(call, 'error');
          fail(msg.id, error instanceof MethodNotFound ? -32601 : -32603, error instanceof MethodNotFound ? 'Method not found' : errorText(error));
        },
      );
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      guard.dispose();
      if (raf) cancelAnimationFrame(raf);
      ready.current = false;
    };
  }, [props.messageId, props.index]);

  // Theme flips reach the app as host-context-changed (MCP Apps), so it never looks foreign.
  useEffect(() => {
    if (!ready.current) return;
    ref.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method: APP_METHODS.hostContextChanged, params: hostContext(latest.current.mode, ref.current) }, '*');
  }, [currentTheme]);

  // The iframe stays mounted while its URL loads or failed: the bridge effect above binds to it once.
  const failed = frameSrc.error !== undefined;
  return (
    <>
      {recording.view}
      <iframe
        ref={ref}
        id={frameElementId(blockKey(props.messageId, props.index), props.mode)}
        class={`app-frame-iframe${shown ? ' is-ready' : ''}`}
        src={frameSrc.src}
        title={props.attrs.title ?? 'Mini-app'}
        sandbox="allow-scripts allow-forms"
        allow={props.allow}
        referrerpolicy="no-referrer"
        style={failed ? { display: 'none' } : props.mode === 'inline' ? { height: `${props.height ?? MIN_HEIGHT}px` } : undefined}
        onLoad={() => {
          if (!frameSrc.loaded()) { setShown(false); return; }
          // Apps without the wf helper never send "initialized": show them after load anyway.
          clearTimeout(revealTimer.current);
          revealTimer.current = setTimeout(() => setShown(true), 300);
        }}
      />
      {failed && (
        <div class="boundary-error" role="status">
          <span>{frameSrc.error}</span>
          <button type="button" class="text-button" onClick={frameSrc.refetch}>Retry</button>
        </div>
      )}
    </>
  );
}

export function AppFrame(props: AppProps) {
  const { messageId, index, attrs } = props;
  const key = blockKey(messageId, index);
  const holder = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const [live, setLive] = useState(false);
  const [height, setHeight] = useState(heights.get(key) ?? MIN_HEIGHT);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenNow = useRef(false);
  fullscreenNow.current = fullscreen;
  // Once the human closed the overlay, the app cannot reopen it by itself (no modal trap);
  // "Open larger" still works.
  const userClosed = useRef(false);
  // Frozen by the CPU watchdog: no slot, no frame, until the human presses Resume.
  const [paused, setPaused] = useState(() => frozen.has(key));
  const pausedNow = useRef(paused);
  pausedNow.current = paused;
  const [granted, setGranted] = useState(() => Boolean(readGrants()[key]));
  const permissions = attrs.permissions;
  const allow = granted ? permissions.join('; ') : '';
  // Declared first so its cleanup runs first on unmount (the fullscreen cleanup checks it).
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const off = budget.register(key, setLive);
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      visible.current = true;
      if (!pausedNow.current) budget.acquire(key);
      return off;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      visible.current = Boolean(entry?.isIntersecting);
      if (visible.current) { if (!fullscreenNow.current && !pausedNow.current) budget.acquire(key); } else budget.release(key);
    }, { rootMargin: '200px 0px' });
    observer.observe(el);
    return () => { observer.disconnect(); off(); };
  }, [key]);

  // Fullscreen: the inline frame yields its slot to a pinned overlay frame, and takes it back after.
  const fullKey = `${key}:full`;
  const [fullLive, setFullLive] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    budget.release(key);
    const off = budget.register(fullKey, setFullLive);
    budget.acquire(fullKey);
    budget.pin(fullKey, true);
    return () => {
      budget.pin(fullKey, false);
      off();
      setFullLive(false);
      if (mounted.current && visible.current && !pausedNow.current) budget.acquire(key);
    };
  }, [fullscreen, key]);

  const onHeight = (value: number) => { heights.set(key, value); setHeight(value); };
  const freeze = () => {
    frozen.add(key);
    pausedNow.current = true;
    setPaused(true);
    setFullscreen(false);
    budget.release(key);
  };
  const resume = () => {
    frozen.delete(key);
    pausedNow.current = false;
    setPaused(false);
    if (visible.current) budget.acquire(key);
  };
  const grant = () => { saveGrant(key); setGranted(true); };
  const asked = permissions.map((permission) => PERMISSION_LABEL[permission] ?? permission).join(', ');
  const expandable = attrs.expand && !fullscreen && live && !paused;

  return (
    <div class="app-frame" ref={holder} data-block-key={key}>
      {permissions.length > 0 && !granted && (
        <div class="app-frame-permission" role="note">
          <Icon name="shield" size={14} />
          <span>Asks for: {asked}</span>
          <button type="button" class="text-button" onClick={grant}>Allow</button>
        </div>
      )}
      {paused ? (
        <div class="app-frame-placeholder app-frame-paused" style={{ height: `${height}px` }} role="status">
          <span>Paused – this app was using too much CPU</span>
          <button type="button" class="text-button" onClick={resume}>Resume</button>
        </div>
      ) : live && !fullscreen
        ? <LiveFrame key={allow} messageId={messageId} index={index} attrs={attrs} mode="inline" allow={allow} height={height} onHeight={onHeight}
            onDisplayMode={(mode) => { if (mode === 'fullscreen' && !userClosed.current) setFullscreen(true); }} onFreeze={freeze} />
        : (
          <div class="app-frame-placeholder" style={{ height: `${height}px` }}>
            {!fullscreen && visible.current && (
              <button type="button" class="text-button" onClick={() => budget.acquire(key)}>
                Show{attrs.title ? ` ${attrs.title}` : ''}
              </button>
            )}
          </div>
        )}
      {expandable && <IconButton icon="app-window" label="Open larger" size="small" class="app-frame-expand" onClick={() => setFullscreen(true)} />}
      {!fullscreen && <AppActivity frame={key} />}
      <Dialog open={fullscreen} onClose={() => { userClosed.current = true; setFullscreen(false); }} title={attrs.title ?? 'Mini-app'} class="app-fullscreen" width={1200}>
        {fullscreen && fullLive && (
          <LiveFrame messageId={messageId} index={index} attrs={attrs} mode="fullscreen" allow={allow}
            onDisplayMode={(mode) => { if (mode === 'inline') setFullscreen(false); }} onFreeze={freeze} />
        )}
      </Dialog>
    </div>
  );
}
