// Props of a to-do widget from the text the person typed (F05). First the deterministic DE/EN
// extractors of widget-text.ts: options (choice), the first link (confirm.url, review.src),
// "Script:" or bullet points (record), the day and time (timer.at through tasks/widgets.ts
// parseWhen, and how it repeats), an amount (approve), form fields and checklist items from a
// list, and a due day or time for the other widgets (dueFromText). Then, only for props still missing,
// an optional cheap-model fill (fillWithModel, a StructuredRunner) with a JSON schema built from
// the catalog's PropSpec; every value goes through the block validator, must be found in the text
// (an option, item, field or script none of whose words the text has is dropped) and is merged.
// keywordWidget is the keyword fallback with a choice for "Pick …: A, B or C"; textWidget is that
// fallback filled from the text – what a typed to-do shows at once (tasks/human.ts addTodo).
// Owns: those rules. Never: changes a widget's type, overrides a prop that is set (only the
// placeholders – the default Yes/No options, the single free-text field, checklist items split
// from the title), invents content, makes a secret or credential field, or decides whether a
// model may run (service.ts).

import { specFor, type PropSpec, type UiBlock } from '../../shared/blocks/catalog.ts';
import { str } from '../../shared/blocks/coerce.ts';
import { validateBlock } from '../../shared/blocks/validate.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { foldText, tokens } from '../../shared/text/normalize.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { DEFAULT_OPTIONS, clockOf, fallbackWidget, parseDay, parseDue, parseWhen, stripUrls } from '../tasks/widgets.ts';
import { amountIn, fieldsIn, firstUrl, isCredential, listIn, optionsIn, repeatIn, scriptIn } from './widget-text.ts';

const PICK = /^(?:please |bitte )?(?:pick|choose|select|decide|which|wahle|wahl|aussuchen|entscheide\w*|welche\w*)\b/;
const DAY_END = { hour: 23, minute: 59 };

/** The keyword fallback (tasks/widgets.ts), but a choice when the text asks to pick among options it names (a reminder stays one). */
export function keywordWidget(text: string, now: number): UiBlock {
  const fallback = fallbackWidget(text, now);
  if (fallback.type === 'timer') return fallback;
  const first = (text.split(/\r?\n/)[0] ?? text).trim();
  const folded = foldText(first);
  const options = optionsIn(text);
  if (!options || !(PICK.test(folded) || (first.endsWith('?') && /\s(or|oder)\s/.test(folded)))) return fallback;
  const question = first.replace(/(?<!\d):(?!\d)[\s\S]*$/, '').trim();
  return { type: 'choice', question: excerpt(question.length >= 3 ? question : first, 120), options };
}

/** The keyword widget filled from the text: instant and deterministic (no model). */
export function textWidget(text: string, now: number): UiBlock {
  const trimmed = text.trim();
  return fillFromText(keywordWidget(trimmed, now), trimmed, now);
}

/** The block with the props the text gives filled in (set ones stay; see the header). */
export function fillFromText(block: UiBlock, text: string, now: number): UiBlock {
  const out: UiBlock = { ...block };
  const set = (name: string, value: unknown) => { if (value !== undefined) out[name] = value; };
  switch (block.type) {
    case 'choice': if (placeholderOptions(block.options)) set('options', optionsIn(text)); break;
    case 'checklist': set('items', listIn(text) ?? (count(block.items) < 2 ? lines(text) : undefined)); break; // derived from the title before
    case 'confirm': if (!str(block.url)) set('url', firstUrl(text)); break;
    case 'review': if (!str(block.src)) set('src', firstUrl(text)); break;
    case 'approve': if (!block.amount) set('amount', amountIn(text)); break;
    case 'form': { const fields = fieldsIn(text); if (fields && placeholderFields(block.fields)) set('fields', validProp(block, 'fields', fields)); break; }
    case 'record':
      if (!str(block.script) && !Array.isArray(block.bullets)) { const script = scriptIn(text); set('script', script); if (!script) set('bullets', listIn(text)); }
      break;
    case 'timer': {
      if (!str(block.at) && !str(block.duration)) {
        const when = parseWhen(text, now);
        set('at', when.at === undefined ? undefined : new Date(when.at).toISOString());
        set('duration', when.duration);
      }
      if (!block.repeat) set('repeat', repeatIn(text));
      break;
    }
  }
  return shaped(out);
}

/**
 * The block as the renderers read it – the validator's shapes (choice options {label, value},
 * checklist items {text, done}, form fields with names); one it refuses (a review without src) as it is.
 */
export function shaped(block: UiBlock): UiBlock {
  const checked = validateBlock(block);
  if (!checked.ok) return block;
  const { todo: _ingestOnly, ...rest } = checked.block;
  return rest as UiBlock;
}

/**
 * When a to-do (not a timer – its ring is its due time) is due by the text: the day it names at
 * its clock time, else at the day's end; a clock time alone ("at 17:00") is the next such time.
 */
export function dueFromText(text: string, now: number): number | undefined {
  const day = parseDay(text, now);
  const clock = clockOf(foldText(stripUrls(text)), true);
  if (day === undefined && !clock) return undefined;
  const due = new Date(day ?? now);
  due.setHours((clock ?? DAY_END).hour, (clock ?? DAY_END).minute, 0, 0);
  if (day === undefined && due.getTime() <= now) due.setDate(due.getDate() + 1); // "at 9" after 9 → tomorrow
  return due.getTime() > now ? due.getTime() : undefined;
}

// ------------------------------------------------------------------ model fill

const FILL_SYSTEM = [
  'I fill in parts of one to-do widget from the text a person typed for themselves.',
  'I take what the text says: an option, item, field, time or amount it does not say is null, not invented.',
  'I keep the person\'s wording and language. My reply is JSON that matches the schema, nothing else.',
].join('\n');
const FILL_KINDS = ['text', 'longtext', 'number', 'date', 'time', 'toggle', 'email', 'url']; // no 'select': the schema gives no options
/** Props whose catalog PropSpec is too loose for a schema (object, object[], a time as text). */
const SHAPES: Record<string, Record<string, unknown>> = {
  'form.fields': { type: ['array', 'null'], items: { type: 'object', additionalProperties: false, required: ['label', 'kind'], properties: { label: { type: 'string' }, kind: { type: 'string', enum: FILL_KINDS } } } },
  'approve.amount': { type: ['object', 'null'], additionalProperties: false, required: ['value', 'currency'], properties: { value: { type: 'number' }, currency: { type: 'string', description: 'ISO 4217 code' } } },
  'timer.at': { type: ['string', 'null'], description: 'local date and time, ISO 8601 like 2026-10-25T09:00' },
};
const TIME_WORDS = /\b(morning|afternoon|evening|noon|tonight|night|week|weekend|month|vormittag|nachmittag|abend|mittag|nacht|woche|wochenende|monat)\b/;

/** Props a model may still fill: missing or placeholder ones the text can give. */
export function gapsOf(block: UiBlock, text: string): string[] {
  switch (block.type) {
    case 'choice': return placeholderOptions(block.options) ? ['options', 'multi'] : [];
    case 'checklist': return count(block.items) < 2 ? ['items'] : [];
    case 'form': return placeholderFields(block.fields) ? ['fields'] : [];
    case 'timer': return !str(block.at) && !str(block.duration) && (/\d/.test(text) || TIME_WORDS.test(foldText(text))) ? ['at', 'repeat'] : [];
    case 'record': return !str(block.script) && !Array.isArray(block.bullets) && /\n|:/.test(text.trim()) ? ['script', 'bullets'] : [];
    case 'approve': return !block.amount && /\d/.test(text) ? ['amount'] : [];
    default: return [];
  }
}

/** The JSON schema for `gaps` of a block type, from the catalog's PropSpec (every prop nullable: null = the text does not say). */
export function fillSchema(type: string, gaps: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of gaps) {
    const prop = specFor(type)?.props[name];
    if (prop) properties[name] = SHAPES[`${type}.${name}`] ?? propSchema(prop);
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

function propSchema(prop: PropSpec): Record<string, unknown> {
  const doc = prop.doc ? { description: prop.doc } : {};
  switch (prop.type) {
    case 'string': return { type: ['string', 'null'], ...(prop.values ? { enum: [...prop.values, null] } : {}), ...doc };
    case 'number': return { type: ['number', 'null'], ...doc };
    case 'boolean': return { type: ['boolean', 'null'], ...doc };
    default: return { type: ['array', 'null'], items: { type: 'string' }, ...doc }; // string[] and the ask blocks' option/item lists
  }
}

/** The cheap model fills the block's gaps; nothing to fill or no usable answer → the block as it was. */
export async function fillWithModel(
  run: StructuredRunner, block: UiBlock, text: string, options: { now: number; redact?: (text: string) => string; signal?: AbortSignal },
): Promise<UiBlock> {
  const gaps = gapsOf(block, text);
  const spec = specFor(block.type);
  if (!gaps.length || !spec) return block;
  const said = options.redact ? options.redact(text) : text;
  const prompt = [`Widget: ${spec.signature} – ${spec.doc}`, `Fill: ${gaps.join(', ')}`, `Now: ${localStamp(options.now)}`, '', 'Text:', said.slice(0, 2000)].join('\n');
  const result = await run({ purpose: 'widget-fill', system: FILL_SYSTEM, prompt, schema: fillSchema(block.type, gaps), signal: options.signal });
  const answer = answerOf(result);
  return answer ? mergeFill(block, answer, gaps, said, options.now) : block;
}

/** The model's values for `gaps`, validated, found in the text and merged (anything else is dropped). */
export function mergeFill(block: UiBlock, answer: Record<string, unknown>, gaps: string[], text: string, now: number): UiBlock {
  const words = tokens(text);
  const out: UiBlock = { ...block };
  for (const name of gaps) {
    if (name === 'multi' && out.options === block.options) continue; // "pick several" only with the options it fills
    let value = answer[name] === null || answer[name] === undefined ? undefined : validProp(block, name, answer[name]);
    if (name === 'fields' && Array.isArray(value)) value = value.flatMap(fillField);
    if (Array.isArray(value)) {
      const kept = value.filter((item) => grounded(labelOf(item), words) && !(name === 'fields' && isCredential(labelOf(item))));
      value = kept.length >= (name === 'fields' || name === 'bullets' ? 1 : 2) ? kept : undefined;
    } else if (value !== undefined && name === 'script') value = grounded(String(value), words, 0.6) ? value : undefined;
    else if (value !== undefined && name === 'at') value = futureTime(String(value), now);
    else if (value !== undefined && name === 'amount') value = text.replace(/\D/g, '').includes(String(Math.trunc((value as { value: number }).value))) ? value : undefined;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

// ------------------------------------------------------------------ helpers

/** One prop as the block validator shapes it within `block`, or undefined when it is invalid there. */
function validProp(block: UiBlock, name: string, value: unknown): unknown {
  const checked = validateBlock({ ...block, [name]: value });
  return checked.ok ? checked.block[name] : undefined;
}

/**
 * A form field the model made, as the fill may keep it: only name, label and a FILL_KINDS kind –
 * a secret one (kind 'secret', 'password', 'token' …) is dropped, any other kind ('select' without
 * options) becomes text, and a value, option or flag it added falls away (the schema is a hint
 * only: answerOf also reads JSON from free text).
 */
function fillField(field: unknown): Array<{ name: unknown; label: unknown; kind: string }> {
  const { name, label, kind } = field as { name?: unknown; label?: unknown; kind?: unknown };
  if (kind === 'secret') return [];
  return [{ name, label, kind: typeof kind === 'string' && FILL_KINDS.includes(kind) ? kind : 'text' }];
}

function answerOf(result: { text: string; structured?: unknown }): Record<string, unknown> | undefined {
  if (result.structured && typeof result.structured === 'object' && !Array.isArray(result.structured)) return result.structured as Record<string, unknown>;
  try { return JSON.parse(/\{[\s\S]*\}/.exec(result.text)?.[0] ?? '') as Record<string, unknown>; } catch { return undefined; }
}

/** At least `share` of the label's words are in the text (stems: "tickets" ↔ "ticket"); yes/no answers always are. */
function grounded(label: string, words: string[], share = 0.5): boolean {
  const own = tokens(label).filter((token) => !/^(yes|no|ja|nein)$/.test(token));
  if (!own.length) return label.trim() !== '';
  const found = own.filter((token) => words.some((word) => word.startsWith(token) || (word.length >= 4 && token.startsWith(word))));
  return found.length / own.length >= share;
}

function labelOf(item: unknown): string {
  if (typeof item === 'string') return item;
  const value = item as { label?: unknown; text?: unknown } | null;
  return String(value?.label ?? value?.text ?? '');
}

function futureTime(value: string, now: number): string | undefined {
  const at = parseDue(value, now);
  return at !== undefined && at > now && at < now + 400 * 86_400_000 ? new Date(at).toISOString() : undefined;
}

const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);

/** Lines, commas or semicolons as items – two or more, else none. */
function lines(text: string): string[] | undefined {
  const items = text.split(/\r?\n|,|;/).map((item) => item.trim()).filter(Boolean);
  return items.length >= 2 ? items.slice(0, 20) : undefined;
}

function placeholderOptions(options: unknown): boolean {
  if (!Array.isArray(options) || options.length < 2) return true;
  return options.length === DEFAULT_OPTIONS.length && options.every((option, index) => labelOf(option) === DEFAULT_OPTIONS[index]);
}

function placeholderFields(fields: unknown): boolean {
  if (!Array.isArray(fields) || fields.length === 0) return true;
  const only = fields[0] as { name?: unknown; kind?: unknown };
  return fields.length === 1 && only.name === 'text' && only.kind === 'longtext';
}

/** "2026-10-20T14:05 (Tuesday)" in local time, for the model's "now". */
function localStamp(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())} (${weekday})`;
}
