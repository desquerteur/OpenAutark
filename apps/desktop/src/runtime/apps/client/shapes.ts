// B-052 track A: reading the untrusted shapes an MCP server sends – a tools/list entry (dropped, never thrown, when
// its name or inputSchema is unusable; only known fields kept – no outputSchema –, sizes bounded), a tools/call result (content parts of
// the known kinds, structuredContent, isError) and the server info of initialize / server/discover.
// Owns: that light validation. Never: judges what a tool does (tools.ts does) or turns server text into instructions.

import type { McpCallResult, McpContent, McpServerInfo, McpToolAnnotations, McpToolDef } from '../types.ts';
import { isRecord } from './rpc.ts';

/** A tool name we can call back with: 1–128 visible characters, no whitespace or control characters. */
const TOOL_NAME = /^[^\s\u0000-\u001f\u007f]{1,128}$/u;
const MAX_SCHEMA_CHARS = 100_000;
const MAX_CONTENT_PARTS = 1_000;

/** A string with control characters (except newline and tab) removed, trimmed and clipped; undefined when empty. */
export function cleanText(value: unknown, max: number, singleLine = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.replace(singleLine ? /[\u0000-\u001f\u007f]/g : /[\u0000-\u0008\u000b-\u001f\u007f]/g, singleLine ? ' ' : '').trim();
  if (!text) return undefined;
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}

function schemaOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try { return JSON.stringify(value).length <= MAX_SCHEMA_CHARS ? value : undefined; } catch { return undefined; }
}

function annotationsOf(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  const out: McpToolAnnotations = {};
  const title = cleanText(value.title, 200, true);
  if (title) out.title = title;
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    const flag = value[key];
    if (typeof flag === 'boolean') out[key] = flag;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One tools/list entry, or undefined when it cannot be offered. */
export function toolOf(raw: unknown): McpToolDef | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) return undefined;
  const inputSchema = schemaOf(raw.inputSchema);
  if (!inputSchema) return undefined;
  const tool: McpToolDef = { name: raw.name, inputSchema };
  const title = cleanText(raw.title, 200, true);
  if (title) tool.title = title;
  const description = cleanText(raw.description, 4_000);
  if (description) tool.description = description;
  // outputSchema is not kept: nothing reads it, and it would double what every record holds and writes
  const annotations = annotationsOf(raw.annotations);
  if (annotations) tool.annotations = annotations;
  return tool;
}

function optional(target: Record<string, unknown>, key: string, value: unknown, max: number): void {
  const text = cleanText(value, max, true);
  if (text) target[key] = text;
}

/** One content part; an unknown or broken one becomes a short placeholder (the result keeps its order). */
export function contentOf(raw: unknown): McpContent {
  const unsupported: McpContent = { type: 'text', text: '[unsupported content]' };
  if (!isRecord(raw)) return unsupported;
  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' ? { type: 'text', text: raw.text } : unsupported;
    case 'image':
    case 'audio':
      if (typeof raw.data !== 'string' || typeof raw.mimeType !== 'string') return unsupported;
      return { type: raw.type === 'audio' ? 'audio' : 'image', data: raw.data, mimeType: raw.mimeType.slice(0, 100) };
    case 'resource_link': {
      if (typeof raw.uri !== 'string' || !raw.uri) return unsupported;
      const link: Record<string, unknown> = { type: 'resource_link', uri: raw.uri.slice(0, 4_000) };
      optional(link, 'name', raw.name, 200);
      optional(link, 'title', raw.title, 200);
      optional(link, 'mimeType', raw.mimeType, 100);
      optional(link, 'description', raw.description, 1_000);
      return link as McpContent;
    }
    case 'resource': {
      const resource = isRecord(raw.resource) ? raw.resource : undefined;
      if (!resource || typeof resource.uri !== 'string') return unsupported;
      const out: { uri: string; mimeType?: string; text?: string; blob?: string } = { uri: resource.uri.slice(0, 4_000) };
      if (typeof resource.mimeType === 'string') out.mimeType = resource.mimeType.slice(0, 100);
      if (typeof resource.text === 'string') out.text = resource.text;
      if (typeof resource.blob === 'string') out.blob = resource.blob;
      return { type: 'resource', resource: out };
    }
    default:
      return unsupported;
  }
}

/** A tools/call result, or undefined when it is not one (no object, or `content` that is not a list). */
export function callResultOf(raw: unknown): McpCallResult | undefined {
  if (!isRecord(raw)) return undefined;
  let content: McpContent[];
  if (Array.isArray(raw.content)) content = raw.content.slice(0, MAX_CONTENT_PARTS).map(contentOf);
  else if (raw.content === undefined) content = [];
  else return undefined;
  const result: McpCallResult = { content };
  if (raw.structuredContent !== undefined) result.structuredContent = raw.structuredContent;
  if (typeof raw.isError === 'boolean') result.isError = raw.isError;
  return result;
}

/** The server's name, version and instructions (untrusted text, clipped) with the negotiated version. */
export function serverInfoOf(result: unknown, protocolVersion: string): McpServerInfo {
  const record = isRecord(result) ? result : {};
  const server = isRecord(record.serverInfo) ? record.serverInfo : {};
  const info: McpServerInfo = { protocolVersion };
  const name = cleanText(server.name, 100, true);
  if (name) info.name = name;
  const version = cleanText(server.version, 50, true);
  if (version) info.version = version;
  const instructions = cleanText(record.instructions, 4_000);
  if (instructions) info.instructions = instructions;
  return info;
}
