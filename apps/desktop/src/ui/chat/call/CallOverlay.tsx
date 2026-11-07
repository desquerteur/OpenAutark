// AF-015: a call looks like a call. The call view lies over the whole window (its own layer – not a panel of the
// shell, Shell.tsx places it with the global overlays): big the agent's avatar inside a ring that pulses with its
// voice, its name, the status ("Connecting…", "Listening", "Speaking", "Working…") with the call's clock, a wave of
// who is heard (CallWave.tsx – real levels of microphone and playback), live captions, a small line about agents
// still working in the background, and the controls: Mute, Audio output, Live captions and the red Hang up.
// Minimize (or Esc) shrinks it to a small floating window – avatar, name, status, Mute, Hang up – that can be dragged
// and opens full size again on a click; it stays while the person moves through the app. The phone (PWA, same
// component) gets the same view for its narrow screen: full height with the controls at the thumb, the mini window as
// a bar under the header row.
// Owns: the view's markup, its keyboard and the mini window's place. Never: starts or ends engines itself
// (call-session.ts), or draws the levels (CallWave.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, Menu } from '../../lib/ui.tsx';
import type { IconName, MenuSection } from '../../lib/ui.tsx';
import { ChatFace, chatTitle } from '../../lib/chat-face.tsx';
import { activity, conversationMap, isMobile, knownAgentMap } from '../../lib/store.ts';
import { liveRuns, liveStatus } from '../live-text.ts';
import { CALL_TEXT, backgroundLine, callClock, clampMini, statusLine, toggledView } from './call-model.ts';
import { callCaption, callNow, callPhase, callUi, hangUp, setCallView, toggleCaptions, toggleMute } from './call-session.ts';
import type { CallUi } from './call-session.ts';
import { callSink, setCallSink, sinkSupported } from './call-levels.ts';
import { useCallLevels } from './CallWave.tsx';

const MINI_KEY = 'wf.callMini';
/** The mini window's first place: beside the rail, at the bottom (over the chat list, never over the composer's Send). */
const MINI_LEFT = 68;
const DRAG_PX = 5;

function storedMini(): { x: number; y: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(MINI_KEY) ?? 'null') as { x?: unknown; y?: unknown } | null;
    return value && typeof value.x === 'number' && typeof value.y === 'number' ? { x: value.x, y: value.y } : null;
  } catch { return null; }
}

/** The agents still working: in this chat (what they do) and how many in other chats. */
function useBackground(conversationId: string): string {
  const chat = conversationMap.value.get(conversationId);
  if (!chat) return '';
  const nameOf = (id: string) => knownAgentMap.value.get(id)?.name;
  const here = liveRuns(chat);
  const line = here.length || chat.working.length ? liveStatus(chat, undefined, here, nameOf) : ''; // always with the name: "Ava: writing the plan"
  const elsewhere = new Set(activity.value.filter((entry) => entry.conversationId && entry.conversationId !== conversationId).map((entry) => entry.agentId)).size;
  return backgroundLine(line, elsewhere);
}

/** A round control with its label under it (full view) or alone (mini). */
function Control(props: { icon: IconName; label: string; pressed?: boolean; danger?: boolean; small?: boolean; onClick: (event: MouseEvent) => void; tour?: string; expanded?: boolean }) {
  return (
    <div class={`call-control${props.danger ? ' danger' : ''}`}>
      <button type="button" class={`call-control-button${props.pressed ? ' on' : ''}`} aria-label={props.label} title={props.label}
        aria-pressed={props.pressed} aria-expanded={props.expanded} data-tour={props.tour}
        onClick={(event) => props.onClick(event as unknown as MouseEvent)}>
        <Icon name={props.icon} size={props.small ? 18 : 24} />
      </button>
      {!props.small && <span class="call-control-label" aria-hidden="true">{props.label}</span>}
    </div>
  );
}

/** The audio output menu: the outputs this browser lists (where it can switch), else a note. */
function useOutputMenu(): { anchor: HTMLElement | null; open: (event: MouseEvent) => void; close: () => void; sections: MenuSection[] } {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [chosen, setChosen] = useState(callSink());
  const open = (event: MouseEvent) => {
    const target = event.currentTarget as HTMLElement;
    if (anchor) { setAnchor(null); return; }
    setAnchor(target);
    if (!sinkSupported() || !navigator.mediaDevices?.enumerateDevices) { setOutputs([]); return; }
    void navigator.mediaDevices.enumerateDevices()
      .then((devices) => setOutputs(devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default')))
      .catch(() => setOutputs([]));
  };
  const pick = (id: string) => { setCallSink(id); setChosen(id); setAnchor(null); };
  const items = [
    { label: CALL_TEXT.outputDefault, icon: 'speaker-high' as const, checked: chosen === '', onSelect: () => pick('') },
    ...outputs.map((device, index) => ({ label: device.label || `Output ${index + 1}`, checked: chosen === device.deviceId, onSelect: () => pick(device.deviceId) })),
  ];
  const sections: MenuSection[] = [{ title: CALL_TEXT.output, items }];
  if (!sinkSupported()) sections.push({ items: [{ label: CALL_TEXT.outputOnlyDefault, disabled: true, onSelect: () => undefined }] });
  return { anchor, open, close: () => setAnchor(null), sections };
}

function CallFull(props: { ui: CallUi }) {
  const { ui } = props;
  const root = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const phase = callPhase.value;
  useCallLevels(root, wave, phase, ui.muted);
  const chat = conversationMap.value.get(ui.conversationId);
  const name = chat ? chatTitle(chat) : CALL_TEXT.call;
  const clock = callClock(ui.connectedAt, callNow.value);
  const background = useBackground(ui.conversationId);
  const caption = callCaption.value;
  const output = useOutputMenu();
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => root.current?.focus({ preventScroll: true })); // the view itself: no ring on a button nobody chose; Tab goes on to its controls
    return () => { if (returnTo?.isConnected) returnTo.focus({ preventScroll: true }); };
  }, []);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !output.anchor) { event.preventDefault(); setCallView('mini'); return; }
    if (event.key !== 'Tab' || !root.current) return; // the focus stays inside the call view while it covers the window
    const focusable = [...root.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : (at === focusable.length - 1 ? 0 : at + 1);
    if (focusable[next]) { event.preventDefault(); focusable[next].focus(); }
  };
  return (
    <div class="call-view full" ref={root} role="dialog" aria-modal="true" tabIndex={-1} aria-label={CALL_TEXT.callWith(name)} data-phase={phase} data-speaker="none" onKeyDown={onKey}>
      <div class="call-top">
        <button type="button" class="call-top-button" aria-label={CALL_TEXT.minimize} title={CALL_TEXT.minimize} onClick={() => setCallView('mini')}>
          <Icon name="picture-in-picture" size={20} />
        </button>
        <span class="call-top-title">{CALL_TEXT.call}</span>
      </div>
      <div class="call-stage">
        <div class="call-face">
          <span class="call-ring" aria-hidden="true" />
          <span class="call-ring outer" aria-hidden="true" />
          {chat ? <ChatFace chat={chat} size={isMobile.value ? 112 : 136} /> : <span class="call-face-empty"><Icon name="phone" size={48} /></span>}
        </div>
        <h2 class="call-name">{name}</h2>
        <p class="call-status tabular" role="status" aria-live="polite">
          {ui.muted && <span class="call-muted-badge"><Icon name="microphone-slash" size={14} />{CALL_TEXT.muted}</span>}
          <span>{statusLine(phase, clock)}</span>
        </p>
        <canvas class="call-wave" ref={wave} aria-hidden="true" />
        {ui.captions && (
          <div class="call-captions" aria-live="polite">
            {caption
              ? <p data-who={caption.who}><strong>{caption.name}</strong> {caption.text}</p>
              : <p class="call-captions-empty">{CALL_TEXT.nothingYet}</p>}
          </div>
        )}
        {background && <p class="call-background"><span class="call-background-dot" aria-hidden="true" />{background}</p>}
      </div>
      <div class="call-controls" role="group" aria-label="Call controls">
        <Control icon={ui.muted ? 'microphone-slash' : 'microphone'} label={ui.muted ? CALL_TEXT.unmute : CALL_TEXT.mute} pressed={ui.muted} onClick={toggleMute} />
        <Control icon="speaker-high" label={CALL_TEXT.output} expanded={output.anchor !== null} onClick={output.open} />
        <Control icon={ui.captions ? 'subtitles' : 'subtitles-slash'} label={ui.captions ? CALL_TEXT.captionsOn : CALL_TEXT.captionsOff} pressed={ui.captions} onClick={toggleCaptions} />
        <Control icon="phone-disconnect" label={CALL_TEXT.hangUp} danger onClick={hangUp} />
      </div>
      <Menu anchor={output.anchor} open={output.anchor !== null} onClose={output.close} placement="top-start" label={CALL_TEXT.output} sections={output.sections} class="call-output-menu" />
    </div>
  );
}

function CallMini(props: { ui: CallUi }) {
  const { ui } = props;
  const root = useRef<HTMLDivElement>(null);
  const none = useRef<HTMLCanvasElement>(null);
  const phase = callPhase.value;
  useCallLevels(root, none, phase, ui.muted);
  const chat = conversationMap.value.get(ui.conversationId);
  const name = chat ? chatTitle(chat) : CALL_TEXT.call;
  const clock = callClock(ui.connectedAt, callNow.value);
  const phone = isMobile.value;
  const [at, setAt] = useState<{ x: number; y: number } | null>(phone ? null : storedMini());
  // A press only becomes a drag after DRAG_PX (then the window takes the pointer); a tap stays a click on its button.
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null);
  useLayoutEffect(() => { // keep the stored place inside the window
    const element = root.current;
    if (!element || phone) return;
    const place = () => {
      const box = element.getBoundingClientRect();
      const start = at ?? { x: MINI_LEFT, y: innerHeight - box.height - 16 }; // first: bottom left, clear of the chat's header, status lines and send
      const kept = clampMini(start, box, { width: innerWidth, height: innerHeight });
      if (!at || kept.x !== at.x || kept.y !== at.y) setAt(kept);
    };
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [at, phone]);
  const down = (event: PointerEvent) => {
    if (phone || event.button !== 0 || (event.target as HTMLElement).closest('.call-control-button')) return;
    const box = root.current!.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
  };
  const move = (event: PointerEvent) => {
    const grab = drag.current;
    const element = root.current;
    if (!grab || !element) return;
    if (!grab.moved) {
      if (Math.hypot(event.clientX - grab.x, event.clientY - grab.y) < DRAG_PX) return;
      grab.moved = true;
      element.setPointerCapture(event.pointerId); // from here the window follows the pointer; the release is no click
    }
    const box = element.getBoundingClientRect();
    setAt(clampMini({ x: event.clientX - grab.dx, y: event.clientY - grab.dy }, box, { width: innerWidth, height: innerHeight }));
  };
  const up = () => {
    const grab = drag.current;
    drag.current = null;
    if (grab?.moved && at) { try { localStorage.setItem(MINI_KEY, JSON.stringify(at)); } catch { /* storage may be blocked */ } }
  };
  const style = !phone && at ? { left: `${at.x}px`, top: `${at.y}px` } : undefined;
  return (
    <div class={`call-view mini${phone ? ' phone' : ''}`} ref={root} role="region" aria-label={CALL_TEXT.callWith(name)} data-phase={phase} data-speaker="none" style={style}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <button type="button" class="call-mini-open" aria-label={CALL_TEXT.expand} title={CALL_TEXT.expand} onClick={() => setCallView(toggledView('mini'))}>
        <span class="call-face small">
          <span class="call-ring" aria-hidden="true" />
          {chat ? <ChatFace chat={chat} size={36} /> : <Icon name="phone" size={20} />}
        </span>
        <span class="call-mini-text">
          <span class="call-mini-name">{name}</span>
          <span class="call-mini-status tabular">{ui.muted && <Icon name="microphone-slash" size={12} />}{statusLine(phase, clock)}</span>
        </span>
      </button>
      <div class="call-mini-controls">
        <Control small icon={ui.muted ? 'microphone-slash' : 'microphone'} label={ui.muted ? CALL_TEXT.unmute : CALL_TEXT.mute} pressed={ui.muted} onClick={toggleMute} />
        <Control small icon="phone-disconnect" label={CALL_TEXT.hangUp} danger onClick={hangUp} />
      </div>
    </div>
  );
}

/** The call view of this device's call (nothing while no call is open). */
export function CallOverlay() {
  const ui = callUi.value;
  if (!ui) return null;
  return ui.view === 'full' ? <CallFull key={`full-${ui.startedAt}`} ui={ui} /> : <CallMini key={`mini-${ui.startedAt}`} ui={ui} />;
}
