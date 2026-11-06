// B-052 track A: reading an MCP server's WWW-Authenticate challenge (RFC 9110 §11.6.1, RFC 6750 §3, RFC 9728 §5.1)
// into McpAuthRequired: the Bearer challenge's `resource_metadata`, `scope` and `error` (quoted strings with
// backslash escapes or plain tokens; several challenges in one header, scheme names in any case).
// Owns: that parsing and the 401/403 decision. Never: follows a URL from it (oauth/* does, after checking it).

import { McpAuthRequired } from '../types.ts';

const TOKEN = /[!#$%&'*+\-.^_`|~0-9A-Za-z]+/y;
const MAX_HEADER = 8192;

export interface Challenge { scheme: string; params: Map<string, string> }

/** Every challenge of a WWW-Authenticate value (lenient: a character it cannot place is skipped). */
export function parseChallenges(header: string): Challenge[] {
  const text = header.slice(0, MAX_HEADER);
  const out: Challenge[] = [];
  let current: Challenge | undefined;
  let at = 0;
  const skip = (chars: RegExp) => { while (at < text.length && chars.test(text[at])) at++; };
  const readValue = (): string | undefined => {
    if (text[at] === '"') {
      let value = '';
      at++;
      while (at < text.length) {
        const char = text[at++];
        if (char === '\\' && at < text.length) { value += text[at++]; continue; }
        if (char === '"') return value;
        value += char;
      }
      return undefined; // unterminated
    }
    const start = at;
    while (at < text.length && !/[\s,]/.test(text[at])) at++;
    return text.slice(start, at);
  };
  while (at < text.length) {
    skip(/[\s,]/);
    if (at >= text.length) break;
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(text);
    if (!match) { at++; continue; } // e.g. the '/' of a token68 credential hint
    const word = match[0];
    at = TOKEN.lastIndex;
    const afterWord = at;
    skip(/[ \t]/);
    if (text[at] === '=' && current) {
      at++;
      skip(/[ \t]/);
      const value = readValue();
      if (value === undefined) break;
      const key = word.toLowerCase();
      if (!current.params.has(key)) current.params.set(key, value);
      continue;
    }
    at = afterWord;
    current = { scheme: word.toLowerCase(), params: new Map() };
    out.push(current);
  }
  return out;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : undefined;
}

/** The Bearer challenge's parameters (the first challenge's when there is no Bearer one). */
export function bearerParams(header: string | null | undefined): { resourceMetadata?: string; scope?: string; error?: string } {
  if (!header) return {};
  const challenges = parseChallenges(header);
  const bearer = challenges.find((challenge) => challenge.scheme === 'bearer') ?? challenges[0];
  if (!bearer) return {};
  const out: { resourceMetadata?: string; scope?: string; error?: string } = {};
  const resourceMetadata = clean(bearer.params.get('resource_metadata'), 2048);
  const scope = clean(bearer.params.get('scope'), 2048);
  const error = clean(bearer.params.get('error'), 64);
  if (resourceMetadata) out.resourceMetadata = resourceMetadata;
  if (scope) out.scope = scope;
  if (error) out.error = error;
  return out;
}

/** 401 → sign-in needed; 403 with error="insufficient_scope" → more access needed; otherwise undefined. */
export function authChallenge(status: number, header: string | null | undefined): McpAuthRequired | undefined {
  if (status !== 401 && status !== 403) return undefined;
  const params = bearerParams(header);
  if (status === 403 && params.error !== 'insufficient_scope') return undefined;
  return new McpAuthRequired({ status, ...params });
}
