// B-055 Q5: the tour's scene at one moment – the example app (AppMock.tsx) and over it what the timeline
// says shows now: the feedback menu under the cell (text field with mic, the checked "Screenshot" box,
// its thumbnail, "Paint over anything private.", Send), the slim waveform while the cell is held
// ("Listening…"), the Screenshot tooltip, the paint-over editor with the black pen's stroke, and the big
// cursor with its click ring. It imitates the live feedback cell's look (track B builds the real one)
// but uses no live component, store or call – only the CSS tokens – so it follows light and dark, never
// disturbs live operation and never breaks when the live UI is rebuilt. Pure rendering of a TourState
// (timeline.ts): the same t draws the same picture, so playing and scrubbing look alike. Every entry
// animation is computed from the state's ages, never a CSS transition.
// Owns: this drawing. Never: time, input or the player's controls (TourPlayer.tsx).

import { AppMock, place, type CellLook } from './AppMock.tsx';
import { TourIcon } from './icons.tsx';
import {
  CURSOR_SIZE, EDITOR, EDITOR_PART, MENU, MENU_PART, PEN, SCENE_H, SCENE_W, SHOT, THUMB_SCALE, WAVE, type Rect,
} from './scene-layout.ts';
import { PAINT_PATH, RIPPLE_MS, SCREENSHOT_TIP, WORDS, type Toggle, type TourState } from './timeline.ts';
import type { Point } from '../../shared/model/pointer-motion.ts';

const fade = (toggle: Toggle, ms = 140) => Math.min(1, toggle.age / ms);
/** An entry: fades in and rises a few units, from the toggle's age. */
const enter = (toggle: Toggle, rise = 4) => {
  const k = fade(toggle);
  return { opacity: String(k), transform: `translateY(${((1 - k) * -rise).toFixed(2)}px)` };
};

/** The painted stroke over a screenshot (shot units), its first `count` points and the pen's tip. */
function Ink(props: { count: number; tip: Point | null }) {
  if (props.count === 0 && !props.tip) return null;
  const points = PAINT_PATH.slice(0, props.count).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  if (props.tip) points.push(`${props.tip.x.toFixed(1)},${props.tip.y.toFixed(1)}`);
  return (
    <svg class="tour-ink" viewBox={`0 0 ${SCENE_W} ${SCENE_H}`} width={SCENE_W} height={SCENE_H} aria-hidden="true">
      <polyline points={points.join(' ')} fill="none" stroke-width={PEN} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** The screenshot: the example app as it was when the cell was pressed (no menu, no cursor), drawn at `scale`. */
function Shot(props: { scale: number; state: TourState }) {
  return (
    <span class="tour-shot" style={{ width: `${SCENE_W * props.scale}px`, height: `${SCENE_H * props.scale}px` }}>
      <span class="tour-shot-inner" style={{ transform: `scale(${props.scale})` }}>
        <AppMock cell="idle" />
        <Ink count={props.state.paint} tip={props.state.paintTip} />
      </span>
    </span>
  );
}

function Menu(props: { state: TourState }) {
  const { state } = props;
  const shown = Math.ceil(state.words);
  const partial = shown - state.words; // 0 when the newest word is whole
  const typing = state.words > 0 && state.words < WORDS.length;
  const look = (id: string) => (state.hot === id ? (state.pressed ? ' look-down' : ' look-hot') : '');
  return (
    <div class="tour-menu" style={{ ...place(MENU), ...enter(state.menu) }}>
      <span class={`tour-textarea${state.words > 0 ? ' filled' : ''}`} style={place(MENU_PART.text)}>
        {shown === 0
          ? <span class="tour-muted">What happened, or what would you like?</span>
          : (
            <span>
              {WORDS.slice(0, shown - 1).join(' ')}{shown > 1 ? ' ' : ''}
              <span style={{ opacity: String(1 - partial) }}>{WORDS[shown - 1]}</span>
              {typing && <span class="tour-caret" />}
            </span>
          )}
      </span>
      <span class={`tour-mic${look('mic')}`} style={place(MENU_PART.mic)}><TourIcon name="microphone" size={18} /></span>
      <span class={`tour-check${look('check')}`} style={place(MENU_PART.check)}>
        <span class="tour-checkbox"><TourIcon name="check" size={12} /></span>Screenshot
      </span>
      <span class={`tour-thumb${look('thumb')}`} style={place(MENU_PART.thumb)}><Shot scale={THUMB_SCALE} state={state} /></span>
      <span class="tour-hint" style={place(MENU_PART.hint)}>Paint over anything private.</span>
      <span class="tour-status" style={{ ...place(MENU_PART.status), opacity: String(state.sent.on ? fade(state.sent, 200) : 0) }}>Sent – thank you.</span>
      <span class={`tour-button primary${look('send')}`} style={place(MENU_PART.send)}>Send</span>
    </div>
  );
}

/** The slim waveform under the held cell: bars from a fixed formula of the time (seekable). */
function Wave(props: { state: TourState }) {
  const t = props.state.wave.age;
  const bars = Array.from({ length: 13 }, (_, i) => {
    const level = Math.abs(Math.sin(t / 140 + i * 0.85)) * (0.55 + 0.45 * Math.sin(t / 430 + i * 1.7));
    return 3 + Math.max(0, level) * 13;
  });
  return (
    <div class="tour-wave" style={{ ...place(WAVE), ...enter(props.state.wave) }}>
      <span class="tour-wave-bars">{bars.map((h, i) => <span key={i} style={{ height: `${h.toFixed(1)}px` }} />)}</span>
    </div>
  );
}

/** Above the Screenshot box, its arrow pointing down at the box (the cursor's arrow lies below and right). */
function Tooltip(props: { state: TourState }) {
  const box = { x: MENU.x + MENU_PART.check.x, y: MENU.y + MENU_PART.check.y };
  const rect: Rect = { x: box.x - 14, y: box.y - 52, w: 232, h: 46 };
  return <div class="tour-tooltip" style={{ ...place(rect), opacity: String(fade(props.state.tooltip, 160)) }}>{SCREENSHOT_TIP}</div>;
}

function Editor(props: { state: TourState }) {
  const { state } = props;
  const look = (id: string) => (state.hot === id ? (state.pressed ? ' look-down' : ' look-hot') : '');
  return (
    <>
      <div class="tour-backdrop" style={{ opacity: String(fade(state.editor)) }} />
      <div class="tour-editor" style={{ ...place(EDITOR), ...enter(state.editor, 8) }}>
        <span class="tour-editor-title">Paint over</span>
        <span class="tour-cell" style={place(EDITOR_PART.close)}><TourIcon name="x" size={16} /></span>
        <span class="tour-editor-stage" style={place(EDITOR_PART.stage)} />
        <span class="tour-editor-shot" style={{ left: `${SHOT.x - EDITOR.x}px`, top: `${SHOT.y - EDITOR.y}px` }}><Shot scale={SHOT.scale} state={state} /></span>
        <span class="tour-segmented" style={place(EDITOR_PART.tools)} />
        <span class={`tour-segment current${look('pen')}`} style={place(EDITOR_PART.pen)}>Pen</span>
        <span class="tour-segment" style={place(EDITOR_PART.box)}>Box</span>
        <span class="tour-button ghost" style={place(EDITOR_PART.undo)}>Undo</span>
        <span class="tour-button ghost" style={place(EDITOR_PART.clear)}>Clear</span>
        <span class={`tour-button primary${look('done')}`} style={place(EDITOR_PART.done)}>Done</span>
      </div>
    </>
  );
}

/** The big cursor: a classic arrow (tip at the point) with a soft shadow; pressed it dips a little. */
function Cursor(props: { state: TourState }) {
  const { cursor, pressed, ripple } = props.state;
  const k = CURSOR_SIZE / 54;
  return (
    <>
      {ripple && (
        <span class="tour-ripple" style={{
          left: `${ripple.x}px`, top: `${ripple.y}px`, opacity: String(0.55 * (1 - ripple.age / RIPPLE_MS)),
          transform: `translate(-50%, -50%) scale(${(0.3 + 0.7 * (ripple.age / RIPPLE_MS)).toFixed(3)})`,
        }} />
      )}
      <span class="tour-cursor" style={{ transform: `translate(${(cursor.x - 2 * k).toFixed(2)}px, ${(cursor.y - 2 * k).toFixed(2)}px) scale(${pressed ? 0.9 : 1})` }}>
        <svg width={38 * k} height={54 * k} viewBox="0 0 38 54" aria-hidden="true">
          <path d="M2 2 L2 42 L11.5 33 L18.5 49.5 L25 46.7 L18.2 30.6 L31.5 30.6 Z" stroke-width="2.4" stroke-linejoin="round" />
        </svg>
      </span>
    </>
  );
}

export function Scene(props: { state: TourState }) {
  const { state } = props;
  const cell: CellLook = state.menu.on || state.wave.on ? (state.pressed && state.hot === 'feedback' ? 'down' : 'open')
    : state.hot === 'feedback' ? (state.pressed ? 'down' : 'hot') : 'idle';
  return (
    <div class="tour-scene" aria-hidden="true">
      <AppMock cell={cell} />
      {state.menu.on && <Menu state={state} />}
      {state.tooltip.on && state.menu.on && <Tooltip state={state} />}
      {state.editor.on && <Editor state={state} />}
      <Cursor state={state} />
      {/* over the big cursor: a real pointer is small, this one would hide the pill it holds open */}
      {state.wave.on && <Wave state={state} />}
    </div>
  );
}
