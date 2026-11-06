// Agent templates from resources/agents/*.md: a small front matter block (name, role,
// description, mode, skills, spaceKind, effort, reportsTo) followed by the instructions as body.
// `reportsTo: human` keeps a hire out of the hiring manager's branch (the secretary, O3).
//
//   ---
//   name: Video editor
//   role: Video editor
//   description: Cuts, animates and exports videos.
//   mode: video
//   skills: [video-editing, captions]
//   spaceKind: company
//   effort: high
//   ---
//   Instructions …
//
// Owns: parsing and loading templates (read once, cached). Never: creating agents.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentTemplate, Space } from '../../shared/model/org.ts';
import type { Effort } from '../../shared/model/providers.ts';

const SPACE_KINDS: ReadonlyArray<Space['kind']> = ['company', 'brand', 'private', 'custom'];
const EFFORTS: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(["']).*\1$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function list(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map(unquote).filter(Boolean);
}

/** Parses one template file. Returns undefined for files without valid front matter. */
export function parseTemplate(key: string, source: string): AgentTemplate | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match || !KEY.test(key)) return undefined;
  const fields: Record<string, string> = {};
  let lastKey = '';
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Block list item ("  - name") belonging to the previous key (same syntax as modes/*.md).
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && lastKey) {
      fields[lastKey] = fields[lastKey] ? `${fields[lastKey]},${item[1]}` : item[1];
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    lastKey = line.slice(0, colon).trim();
    fields[lastKey] = line.slice(colon + 1).trim();
  }
  const name = unquote(fields.name ?? '');
  if (!name) return undefined;
  const spaceKind = unquote(fields.spaceKind ?? '') as Space['kind'];
  const effort = unquote(fields.effort ?? '') as Effort;
  const template: AgentTemplate = {
    key,
    name,
    role: unquote(fields.role ?? name),
    description: unquote(fields.description ?? ''),
    mode: unquote(fields.mode ?? '') || 'general',
    skills: fields.skills ? list(fields.skills) : [],
    instructions: match[2].trim(),
  };
  if (SPACE_KINDS.includes(spaceKind)) template.spaceKind = spaceKind;
  if (EFFORTS.includes(effort)) template.effort = effort;
  if (unquote(fields.reportsTo ?? '') === 'human') template.reportsTo = 'human';
  return template;
}

/** Loads every *.md in `dir` (sorted by key). Missing dir → no templates. */
export function loadTemplates(dir: string): AgentTemplate[] {
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { return []; }
  const out: AgentTemplate[] = [];
  for (const name of names) {
    const template = parseTemplate(name.slice(0, -3), readFileSync(path.join(dir, name), 'utf8'));
    if (template) out.push(template);
  }
  return out;
}
