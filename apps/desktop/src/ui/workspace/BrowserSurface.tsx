// The frame of the browser live view and – while the person has taken the browser over (MP9) –
// the surface that sends their clicks, drags, wheel turns, keys and pastes to the agent's tab
// (browser.input through browser-input.ts). Not taken over, it is a plain picture: watching
// never steers. Focus follows a click on the picture; Esc returns the keyboard to the app.
// X02 touch: a tap clicks, one finger scrolls the page at 1x (browser-touch.ts; touch-action
// none) and pans the picture at 2x (`zoom`, touch-action pan-x pan-y – taps still click); the
// handled touchend cancels the browser's synthetic mouse events. The hidden key field for the
// on-screen keyboard (BrowserKeys.tsx, `keys`) sits here too. Mouse and keyboard paths are as before.
// B-044 visual pass: the picture carries the page's size (--frame-w/-h) so the stylesheet never shows
// it larger than the page; the surface's layout (centred at 1x, a scrolling box at 2x) is CSS
// (workspace.css .browser-touch), so a view can align it like its plain picture.
// B-076: a side-browser tab watched from another PC (RemoteWebTab.tsx) is always this surface, its frame without an
// agent and its ring in the remote color (`ring`); a picture appearing there never takes the keyboard (`autoFocus`
// false – only a click on it does) and the pane's tab shortcuts stay the app's (`appKeys`).
// Owns: the frame element and its input listeners. Never: forwards input while not taken over,
// or keeps typed text (only the sender holds it until it is sent).

import type { Ref } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { BrowserFrame, BrowserInput } from '../../shared/model/browser.ts';
import { frameSrc } from './browser-feed.ts';
import { buttonOf, createInputSender, drawnArea, framePoint, keyInput, modifiersOf, pasteText, wheelPixels, type FramePoint } from './browser-input.ts';
import { touchGestures } from './browser-touch.ts';
import { BrowserKeys } from './BrowserKeys.tsx';

/** The frame the surface shows: an agent browser's, or (B-076) a side tab's from another PC – no agent there. */
export type SurfaceFrame = Pick<BrowserFrame, 'tab' | 'data' | 'width' | 'height' | 'at'> & { agentId?: string };

export interface BrowserSurfaceProps {
  frame: SurfaceFrame;
  alt: string;
  /** The person has taken the browser over: input goes to the page. */
  takeover: boolean;
  /** Sends one input for the tab the person saw (browser.input). */
  send(tab: string, input: BrowserInput): Promise<unknown>;
  onError(error: unknown): void;
  /** X02: 2 shows the picture at twice its size inside a scrolling box (touch devices). */
  zoom?: 1 | 2;
  /** X02: the hidden key field "Type" focuses. */
  keys?: Ref<HTMLInputElement>;
  /** The ring while it takes input (a CSS color; default var(--focus)). */
  ring?: string;
  /** The keyboard comes here when the takeover starts (the person pressed Take over); false: only a click on the picture brings it. */
  autoFocus?: boolean;
  /** The pane's tab shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab …) stay the app's, as in a page of this PC (pane-shortcuts.ts acts first). */
  appKeys?: boolean;
}

export function BrowserSurface(props: BrowserSurfaceProps) {
  const { frame, takeover } = props;
  const zoom = props.zoom ?? 1;
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pressed = useRef(false);
  const last = useRef<FramePoint | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const sender = useMemo(() => createInputSender((tab, input) => latest.current.send(tab, input), (error) => latest.current.onError(error)), [frame.agentId]);
  const toPage = (input: BrowserInput) => { const tab = latest.current.frame.tab; if (tab) sender.push(tab, input); };
  const gestures = useMemo(() => touchGestures({
    point: (x, y) => {
      const rect = image.current?.getBoundingClientRect();
      const size = latest.current.frame;
      return rect ? framePoint(x, y, rect, { width: size.width, height: size.height }) : undefined;
    },
    scale: () => {
      const rect = image.current?.getBoundingClientRect();
      const size = latest.current.frame;
      const area = rect ? drawnArea(rect, size) : undefined;
      return area && area.width > 0 && size.width > 0 ? size.width / area.width : 1;
    },
    zoom: () => latest.current.zoom ?? 1,
  }, toPage), [sender]);

  useEffect(() => {
    if (takeover) { if (props.autoFocus !== false) surface.current?.focus({ preventScroll: true }); }
    else { sender.clear(); pressed.current = false; gestures.cancel(); }
  }, [takeover, sender]);
  useEffect(() => () => sender.clear(), [sender]);

  // the page's own size caps the picture (workspace-browser.css letterboxes it into the room left): a
  // frame captured at the screen's scale is never shown larger than the agent's page
  const size = frame.width > 0 && frame.height > 0 ? `--frame-w: ${frame.width}px; --frame-h: ${frame.height}px` : undefined;
  const img = <img ref={image} src={frameSrc(frame)} width={frame.width || undefined} height={frame.height || undefined} style={size} alt={props.alt} draggable={false} />;
  if (!takeover) return img;

  const point = (event: MouseEvent): FramePoint | undefined => {
    const rect = image.current?.getBoundingClientRect();
    return rect ? framePoint(event.clientX, event.clientY, rect, { width: frame.width, height: frame.height }) : undefined;
  };
  const push = toPage;
  const release = (at: FramePoint | undefined, event: MouseEvent) => {
    if (!pressed.current || !at) return;
    pressed.current = false;
    push({ kind: 'mouse', type: 'up', ...at, button: buttonOf(event.button) ?? 'left', buttons: event.buttons, clicks: Math.min(Math.max(event.detail, 1), 3), modifiers: modifiersOf(event) });
  };

  return (
    <div ref={surface} tabIndex={0} role="application" class={`browser-touch${zoom === 2 ? ' browser-zoom' : ''}`} data-app-keys={props.appKeys ? '' : undefined}
      aria-label={`${props.alt}. You are using this browser: clicks and keys go to the page. Esc returns the keyboard to the app.`}
      style={{ alignSelf: 'stretch', justifySelf: 'stretch', minWidth: 0, minHeight: 0, outline: `2px solid ${props.ring ?? 'var(--focus)'}`, outlineOffset: '-2px', borderRadius: 'var(--r-lg)' }}
      onTouchStart={(event) => gestures.start(event)}
      onTouchMove={(event) => gestures.move(event)}
      onTouchEnd={(event) => { if (gestures.end(event)) event.preventDefault(); }}
      onTouchCancel={() => gestures.cancel()}
      onMouseDown={(event) => {
        surface.current?.focus({ preventScroll: true });
        const at = point(event);
        const button = buttonOf(event.button);
        if (!at || !button) return;
        event.preventDefault();
        pressed.current = true;
        last.current = at;
        push({ kind: 'mouse', type: 'down', ...at, button, buttons: event.buttons, clicks: Math.min(Math.max(event.detail, 1), 3), modifiers: modifiersOf(event) });
      }}
      onMouseUp={(event) => release(point(event) ?? last.current, event)}
      onMouseLeave={(event) => release(last.current, event)}
      onMouseMove={(event) => {
        const at = point(event);
        if (!at) return;
        last.current = at;
        push({ kind: 'mouse', type: 'move', ...at, buttons: event.buttons, modifiers: modifiersOf(event) });
      }}
      onWheel={(event) => {
        const at = point(event);
        if (!at) return;
        event.preventDefault();
        push({ kind: 'wheel', ...at, deltaX: wheelPixels(event.deltaX, event.deltaMode), deltaY: wheelPixels(event.deltaY, event.deltaMode), modifiers: modifiersOf(event) });
      }}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.target !== surface.current || event.defaultPrevented) return; // the hidden key field handles its own keys; a pane shortcut was the app's
        if (event.key === 'Escape') { surface.current?.blur(); return; }
        const input = keyInput(event, 'down');
        if (!input) return;
        event.preventDefault();
        event.stopPropagation(); // the app's shortcuts stay quiet while the person types into the page
        push(input);
      }}
      onKeyUp={(event) => {
        if (event.target !== surface.current) return;
        const input = keyInput(event, 'up');
        if (!input) return;
        event.preventDefault();
        event.stopPropagation();
        push(input);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = pasteText(event.clipboardData?.getData('text/plain') ?? '');
        if (text) push({ kind: 'text', text });
      }}>
      {img}
      {props.keys && <BrowserKeys push={push} field={props.keys} label={`Type into ${props.alt}`} />}
    </div>
  );
}
