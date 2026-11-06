// Shape conversion between workforce tools and MCP: ToolSpec → MCP Tool (wire name, object
// input schema) and ToolOutput → MCP CallToolResult (text/image content, isError,
// structuredContent for plain-object results).
// Owns: those mappings. Never: calls tools or decides what is offered.

import type { ToolOutput, ToolSpec } from '../tools/types.ts';
import { isRecord } from './jsonrpc.ts';
import { mcpWireName } from './names.ts';

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

/** MCP requires an object schema at the top level. */
export function objectSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!isRecord(schema)) return { type: 'object', properties: {} };
  if (schema.type === 'object') return schema;
  if (schema.type === undefined) return { ...schema, type: 'object' };
  return { type: 'object', properties: {} };
}

export function toMcpTool(spec: ToolSpec): McpTool {
  return { name: mcpWireName(spec.name), title: spec.name, description: spec.description, inputSchema: objectSchema(spec.inputSchema) };
}

/**
 * ToolOutput → CallToolResult. Empty text parts are dropped and an empty result gets a short
 * placeholder, because model APIs reject empty text blocks in tool results.
 */
export function toCallResult(output: ToolOutput): McpCallResult {
  const content: McpContent[] = [];
  for (const part of output.content ?? []) {
    if (part.type === 'text') { if (part.text) content.push({ type: 'text', text: part.text }); }
    else if (part.type === 'image' && part.dataBase64) content.push({ type: 'image', data: part.dataBase64, mimeType: part.mime });
  }
  const isError = Boolean(output.isError);
  if (!content.length) content.push({ type: 'text', text: isError ? 'The tool failed.' : 'Done.' });
  const result: McpCallResult = { content, isError };
  if (isRecord(output.structured)) result.structuredContent = output.structured;
  return result;
}

export function errorResult(message: string): McpCallResult {
  return { content: [{ type: 'text', text: message || 'The tool failed.' }], isError: true };
}
