// Identifier helpers shared by every layer.
// Owns: the id format (`<prefix>_<time><random>`, lexicographically time-sortable).
// Never: depends on Node, DOM or Electron APIs other than the global Web Crypto.

export type IdPrefix =
  | 'sp' // space (company, brand, private …)
  | 'ag' // agent
  | 'ch' // conversation (chat)
  | 'msg' // message
  | 'task'
  | 'sch' // schedule
  | 'wk' // wake
  | 'kn' // knowledge item
  | 'acc' // provider account
  | 'run' // agent run (one turn or a chain of turns)
  | 'ri' // run item (tool call, effect …)
  | 'apr' // approval
  | 'sec' // secret
  | 'dev' // device
  | 'fb' // feedback report
  | 'cu' // customization request
  | 'tok' // access token (PWA / peer)
  | 'up' // upload session
  | 'spd' // spend ledger entry
  | 'br' // chat bridge (Telegram …)
  | 'src' // knowledge source (KS1: a folder, file or bundled corpus)
  | 'sdoc' // document of a knowledge source (KS1)
  | 'area' // knowledge area (KS1)
  | 'sjob' // embedding job of knowledge sources (KS1)
  | 'ref' // reference of a person's words, reasons or corrections (F-52, runtime/references)
  | 'rdr' // representation draft request (F-52)
  | 'call' // live call of a chat (runtime/calls)
  | 'rts' // realtime speech session of a call (runtime/calls/realtime)
  | 'per' // a person of the organisation other than the owner (F-52, runtime/people)
  | 'cev' // calendar row: an event or a to-do's time block (B-041, runtime/calendar)
  | 'cal' // connected calendar source: ICS link or Google (B-041, runtime/calendar/sources)
  | 'sgr' // split group: one agents.split call (B-057, runtime/splits)
  | 'spl' // split: one part of a split group (B-057, runtime/splits)
  | 'req'; // UI request/session nonce (also in opaque frames and plain-HTTP phone pages)

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

function encodeTime(ms: number): string {
  let out = '';
  let value = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 9; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomPart(length: number): string {
  const bytes = new Uint8Array(length);
  (globalThis as unknown as { crypto: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return out;
}

/** Creates a new id such as `task_01jab3k9z7mx2c4q`. Sortable by creation time. */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${randomPart(8)}`;
}

/** True when `value` looks like an id with the given prefix. */
export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^([a-z]{2,4})_[0-9a-z]{10,40}$/.exec(value);
  return Boolean(match && (!prefix || match[1] === prefix));
}

/** The fixed member id of the human owner (the CEO). */
export const HUMAN_ID = 'human';
/** Author id used for system/status lines. */
export const SYSTEM_ID = 'system';
