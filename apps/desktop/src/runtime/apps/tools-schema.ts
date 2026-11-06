// Connectors: what an MCP tool looks like as a Workforce tool – its name `app.<appId>.<tool>`, its
// description and its input schema. Server texts are untrusted data: each one goes through the clean-up of
// shared/text/clean.ts before an agent sees it.
// * Name: the MCP name with camelCase split, lowercased, every character outside [a-z0-9_-] → '_', runs of
//   separators collapsed (so a wire name never carries '__' of its own), no separator at either end. A name longer
//   than APP_TOOL_NAME_MAX keeps the start of its tool part plus '_' and a 6-character hash of the MCP name: Claude's
//   `mcp__workforce__` prefix (16) and the wire name (each '.' → '__', engines/shared.ts toWireName) stay ≤ 64.
//   Names that collide within an app: the one already written that way (else the first by MCP name) keeps the plain
//   name, the others get the hash too. The map back to the MCP name is appToolNames().
// * Description: "<App>: <title>. <description>" cleaned (invisible characters, markup, chat tokens, secret handles
//   gone) and clipped to 400 characters.
// * Schema: an object schema; local $ref (#, #/$defs/…, #/definitions/…) inlined up to 8 levels deep, a cycle or a
//   remote $ref becomes {} (never fetched); $schema, $id, $defs, $comment and examples dropped; titles and
//   descriptions cleaned and clipped to 300; at most SCHEMA_CHARS characters (a larger tool is not offered). The walk
//   has a budget (NODE_BUDGET nodes, about SCHEMA_CHARS of output): a schema whose $refs would blow up is given up at
//   once, not expanded. Only known JSON-Schema data keywords stay (type, enum, const, default, bounds, formats …;
//   anything else, e.g. "x-instructions", is dropped); a default with hidden characters or markup is dropped.
// Owns: these rules (pure functions). Never: calls a server or follows a server text as an instruction.

import { createHash } from 'node:crypto';
import type { JsonSchema } from '../tools/types.ts';
import type { McpToolDef } from './types.ts';
import { cleanText, stripMarkup } from '../../shared/text/clean.ts';

export const APP_TOOL_PREFIX = 'app.';
/** Longest tool name (see the header). */
export const APP_TOOL_NAME_MAX = 44;
const HASH_CHARS = 6;
const DESCRIPTION_MAX = 400;
const SCHEMA_TEXT_MAX = 300;
/** $ref levels inlined into one another. */
const REF_DEPTH = 8;
/** Nested schemas at all (a guard against pathological schemas). */
const NEST_DEPTH = 40;
export const SCHEMA_CHARS = 60_000;
const MCP_NAME_MAX = 256;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Server text an agent may see: invisible characters and markup gone, whitespace squashed, clipped to `max`. */
export function cleanServerText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = stripMarkup(cleanText(value)).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The app's name as shown in descriptions and results. */
export function appLabel(name: string | undefined): string {
  return cleanServerText(name, 60).replace(/[[\]]/g, '') || 'App';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_CHARS);
}

/** The tool part of a name (see the header). */
export function toolPart(mcpName: string): string {
  const part = mcpName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/[_-]{2,}/g, (run) => (run.includes('_') ? '_' : '-'))
    .replace(/^[_-]+|[_-]+$/g, '');
  return part || 'tool';
}

function hashedName(head: string, mcpName: string): string {
  const room = Math.max(1, APP_TOOL_NAME_MAX - head.length - HASH_CHARS - 1);
  const stem = toolPart(mcpName).slice(0, room).replace(/[_-]+$/, '') || 't';
  return `${head}${stem}_${shortHash(mcpName)}`;
}

/** `app.<appId>.<tool>` for one MCP tool name, without the collision check of appToolNames. */
export function appToolName(appId: string, mcpName: string): string {
  const head = `${APP_TOOL_PREFIX}${appId}.`;
  const name = `${head}${toolPart(mcpName)}`;
  return name.length <= APP_TOOL_NAME_MAX ? name : hashedName(head, mcpName);
}

/** A usable MCP tool name (a non-empty string of reasonable length). */
export function validMcpName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MCP_NAME_MAX;
}

/** Each MCP tool name of an app → its unique Workforce name (duplicates and unusable names are left out). */
export function appToolNames(appId: string, mcpNames: readonly unknown[]): Map<string, string> {
  const unique = [...new Set(mcpNames.filter(validMcpName))];
  const groups = new Map<string, string[]>();
  for (const mcpName of unique) {
    const base = appToolName(appId, mcpName);
    groups.set(base, [...(groups.get(base) ?? []), mcpName]);
  }
  const canonical = (mcpName: string) => (toolPart(mcpName) === mcpName ? 0 : 1);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const later: string[] = [];
  for (const [base, group] of groups) {
    const [keeper, ...rest] = [...group].sort((a, b) => canonical(a) - canonical(b) || (a < b ? -1 : a > b ? 1 : 0));
    out.set(keeper, base);
    taken.add(base);
    later.push(...rest);
  }
  const head = `${APP_TOOL_PREFIX}${appId}.`;
  for (const mcpName of later) {
    const name = hashedName(head, mcpName);
    if (taken.has(name)) continue; // a hash collision: the later tool is not offered
    taken.add(name);
    out.set(mcpName, name);
  }
  return out;
}

/** "<App>: <title>. <description>" (see the header). */
export function appToolDescription(appName: string, tool: McpToolDef): string {
  const title = tool.title ?? tool.annotations?.title;
  const head = cleanServerText(title, 120);
  const body = cleanServerText(tool.description, DESCRIPTION_MAX);
  const text = head && body && !body.toLowerCase().startsWith(head.toLowerCase()) ? `${head}. ${body}` : body || head || cleanServerText(tool.name, 120);
  const full = `${appLabel(appName)}: ${text}`;
  return full.length > DESCRIPTION_MAX ? `${full.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : full;
}

// ------------------------------------------------------------------ input schema

/** Keywords whose value is a map of schemas, one schema, or a list of schemas (everything else is data). */
const SCHEMA_MAPS: ReadonlySet<string> = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const SCHEMA_ONE: ReadonlySet<string> = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'additionalItems', 'unevaluatedItems']);
const SCHEMA_LIST: ReadonlySet<string> = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const DROPPED: ReadonlySet<string> = new Set(['$schema', '$id', '$defs', 'definitions', '$comment', '$anchor', '$dynamicAnchor', '$dynamicRef', '$vocabulary', 'examples']);
const TEXTS: ReadonlySet<string> = new Set(['title', 'description']);
/** JSON-Schema data keywords kept as the server sent them (after the checks below); every other key is dropped. */
const DATA: ReadonlySet<string> = new Set([
  'type', 'enum', 'const', 'default', 'required', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'minContains',
  'maxContains', 'nullable', 'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType', 'dependentRequired',
]);
/** Schema nodes one walk may visit (a guard against $ref blow-ups). */
const NODE_BUDGET = 5_000;

interface Walk { root: Record<string, unknown>; nodes: number; size: number; over: boolean }

/** Every string inside a data value (bounded), for the checks. */
function stringsIn(value: unknown, out: string[], depth = 0): string[] {
  if (out.length > 1_000 || depth > 8) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out, depth + 1);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) { out.push(key); stringsIn(item, out, depth + 1); }
  return out;
}

/** The text changes when hidden characters and markup are taken out. */
const hidden = (text: string) => stripMarkup(cleanText(text)) !== text;

/** Counts output toward the walk's budget; true once it is spent. */
function spend(walk: Walk, chars: number): boolean {
  walk.size += chars;
  if (walk.size > SCHEMA_CHARS) walk.over = true;
  return walk.over;
}

/** The node a local JSON pointer ('#', '#/$defs/Name', '#/definitions/a~1b') names, if any. */
function pointer(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined; // remote or anchor refs are never fetched or guessed
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let key: string;
    try { key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return undefined; }
    if (!isRecord(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function schemaNode(node: unknown, walk: Walk, nest: number, refs: readonly string[]): unknown {
  if (walk.over) return {};
  if (++walk.nodes > NODE_BUDGET) { walk.over = true; return {}; }
  if (nest > NEST_DEPTH) return {};
  if (node === true) return {};
  if (node === false) return { not: {} };
  if (!isRecord(node)) return {};
  const { $ref: ref, ...rest } = node;
  const own = keywords(rest, walk, nest, refs);
  if (typeof ref !== 'string') return own;
  if (refs.includes(ref) || refs.length >= REF_DEPTH) return own; // a cycle or too deep: {} plus its own keywords
  const target = pointer(walk.root, ref);
  if (target === undefined) return own;
  const resolved = schemaNode(target, walk, nest + 1, [...refs, ref]);
  return { ...(isRecord(resolved) ? resolved : {}), ...own };
}

function keywords(node: Record<string, unknown>, walk: Walk, nest: number, refs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (walk.over) break;
    if (DROPPED.has(key)) continue;
    if (spend(walk, key.length + 4)) break;
    if (TEXTS.has(key)) {
      if (typeof value !== 'string') continue;
      const text = cleanServerText(value, SCHEMA_TEXT_MAX);
      if (text) { out[key] = text; spend(walk, text.length); }
    } else if (SCHEMA_MAPS.has(key)) {
      if (!isRecord(value)) continue;
      const map: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(value)) {
        if (spend(walk, name.length + 4)) break;
        map[name] = schemaNode(schema, walk, nest + 1, refs);
      }
      out[key] = map;
    } else if (SCHEMA_ONE.has(key)) {
      out[key] = Array.isArray(value) ? value.map((item) => schemaNode(item, walk, nest + 1, refs)) : typeof value === 'boolean' && key !== 'items' ? value : schemaNode(value, walk, nest + 1, refs);
    } else if (SCHEMA_LIST.has(key)) {
      if (Array.isArray(value)) out[key] = value.map((item) => schemaNode(item, walk, nest + 1, refs));
    } else if (DATA.has(key)) {
      const texts = stringsIn(value, []);
      if (spend(walk, texts.reduce((sum, text) => sum + text.length + 3, 8))) break;
      if (key === 'default' && texts.some(hidden)) continue; // only a hint: dropped rather than cleaned
      out[key] = value;
    } // anything else (x-…, markdownDescription, vendor keys) is dropped
  }
  return out;
}

/**
 * The app tool's input schema (see the header), or undefined when it is larger than SCHEMA_CHARS – such a tool is not offered.
 */
export function appToolSchema(input: unknown): JsonSchema | undefined {
  const root = isRecord(input) ? input : {};
  const walk: Walk = { root, nodes: 0, size: 0, over: false };
  const node = schemaNode(root, walk, 0, []) as Record<string, unknown>;
  if (walk.over) return undefined;
  const schema: Record<string, unknown> = { ...node, type: 'object', properties: isRecord(node.properties) ? node.properties : {} };
  if (schema.required !== undefined) {
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [];
    if (required.length) schema.required = required; else delete schema.required;
  }
  let size: number;
  try { size = JSON.stringify(schema).length; } catch { return undefined; }
  return size > SCHEMA_CHARS ? undefined : schema;
}
