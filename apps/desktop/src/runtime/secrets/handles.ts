// Secret handles in more sinks (B-044 decision 11): besides a browser field (browser/secret-fill.ts) an agent may put
// `secret://<id>` into the env of a command (shell.exec, secrets.run – tools/builtin/secret-run.ts), into a header
// value of web.fetch ("Bearer secret://<id>"), into a connector's call and its file (runtime/apps). The handle is
// replaced by the value at the last moment – at spawn or send – through the vault (SecretService.use), so the value
// never reaches the model.
// Rules (owner 29.10.2026, secrets as a catalog like skills, with its Nachtrag – a catalog
// with ZERO restrictions, card data included):
// * Every secret works in every sink and for every host: a password, a login's field, a card's
//   field, a key, a token, a note, a 2FA key (its current code); the summary says a command can read it.
// * The value is protected instead of refused: what comes back from a call that received values (a command's output,
//   a response, an error) is masked (`maskValues`) – each value and its base64, URL and hex forms, every piece of
//   PIECE_CHARS or more characters of it (a value printed in parts), and every base64 word that decodes to text holding
//   it (an "Authorization: Basic …" line of user:password) become its handle; a value shorter than SHORT_CHARS (a PIN,
//   a 2FA code) that shows up at all withholds the whole text, so no line of a listing can point it out. The general
//   leak redactor (tools/outputs.ts) runs after it. Only a value shorter than MIN_MASK_CHARS is refused in a command or
//   header – it works in a browser field and in a sink that returns nothing (an app sign-in, `resolveHandles`).
//   The summary says honestly what is not covered: a command can write the value elsewhere or print it changed.
// * Typing on a screen (review regress #2 – the leak guard turns a known value into its handle, so typing needs the
//   handle too): computer.type, computer.act set_value and phone.type take secret://<id> in their text, on this PC
//   only (`judgeTyped`/`typedText`): the summary says a screenshot can
//   show it where the field does not hide it; what the step returns is masked like a command's output.
// * No tool prints a value: there is no "show the secret" path, only these sinks.
// Owns: finding handles, judging them for a sink, resolving them and the per-call mask. Never: logs, returns or stores
// a value.

import type { SecretInfo } from '../../shared/model/security.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { ActionDescription, ToolContext } from '../tools/types.ts';
import { onThisPc } from '../computer/seen.ts';
import { handleFor } from './redact.ts';

const HANDLE = /secret:\/\/([A-Za-z0-9_-]{1,128})/g;
/** Environment variable names a command may get (no '=' or NUL, at most 64 characters). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_ENV = 32;
/** The shortest value a command or header takes: shorter ones cannot be masked in what comes back. */
export const MIN_MASK_CHARS = 4;
/** Pieces of a value this long or longer are masked wherever they show (a value printed in parts). */
const PIECE_CHARS = 6;
/** A value shorter than this that shows up withholds the whole text (masking one line would point it out). */
const SHORT_CHARS = 8;
const WITHHELD = '[Output withheld: it contained the value of a stored secret this call used.]';

/** The ids of the handles in `values` (each once, in order). */
export function handlesIn(values: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const value of values) for (const match of value.matchAll(HANDLE)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
}

const quoted = (value: string) => value.replace(/["\s]+/g, ' ').trim().slice(0, 60);
const nameOf = (info: SecretInfo) => (info.group ? `${info.field ?? 'field'} of ${info.group.label}` : info.label);

/** The secrets `ids` name, or why one cannot be used (only: it is not in the catalog). `host` is informational. */
export function judgeHandles(ctx: ToolContext, ids: readonly string[], _host?: string): { infos: SecretInfo[] } | { problem: string } {
  if (!ids.length) return { infos: [] };
  const all = ctx.services.secrets.list();
  const infos: SecretInfo[] = [];
  for (const id of ids) {
    const info = all.find((entry) => entry.id === id);
    if (!info) return { problem: `secret://${id} is not in the secrets catalog (secrets.list).` };
    infos.push(info);
  }
  return { infos };
}

/** The call's action with its secrets named in the summary (`command`: the summary says the command can read it). */
export function withHandles(action: ActionDescription, judged: ReturnType<typeof judgeHandles>, where: string, command = false): ActionDescription {
  if ('problem' in judged || !judged.infos.length) return action;
  const names = judged.infos.map((info) => `"${quoted(nameOf(info))}"`).join(', ');
  const one = judged.infos.length === 1;
  const reads = command ? ` – the command can read ${one ? 'it' : 'them'} and could write ${one ? 'it' : 'them'} elsewhere; only what it prints is masked` : '';
  return { ...action, summary: `${action.summary} (with the stored secret${one ? '' : 's'} ${names} ${where}${reads})` };
}

/** The forms of a value the mask looks for: raw, base64, base64url, URL-encoded and hex (each MIN_MASK_CHARS or longer). */
function forms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  return [...new Set([value, bytes.toString('base64'), bytes.toString('base64url'), encodeURIComponent(value), bytes.toString('hex')])]
    .filter((form) => form.length >= MIN_MASK_CHARS);
}

/** True when `text` holds a piece of PIECE_CHARS or more of `value` (or the whole of a shorter value). */
function holdsPiece(text: string, value: string): boolean {
  if (value.length <= PIECE_CHARS) return text.includes(value);
  for (let at = 0; at + PIECE_CHARS <= value.length; at++) if (text.includes(value.slice(at, at + PIECE_CHARS))) return true;
  return false;
}

/** `text` with every run made of pieces (PIECE_CHARS long) of `value` replaced by `handle`. */
function maskPieces(text: string, value: string, handle: string): string {
  const pieces = new Set<string>();
  for (let at = 0; at + PIECE_CHARS <= value.length; at++) pieces.add(value.slice(at, at + PIECE_CHARS));
  const covered = new Uint8Array(text.length);
  let any = false;
  for (let at = 0; at + PIECE_CHARS <= text.length; at++) {
    if (pieces.has(text.slice(at, at + PIECE_CHARS))) { covered.fill(1, at, at + PIECE_CHARS); any = true; }
  }
  if (!any) return text;
  let out = '';
  for (let at = 0; at < text.length;) {
    if (!covered[at]) { out += text[at++]; continue; }
    while (at < text.length && covered[at]) at++;
    out += handle;
  }
  return out;
}

/** Base64 words (8+ characters) whose decoded text holds a value or a piece of it, e.g. Basic auth of "user:password". */
function maskDecoded(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(/[A-Za-z0-9+/_-]{8,}={0,2}/g, (word) => {
    let decoded: string;
    try { decoded = Buffer.from(word.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return word; }
    for (const [id, value] of values) if (holdsPiece(decoded, value)) return handleFor(id);
    return word;
  });
}

/** Masks every given value in `text` (see the header): withheld when a short one shows, else whole forms, base64 words, pieces. */
export function maskValues(text: string, values: ReadonlyMap<string, string>): string {
  if (!text || !values.size) return text;
  for (const value of values.values()) if (value.length < SHORT_CHARS && text.includes(value)) return WITHHELD;
  const pairs: Array<[string, string]> = [];
  for (const [id, value] of values) for (const form of forms(value)) pairs.push([form, handleFor(id)]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [form, handle] of pairs) if (out.includes(form)) out = out.split(form).join(handle);
  out = maskDecoded(out, values);
  for (const [id, value] of values) if (value.length >= SHORT_CHARS) out = maskPieces(out, value, handleFor(id));
  return out;
}

export interface Resolved {
  /** The values with every handle replaced (for the spawn or the request only). */
  values: Record<string, string>;
  /** `text` with every value this call received replaced by its handle (see the header). */
  mask(text: string): string;
}

/** `values` with every handle replaced by its value, decrypted now by the vault (`host`: where it goes, for the log;
 * `anyLength`: a sink that returns nothing the agent reads also takes values shorter than MIN_MASK_CHARS). */
export async function resolveMasked(ctx: ToolContext, values: Record<string, string>, host?: string, anyLength = false): Promise<Resolved> {
  const ids = handlesIn(Object.values(values));
  const judged = judgeHandles(ctx, ids, host);
  if ('problem' in judged) throw new WorkforceError('forbidden', judged.problem);
  const plain = new Map<string, string>();
  for (const id of ids) {
    const value = await ctx.services.secrets.use(id, ctx.agent.id, host);
    if (value.length < MIN_MASK_CHARS && !anyLength) {
      const info = judged.infos.find((entry) => entry.id === id);
      throw new WorkforceError('forbidden', `"${quoted(info ? nameOf(info) : id)}" is shorter than ${MIN_MASK_CHARS} characters – too short to keep it out of what comes back, so it works only in a browser field (browser.act).`);
    }
    plain.set(id, value);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) out[key] = value.replace(HANDLE, (_match, id: string) => plain.get(id) ?? '');
  return { values: out, mask: (text) => maskValues(text, plain) };
}

/** A typing step's action with the secrets its text names (see the header); throws when one cannot be used here. */
export function judgeTyped(ctx: ToolContext, action: ActionDescription, text: string | undefined): ActionDescription {
  const ids = text ? handlesIn([text]) : [];
  if (!ids.length) return action;
  if (!onThisPc(ctx)) throw new WorkforceError('bad_request', 'A stored secret is typed only on this PC (a linked PC has no vault).');
  const judged = judgeHandles(ctx, ids);
  if ('problem' in judged) throw new WorkforceError('forbidden', judged.problem);
  return withHandles(action, judged, 'typed on screen – a screenshot can show it where the field does not hide it');
}

/** A typing step's text with its handles resolved now (any length: nothing typed is printed back) and the step's mask. */
export async function typedText(ctx: ToolContext, text: string): Promise<{ text: string; mask(text: string): string }> {
  if (!handlesIn([text]).length) return { text, mask: (out) => out };
  const resolved = await resolveMasked(ctx, { text }, undefined, true);
  return { text: resolved.values.text, mask: resolved.mask };
}

/** `values` with every handle replaced by its value (a sink that returns nothing the agent reads – e.g. an app sign-in). */
export async function resolveHandles(ctx: ToolContext, values: Record<string, string>, host?: string): Promise<Record<string, string>> {
  return (await resolveMasked(ctx, values, host, true)).values;
}
