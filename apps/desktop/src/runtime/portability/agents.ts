// Agents as files: "Export" (agents.export – one JSON file in the blob store with the agent, its SYSTEM.md and Main
// Skills and its own notes; the AI reads such a file to hire it again, skill import-agent-system; agent.json goes
// without the PC's id and home folder). Duplicating an agent is the skill agent-duplicate (a copy of the folder +
// agents.create), no code here. Also free names and the default manager other modules use.
// Owns: what an export carries. Never: secret values (texts pass the vault's redaction), run history.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { KnowledgeItem } from '../../shared/model/knowledge.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { CORE_MANIFEST } from '../../shared/model/agent-core.ts';
import type { RuntimeServices } from '../contracts.ts';
import { agentFolder } from '../agent-core/layout.ts';
import '../contracts/agent-core.ts';

const NAME_MAX = 80;
/** Text files of the agent folder an export carries (SYSTEM.md, agent.json, Main Skills), at most this big each. */
const FILE_MAX = 256 * 1024;
const FILES_MAX = 200;

/** First free name: `make(1)`, `make(2)` … (case-insensitive, among active agents like Org). */
export function freeName(s: RuntimeServices, make: (index: number) => string): string {
  const taken = new Set(s.org.list().map((agent) => agent.name.toLocaleLowerCase()));
  for (let index = 1; index < 1000; index++) {
    const name = make(index);
    if (!taken.has(name.toLocaleLowerCase())) return name;
  }
  throw new WorkforceError('conflict', 'Choose a different agent name.');
}

/** `base` shortened so `base + suffix` stays within the name limit. */
export function fit(base: string, suffix: string): string {
  return `${base.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

/** The manager new agents report to by default: the oldest active agent in manager mode. */
export function defaultManager(s: RuntimeServices): string | undefined {
  return s.org.list().filter((agent) => agent.mode === 'manager').sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0]?.id;
}

/** The agent's current own notes (scope 'agent'), oldest first. */
async function ownNotes(s: RuntimeServices, agentId: string): Promise<KnowledgeItem[]> {
  const now = s.clock.now();
  return (await s.knowledge.list({ scope: 'agent', scopeId: agentId, limit: 500 }))
    .filter((item) => item.validTo === undefined || item.validTo > now).reverse();
}

/** The text files of the agent's folder (relative path → text), small ones only. */
function folderTexts(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, rel: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(current); } catch { return; }
    for (const entry of entries.sort()) {
      if (Object.keys(out).length >= FILES_MAX || entry.startsWith('.')) continue;
      const full = path.join(current, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      const info = statSync(full, { throwIfNoEntry: false });
      if (info?.isDirectory()) walk(full, relPath);
      else if (info?.isFile() && info.size <= FILE_MAX && /\.(md|json|txt|ya?ml)$/i.test(entry)) out[relPath] = readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

/** agent.json without `id` and `home`: the id and a home folder belong to this PC (an export names neither). */
function portableManifest(text: string): string {
  try {
    const { id: _id, home: _home, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return `${JSON.stringify(rest, null, 2)}\n`;
  } catch {
    return text;
  }
}

/** "Export": the agent, its folder's text files and (unless `includeKnowledge` is false) its own notes as one JSON file. */
export async function exportAgentFile(s: RuntimeServices, id: string, includeKnowledge = true): Promise<FileRef> {
  try { s.agentCore?.reconcile(id); } catch { /* an edit of SYSTEM.md the watcher has not handed over yet comes along */ }
  const agent = s.org.require(id);
  const redact = (text: string) => (s.secrets ? s.secrets.redact(text) : text);
  const files = Object.fromEntries(Object.entries(folderTexts(agentFolder(s.paths.data, id))).map(([rel, text]) => [rel, redact(rel === CORE_MANIFEST ? portableManifest(text) : text)]));
  const doc = {
    format: 'workforce-agent', version: 4, exportedAt: s.clock.now(),
    agent: { name: agent.name, role: agent.role, mode: agent.mode, instructions: redact(agent.instructions), skills: agent.skills, modelPolicy: agent.modelPolicy, avatar: agent.avatar },
    files,
    knowledge: includeKnowledge ? (await ownNotes(s, id)).map((note) => ({ kind: note.kind, title: redact(note.title), body: redact(note.body), tags: note.tags, pinned: note.pinned })) : [],
  };
  const safe = agent.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'agent';
  const file = await s.files.put(new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`), `${safe}.autark-agent.json`, 'application/json');
  s.log.info('agent exported', { agentId: id, files: Object.keys(files).length, knowledge: doc.knowledge.length, fileId: file.id });
  return file;
}
