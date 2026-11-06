// Normalizes and validates one model-written ```ui object against the CATALOG.
// Owns: alias resolution, coercions (string→array, "12"→12, "yes"→true …), per-type item
// shaping (so renderers get one predictable shape), required-prop checks, LIMITS and the
// fileId rule (media/file keep a fileId only when it is a 64-hex blob id; a fileId stands in
// for a missing media src or file path – the runtime checks the agent may see that file).
// Order (web-genui §7.5): aliases → coercions → schema check → limits.
// HOST_ONLY_PROPS are dropped before anything else reads the input.
// Never: keeps unknown props (they are dropped silently), accepts host-only props from agent
// text (accessRequestId – built by the host only), or throws.

import { ALIASES, HOST_ONLY_PROPS, YES_NO, specFor } from './catalog.ts';
import type { BlockSpec, BlockType, UiBlock } from './catalog.ts';
import { coerce, ENUM_ALIASES, isObj, slug, str, toBool } from './coerce.ts';
import type { Obj } from './coerce.ts';
import { SHAPERS } from './shape.ts';

export type ValidateResult =
  | { ok: true; block: UiBlock; warnings: string[] }
  | { ok: false; error: string; type?: string; ask: boolean };

/** Props every block may carry. Ask blocks additionally keep todo/due/priority/why. */
const COMMON_PROPS = ['id', 'title'] as const;
/** Keys a model may use instead of "type". */
const TYPE_KEYS = ['type', 'component', 'widget', 'block', 'kind'] as const;
const FILE_ID = /^[a-f0-9]{64}$/;

/** Resolves a model-written type name to a catalog type (or a special hint). */
export function resolveType(raw: string): BlockType | 'mermaid-hint' | undefined {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (specFor(key)) return key as BlockType;
  if (key in ALIASES) return ALIASES[key];
  if (key === 'flow' || key === 'flowchart' || key === 'diagram') return 'mermaid-hint';
  if (key.endsWith('s') && specFor(key.slice(0, -1))) return key.slice(0, -1) as BlockType; // "charts"
  return undefined;
}

export function validateBlock(input: unknown, opts: { nested?: boolean } = {}): ValidateResult {
  if (!isObj(input)) return { ok: false, error: 'a ui block must be a JSON object with "type"', ask: false };
  const warnings: string[] = [];
  let rawType: string | undefined;
  for (const key of TYPE_KEYS) {
    const value = input[key];
    // "kind" is also a real prop (chart/media); only use it when it names a block type.
    if (typeof value === 'string' && (key !== 'kind' || resolveType(value))) { rawType = value; break; }
  }
  if (!rawType) return { ok: false, error: 'missing "type"', ask: false };
  const resolved = resolveType(rawType);
  if (!resolved) return { ok: false, error: `unknown type "${rawType.slice(0, 40)}"`, type: rawType, ask: false };

  const source: Obj = { ...input };
  for (const key of HOST_ONLY_PROPS) delete source[key];
  if (resolved === 'mermaid-hint') {
    // Diagrams belong in ```mermaid; show the text instead of failing.
    const text = str(source.text ?? source.description ?? source.title) ?? 'Diagram';
    return { ok: true, block: { type: 'callout', tone: 'info', text }, warnings: ['use ```mermaid for diagrams'] };
  }
  const spec = specFor(resolved) as BlockSpec;
  applyAliasDefaults(rawType.trim().toLowerCase(), spec.type, source);
  const ask = spec.kind === 'ask';
  if (ask && opts.nested) return { ok: false, error: `${spec.type} cannot be nested inside tabs`, type: spec.type, ask: true };

  const block: UiBlock = { type: spec.type };
  for (const key of COMMON_PROPS) {
    const value = str(source[key]);
    if (value) block[key] = key === 'id' ? slug(value) : value;
  }
  if (ask) {
    // B-078 D9: "todo" only when written (catalog.ts becomesTodo decides the list); "important" true or nothing.
    if (source.todo !== undefined && source.todo !== null) block.todo = toBool(source.todo) !== false;
    if (toBool(source.important) === true) block.important = true;
    const due = str(source.due);
    if (due) block.due = due;
    const priority = str(source.priority)?.toLowerCase();
    if (priority === 'high' || priority === 'urgent') block.priority = 'high';
    const why = str(source.why);
    if (why) block.why = why;
  }

  // Generic coercion per declared prop type.
  for (const [name, prop] of Object.entries(spec.props)) {
    if (source[name] === undefined || source[name] === null) continue;
    const coerced = coerce(source[name], prop);
    if (coerced === undefined) { warnings.push(`dropped invalid "${name}"`); continue; }
    if (prop.values && typeof coerced === 'string') {
      const lower = ENUM_ALIASES[coerced.toLowerCase()] ?? coerced.toLowerCase();
      if (!prop.values.includes(lower)) { warnings.push(`"${name}" must be one of ${prop.values.join('|')}`); continue; }
      block[name] = lower;
      continue;
    }
    block[name] = coerced;
  }

  if (block.fileId !== undefined) {
    const fileId = String(block.fileId).toLowerCase();
    if (FILE_ID.test(fileId)) {
      block.fileId = fileId;
      // A media block given only by file id shows that file (a url/path alias still wins).
      if (spec.type === 'media' && !block.src && !['url', 'path', 'file'].some(key => str(source[key]))) block.src = fileId;
    } else { delete block.fileId; warnings.push('dropped invalid "fileId"'); }
  }

  // Type-specific shaping and inference (may fill required props).
  const shapeError = SHAPERS[spec.type]?.(block, source, warnings);
  if (shapeError) return { ok: false, error: `${shapeError} in ${spec.type}`, type: spec.type, ask };
  if (spec.type === 'file' && !block.path && !block.fileId) return { ok: false, error: '"path" missing in file', type: spec.type, ask };

  for (const [name, prop] of Object.entries(spec.props)) {
    if (prop.required && isMissing(block[name])) {
      return { ok: false, error: `"${name}" missing in ${spec.type}`, type: spec.type, ask };
    }
  }
  return { ok: true, block, warnings };
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function applyAliasDefaults(alias: string, type: BlockType, source: Obj): void {
  const a = alias.replace(/[\s-]+/g, '_');
  if (type === 'record' && source.mode === undefined) {
    if (a === 'teleprompter' || a === 'video') source.mode = 'video';
    else if (typeof source.script === 'string' && a !== 'audio_recorder') source.mode = 'video';
    else source.mode = 'audio';
  }
  if (type === 'callout' && source.tone === undefined) {
    if (a === 'warning' || a === 'alert') source.tone = 'warning';
    if (a === 'note') source.tone = 'info';
  }
  // B-078: an "approval"/"consent" block is a yes/no quick reply – a choice with the action as its question.
  if (type === 'choice' && (a === 'approval' || a === 'consent' || a === 'yes_no' || a === 'yesno')) {
    source.question ??= source.action ?? source.text ?? source.title;
    source.options ??= [...YES_NO];
  }
  if (type === 'media' && source.kind === undefined && (a === 'image' || a === 'audio')) source.kind = a;
  if (type === 'media' && source.kind === a && source.src === undefined && typeof source.url === 'string') source.src = source.url;
}

