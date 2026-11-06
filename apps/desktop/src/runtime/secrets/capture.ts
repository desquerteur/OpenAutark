// Secret form fields typed by the person (PM6): before an answer to a `form` ask reaches the task
// service, every secret field's value is stored encrypted in the vault – for every agent (owner 29.10.2026: a general
// store like skills; the person narrows it in Settings), with the field's `domain` as its source (provenance, never a
// binding – the secret works everywhere, card data included) – and replaced by its handle `secret://<id>`. All answer paths use it: blocks.answer and tasks.complete (desktop
// and PWA) and a linked PC's answer (devices/linked-todos.ts), through answerWithSecrets. A connection that is
// not secure (a phone on plain LAN http) is refused before anything is stored. Retries never
// pile up copies: a to-do that is already answered stores nothing (its typed values are dropped),
// every field is checked before any is stored, a secret's id is fixed per to-do (or block) and
// field so a repeat replaces it, and secrets added for an answer that then fails are removed.
// X05: a 2FA setup key (an otpauth://totp link, or a value that parses in a field with a 2FA word)
// is stored as kind 'totp' – a field named like a setup key (a 2FA word and key, secret, seed,
// setup, URI or link) whose value does not parse stores nothing –, and two or more typed secret
// fields of one form whose domains agree (or are all absent) become ONE group (login, card or
// other – the person's: the asking agent may use it but not change it unasked, so no created_by)
// with an id fixed per to-do, so a retry replaces it; a failed answer removes the group it
// created too. A one-time code is not a seed: a field whose name or label says "code" ("TOTP
// code") is never a setup key, and 6–8 typed digits are stored as a password, never refused.
// Owns: finding the form an answer belongs to (the to-do's widget, or the message's block in
// both numberings), the secret kind guess, the label and the replacement. Never: logs, returns or
// passes on a typed value; keeps a value when storing it failed.

import { createHash } from 'node:crypto';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { uiBlocksOf } from '../../shared/blocks/parse.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { SecretInfo } from '../../shared/model/security.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import { blockTodo } from '../tasks/block-todo.ts';
import { registrableDomain } from './service.ts';
import { parseTotp } from './totp.ts';

export type AnswerRef = { taskId: string } | { messageId: string; blockIndex: number };

/** Plain-LAN refusal: the value would have crossed the network unencrypted. */
export const INSECURE = 'Secrets can only be entered over HTTPS or on the PC. Open the app through its HTTPS address.';

interface SecretField { name: string; label: string; domain?: string }
interface FormSource { title?: string; authorId?: string; fields: SecretField[]; why?: string }

/** The form's one-line reason (`why`) as the entry's description – what tips and skill search match on. */
const whyOf = (block: unknown): string | undefined => {
  const why = (block as { why?: unknown } | undefined)?.why;
  return typeof why === 'string' && why.trim() ? why.trim().slice(0, 500) : undefined;
};

type Services = Pick<RuntimeServices, 'tasks' | 'chats' | 'org' | 'secrets' | 'log'> & Partial<Pick<RuntimeServices, 'db'>>;

const HANDLE = /^secret:\/\/[A-Za-z0-9_-]{1,64}$/;

const wording = (field: { name?: string; label?: string }) => `${field.name ?? ''} ${field.label ?? ''}`;
/** A field about a one-time code ("TOTP code", "6-digit code") – never a setup key ("the key under the QR code" still is one). */
const CODE_WORD = /(?<!qr[ -]?)code/i;
const TWO_FA_WORD = /setup.?key|authenticator|2fa|two.?factor|mfa|otp/i;
const KEY_WORD = /key|secret|seed|setup|uri|url|link/i;
/** What a person types for a one-time code: stored as a password, never refused as a bad key. */
const ONE_TIME_CODE = /^\s*\d{6,8}\s*$/;

/** A field named like a 2FA setup key: a 2FA word and a key word, never "code" (see the header). */
export function totpLabelled(field: { name?: string; label?: string }): boolean {
  const text = wording(field);
  return !CODE_WORD.test(text) && TWO_FA_WORD.test(text) && KEY_WORD.test(text);
}

const isOtpauth = (value: unknown) => typeof value === 'string' && /^\s*otpauth:\/\/totp\//i.test(value);

/** Secret kind from the field's wording (the store only needs a coarse category); X05: 'totp' for a setup key that parses. */
export function secretKind(field: { name?: string; label?: string }, value?: string): SecretInfo['kind'] {
  const words = wording(field);
  if (isOtpauth(value) || (value !== undefined && !CODE_WORD.test(words) && TWO_FA_WORD.test(words) && parses(value))) return 'totp';
  const text = words.toLowerCase();
  if (/card|karte|iban|cvc|cvv/.test(text)) return 'card';
  if (/api.?key|apikey/.test(text)) return 'api_key';
  if (/token/.test(text)) return 'token';
  return 'password';
}

function secretFields(block: UiBlock | undefined): SecretField[] {
  if (block?.type !== 'form' || !Array.isArray(block.fields)) return [];
  return (block.fields as Array<Record<string, unknown>>)
    .filter((field) => field?.kind === 'secret' && typeof field.name === 'string')
    .map((field) => ({
      name: String(field.name), label: typeof field.label === 'string' && field.label ? field.label : String(field.name),
      ...(typeof field.domain === 'string' && field.domain ? { domain: field.domain } : {}),
    }));
}

/** The agent behind an id (undefined for the person, the system or an unknown id). */
function agentOf(s: Services, id: string | undefined): string | undefined {
  if (!id) return undefined;
  try { return s.org.get(id) ? id : undefined; } catch { return undefined; }
}

/**
 * The forms an answer goes to. A message's ask block is looked up at that parse index and at
 * that position of the valid blocks (the numbering its to-do was created with): a field that is
 * secret in either is treated as secret.
 */
export function formsOf(s: Services, ref: AnswerRef): FormSource[] {
  if ('taskId' in ref) {
    const task = s.tasks.get(ref.taskId);
    const fields = secretFields(task?.widget);
    return fields.length ? [{ title: task?.widget?.title ?? task?.title, authorId: agentOf(s, task?.createdBy), fields, why: whyOf(task?.widget) }] : [];
  }
  const message = s.chats.message(ref.messageId);
  if (!message) return [];
  const blocks = uiBlocksOf(message.body);
  const authorId = message.authorKind === 'agent' ? agentOf(s, message.authorId) : undefined;
  return [blocks.find((item) => item.index === ref.blockIndex)?.block, blocks[ref.blockIndex]?.block]
    .map((block) => ({ title: block?.title, authorId, fields: secretFields(block), why: whyOf(block) }))
    .filter((form) => form.fields.length > 0);
}

/** The to-do the answer goes to, found like tasks.answer finds it (undefined without one). */
function todoOf(s: Services, ref: AnswerRef): Pick<Task, 'id' | 'status' | 'result'> | undefined {
  if ('taskId' in ref) return s.tasks.get(ref.taskId);
  return s.db ? blockTodo({ db: s.db, chats: s.chats }, ref.messageId, ref.blockIndex) : undefined;
}

function parses(value: string): boolean {
  try { parseTotp(value); return true; } catch { return false; }
}

/** A fixed vault id per to-do (or block) and field: a repeated answer replaces, never adds. */
export function secretIdFor(target: string, field: string): string {
  return `sec_${createHash('sha256').update(`${target}\n${field.toLowerCase()}`).digest('hex').slice(0, 24)}`;
}

/** X05: the fixed id of the group a form's answer creates (per to-do or block). */
export function groupIdFor(target: string): string {
  return `sgr_${createHash('sha256').update(`${target}\n#group`).digest('hex').slice(0, 24)}`;
}

/** A form field name as a group field name (lower-case, a–z 0–9 _ -, starts with a letter, unique). */
function fieldName(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 36) || 'field';
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base}_${n}`;
  taken.add(out);
  return out;
}

/**
 * The answer with every typed secret stored and replaced by its handle. Values that already are
 * handles and empty fields stay as they are; field names match case-insensitively (the block
 * parser lower-cases them). Throws `forbidden` on an insecure connection when there is a value.
 * An already answered to-do stores nothing: its typed values are dropped. Ids of secrets new to
 * the vault are pushed to `created`.
 */
export async function captureSecrets(s: Services, ref: AnswerRef, answer: unknown, origin: { secure: boolean }, created: string[] = [], createdGroups: string[] = []): Promise<unknown> {
  const values = (answer as { values?: unknown } | null | undefined)?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return answer;
  const forms = formsOf(s, ref);
  if (!forms.length) return answer;
  const fieldFor = new Map<string, { field: SecretField; form: FormSource }>();
  for (const form of forms) for (const field of form.fields) if (!fieldFor.has(field.name.toLowerCase())) fieldFor.set(field.name.toLowerCase(), { field, form });

  const typed = Object.entries(values as Record<string, unknown>).filter(([name, value]) =>
    fieldFor.has(name.toLowerCase()) && value !== undefined && value !== null && value !== '' && !(typeof value === 'string' && HANDLE.test(value)));
  if (!typed.length) return answer;
  if (!origin.secure) throw new WorkforceError('forbidden', INSECURE);

  const next: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  const todo = todoOf(s, ref);
  if (todo?.status === 'done' && todo.result?.answer !== undefined) {
    for (const [name] of typed) delete next[name]; // a retry or a second device: the first answer stands
    return { ...(answer as Record<string, unknown>), values: next };
  }
  for (const [name, value] of typed) { // every field first: a refused one leaves nothing stored
    const { field } = fieldFor.get(name.toLowerCase())!;
    if (typeof value !== 'string' || value.length > 4096) throw new WorkforceError('bad_request', `"${field.label}" must be text of at most 4096 characters.`);
    if ((totpLabelled(field) || isOtpauth(value)) && !ONE_TIME_CODE.test(value) && !parses(value)) {
      try { parseTotp(value); } catch (error) { throw new WorkforceError('bad_request', `"${field.label}": ${(error as Error).message}`); }
    }
  }
  const target = todo?.id ?? ('taskId' in ref ? ref.taskId : `${ref.messageId}:${ref.blockIndex}`);
  const known = new Set(s.secrets.list().map((info) => info.id));
  const domains = new Set(typed.map(([name]) => registrableDomain(fieldFor.get(name.toLowerCase())!.field.domain)));
  if (typed.length >= 2 && domains.size === 1) {
    return { ...(answer as Record<string, unknown>), values: await captureGroup(s, typed as Array<[string, string]>, fieldFor, target, next, created, createdGroups, known) };
  }
  for (const [name, value] of typed) {
    const { field, form } = fieldFor.get(name.toLowerCase())!;
    const domain = registrableDomain(field.domain);
    const kind = secretKind(field, value as string);
    const info = await s.secrets.save({
      id: secretIdFor(target, field.name),
      label: `${form.title ? `${form.title} · ` : ''}${field.label}`.slice(0, 120),
      kind, value: value as string, ...(form.why ? { description: form.why } : {}),
      ...(domain ? { source: domain } : {}),
    });
    if (!known.has(info.id)) created.push(info.id);
    next[name] = `secret://${info.id}`;
    s.log.info('secret captured from a form answer', { secretId: info.id, agentId: form.authorId }); // never the value
  }
  return { ...(answer as Record<string, unknown>), values: next };
}

/** X05: the typed secret fields of one form as ONE group (see the header); returns the values with handles. */
async function captureGroup(
  s: Services, typed: Array<[string, string]>, fieldFor: Map<string, { field: SecretField; form: FormSource }>, target: string,
  next: Record<string, unknown>, created: string[], createdGroups: string[], known: Set<string>,
): Promise<Record<string, unknown>> {
  const form = fieldFor.get(typed[0][0].toLowerCase())!.form;
  const taken = new Set<string>();
  const fields = typed.map(([name, value]) => {
    const { field } = fieldFor.get(name.toLowerCase())!;
    return { name, id: secretIdFor(target, field.name), field: fieldName(field.name, taken), kind: secretKind(field, value), value };
  });
  const kinds = new Set(fields.map((field) => field.kind));
  const domain = registrableDomain(fieldFor.get(typed[0][0].toLowerCase())!.field.domain);
  const id = groupIdFor(target);
  const isNew = !s.secrets.groups().some((group) => group.id === id);
  const card = kinds.has('card');
  const saved = await s.secrets.saveGroup({
    id, label: (form.title ?? form.fields.map((field) => field.label).join(' · ')).slice(0, 120),
    kind: card ? 'card' : kinds.has('password') || kinds.has('totp') ? 'login' : 'other', ...(form.why ? { description: form.why } : {}),
    ...(domain ? { source: domain } : {}),
    fields: fields.map((field) => ({ id: field.id, field: field.field, kind: field.kind, value: field.value })),
  });
  if (isNew) createdGroups.push(saved.group.id);
  for (const field of fields) {
    if (!known.has(field.id)) created.push(field.id);
    next[field.name] = `secret://${field.id}`;
  }
  s.log.info('secret group captured from a form answer', { groupId: saved.group.id, fields: fields.length, agentId: form.authorId }); // never a value
  return next;
}

/**
 * Every answer path: the typed secrets are stored first, then `run` hands the answer (with
 * handles only) on; when that fails, the secrets (and X05: the groups) this call added are removed again.
 */
export async function answerWithSecrets<T>(s: Services, ref: AnswerRef, answer: unknown, origin: { secure: boolean }, run: (answer: unknown) => T): Promise<T> {
  const created: string[] = [];
  const createdGroups: string[] = [];
  const captured = await captureSecrets(s, ref, answer, origin, created, createdGroups);
  try {
    return run(captured);
  } catch (error) {
    for (const id of createdGroups) {
      try { s.secrets.removeGroup(id); } catch { s.log.warn('a secret group of a failed answer could not be removed', { groupId: id }); }
    }
    for (const id of created) {
      try { s.secrets.remove(id); } catch { s.log.warn('a secret of a failed answer could not be removed', { secretId: id }); }
    }
    throw error;
  }
}
