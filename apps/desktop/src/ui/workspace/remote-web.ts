// Pure helpers of the remote website tab (RemoteWebTab.tsx, B-076): the feed key of a tab on a PC and the call target
// it stands for (no device: this PC), the rule that says the same input failure only once in a while, and the send
// that refuses at once while the connection is down (what the person does offline is dropped, never sent later).
// Owns: these helpers. Never: renders, calls the runtime or keeps input.

/** The calm line in the picture's place while this window has no connection. */
export const OFFLINE = 'Offline – the page shows again when the connection is back.';

/** The feed key of `tab` on `device` (device ids never hold a '|'). */
export const remoteKey = (device: string, tab: string): string => `${device}|${tab}`;

/** The side.* target of a feed key; an empty device means this PC (no `device` sent). */
export function remoteTarget(key: string): { device?: string; tab: string } {
  const at = key.indexOf('|');
  const device = at > 0 ? key.slice(0, at) : '';
  const tab = key.slice(at + 1);
  return device ? { device, tab } : { tab };
}

/** True when `text` should be said now: it differs from the last one said, or that was `ms` or more ago. */
export function sayOnce(ms: number, now: () => number = Date.now): (text: string) => boolean {
  let last = { text: '', at: Number.NEGATIVE_INFINITY };
  return (text) => {
    const at = now();
    if (text === last.text && at - last.at < ms) return false;
    last = { text, at };
    return true;
  };
}

/** `send` while the connection is open; otherwise it fails at once, so a tap made offline never lands later on a page that changed. */
export function whileOpen<A extends unknown[], R>(open: () => boolean, send: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => (open() ? send(...args) : Promise.reject(new Error(OFFLINE)));
}
