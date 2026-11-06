// Key presses for the side driver – "Enter", "Shift+Tab", "Control+A", "ArrowDown", "a" –
// as the DevTools protocol's Input.dispatchKeyEvent events (modifiers down, the key, modifiers up).
// Owns: the key names, their codes and the event sequence. Never: sends anything (pure).

interface KeyDef { key: string; code: string; keyCode: number; text?: string; location?: number }

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
};
for (let n = 1; n <= 12; n += 1) NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

const ALIAS: Record<string, string> = {
  esc: 'Escape', return: 'Enter', ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', super: 'Meta',
  option: 'Alt', alt: 'Alt', shift: 'Shift', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', del: 'Delete',
  space: 'Space', spacebar: 'Space', pgup: 'PageUp', pgdn: 'PageDown', ins: 'Insert',
};
/** Input.dispatchKeyEvent modifier bits. */
const MOD_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export interface KeyPlan { modifiers: KeyDef[]; main: KeyDef; mask: number }

function named(token: string): KeyDef | undefined {
  const exact = NAMED[token] ?? NAMED[ALIAS[token.toLowerCase()] ?? ''];
  if (exact) return exact;
  const ci = Object.keys(NAMED).find((name) => name.toLowerCase() === token.toLowerCase());
  return ci ? NAMED[ci] : undefined;
}

function char(ch: string, shift: boolean): KeyDef {
  const upper = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { key: shift ? upper : ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: shift ? upper : ch };
  if (/^\d$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  return { key: ch, code: '', keyCode: 0, text: ch };
}

/** "Control+Shift+A" → modifiers and the key; null when a part is unknown. A lone "+" is the plus key. */
export function parseKey(input: string): KeyPlan | null {
  const text = input.trim();
  if (!text) return null;
  const parts = text === '+' ? ['+'] : text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
  if (parts.some((part) => !part)) return null;
  const modifiers: KeyDef[] = [];
  let mask = 0;
  for (const part of parts.slice(0, -1)) {
    const def = named(part);
    if (!def || !(def.key in MOD_BIT)) return null;
    if (!(mask & MOD_BIT[def.key]!)) { modifiers.push(def); mask |= MOD_BIT[def.key]!; }
  }
  const last = parts[parts.length - 1]!;
  const main = [...last].length === 1 ? char(last, Boolean(mask & 8)) : named(last);
  if (!main) return null;
  return { modifiers, main, mask };
}

/** The events of one press, in order. Text only when no Control/Alt/Meta is held (a shortcut types nothing). */
export function keyEvents(plan: KeyPlan): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let held = 0;
  const base = (def: KeyDef) => ({ key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, ...(def.location ? { location: def.location } : {}) });
  for (const mod of plan.modifiers) { held |= MOD_BIT[mod.key]!; out.push({ type: 'rawKeyDown', modifiers: held, ...base(mod) }); }
  const text = plan.mask & 7 ? undefined : plan.main.text;
  out.push({ type: text ? 'keyDown' : 'rawKeyDown', modifiers: held, ...base(plan.main), ...(text ? { text, unmodifiedText: text } : {}) });
  out.push({ type: 'keyUp', modifiers: held, ...base(plan.main) });
  for (const mod of [...plan.modifiers].reverse()) { held &= ~MOD_BIT[mod.key]!; out.push({ type: 'keyUp', modifiers: held, ...base(mod) }); }
  return out;
}

/** Enter accepts an open page dialog, Escape dismisses it. */
export function dialogAnswer(plan: KeyPlan): boolean | undefined {
  if (plan.mask) return undefined;
  return plan.main.key === 'Enter' ? true : plan.main.key === 'Escape' ? false : undefined;
}
