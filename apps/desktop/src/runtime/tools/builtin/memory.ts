// Memory tools. The tree of Markdown files (knowledge/memory-tree.ts), the same handlers for the main AI and the subconscious,
// on demand, not in the core set: memory.browse {folder}, memory.read {path}, memory.write {…} and memory.forget {path}.
// Searching memory is vector.search over "memory/…" – there is no search tool of its own here.
// The older wrappers over the same files: knowledge.remember (save; an exact repeat is not stored twice, and a note with the
// same title or clearly the same content in the same scope is updated – never a duplicate), knowledge.recall (search the
// folders the caller names, else the whole tree; without an embedder by words, and it says so) and knowledge.correct (the old
// version kept as history). Scopes: agent (default), conversation (private
// to this chat), space, global, website / app (scopeId = host or process name, knowledge/scope-id.ts), mode.
// Owns: these tools and their wording (folderText also for the subconscious's memory.browse). Never: a list of memory in a prompt.

import type { ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import type { KnowledgeItem, KnowledgeKind, KnowledgeScope } from '../../../shared/model/knowledge.ts';
import { foldText } from '../../knowledge/normalize.ts';
import { agentTags } from '../../knowledge/reserved.ts';
import { normalScopeId, scopeIdHint } from '../../knowledge/scope-id.ts';
import { COVERS, similarity } from '../../subconscious/text.ts';
import { DESCRIPTION_SHOWN, type MemoryFolder, type MemoryKind } from '../../../shared/model/memory.ts';
import { clip, defineTool, internal, parseWhen, readChat } from './util.ts';
import '../../contracts/vectors.ts';

/** Rule (e): without an embedder the write says it is not searchable by meaning. */
const NOT_EMBEDDED = 'No embedder is connected: not embedded, so vector.search does not find it; memory.browse and memory.read do.';
/** Rule (e): without an embedder a memory search says that it matched words, not meaning (q-r1c z4, 03.11.2026: it said nothing). */
export const WORDS_ONLY = 'No embedder is connected: this is a word search, not by meaning.';

const KINDS: KnowledgeKind[] = ['fact', 'preference', 'experience', 'procedure', 'plan', 'observation', 'note'];
const SCOPES: KnowledgeScope[] = ['agent', 'conversation', 'space', 'global', 'website', 'app', 'mode'];

/** The current note a new one would only repeat in other words: same title, else clearly the same content (never the
 * person's references or a chat's observations). */
function twinOf(current: readonly KnowledgeItem[], title: string, body: string): KnowledgeItem | undefined {
  const own = current.filter((item) => item.kind !== 'reference' && item.kind !== 'observation');
  const key = foldText(title);
  const text = `${title} ${body}`;
  let best: { item: KnowledgeItem; score: number } | undefined;
  for (const item of own) {
    if (foldText(item.title) === key) return item;
    const score = similarity(`${item.title} ${item.body}`, text);
    if (score >= COVERS && (!best || score > best.score)) best = { item, score };
  }
  return best?.item;
}

const remember = defineTool<{ title: string; body: string; kind?: KnowledgeKind; scope?: KnowledgeScope; scopeId?: string; tags?: string[]; pinned?: boolean; validFrom?: string; validTo?: string; confidence?: number }>({
  name: 'knowledge.remember',
  description: 'Save something worth knowing later (fact, preference, experience, procedure) as a memory file. scope: agent (default, my own), conversation (only this chat), space, global (the whole team), website (scopeId = the host or a page URL), app (scopeId = the process name, e.g. excel), mode (what I learned in my current specialist mode). pinned: always in my prompt (I keep it short). A note with the same title (or the same content) in that scope is updated, not saved twice. Every note keeps the date it was saved.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 8000 },
      kind: { type: 'string', enum: KINDS }, scope: { type: 'string', enum: SCOPES }, scopeId: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }, pinned: { type: 'boolean' },
      validFrom: { type: 'string' }, validTo: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['title', 'body'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Remember "${clip(args.title, 60)}"`),
  async run(args, ctx) {
    const now = ctx.services.clock.now();
    const scope = args.scope ?? 'agent';
    const given = args.scopeId ?? (scope === 'agent' ? ctx.agent.id : scope === 'conversation' ? readChat(ctx) : scope === 'space' ? ctx.agent.spaceId : scope === 'mode' ? ctx.mode : undefined);
    const scopeId = normalScopeId(scope, given);
    if (scope !== 'global' && !scopeId) return failure(scope === 'website' || scope === 'app' ? `scope ${scope} needs a scopeId: ${scopeIdHint(scope)}.` : `scope ${scope} needs a scopeId.`);
    const title = args.title.trim();
    const body = args.body.trim();
    const current = await ctx.services.knowledge.list({ scope, ...(scopeId ? { scopeId } : {}), limit: 500 });
    const same = current.find((item) => item.body.trim() === body && foldText(item.title) === foldText(title));
    if (same) return json({ ok: true, id: same.id, outcome: 'duplicate', note: 'Already known; nothing new was stored.' });
    const twin = twinOf(current, title, body);
    if (twin) {
      const next = ctx.services.knowledge.correct(twin.id, { title, body, validTo: parseWhen(args.validTo, now) }, ctx.agent.id);
      const pinned = args.pinned === undefined || args.pinned === twin.pinned ? next : ctx.services.knowledge.pin(next.id, args.pinned, ctx.agent.id);
      return json({ ok: true, id: pinned.id, outcome: 'updated', supersedes: twin.id, note: `Updated my note "${clip(twin.title, 60)}" (the old version is kept as history).` });
    }
    const item = ctx.services.knowledge.save({
      title: args.title, body: args.body, kind: args.kind ?? 'fact', scope, scopeId, tags: agentTags(args.tags ?? []),
      pinned: args.pinned ?? false, confidence: args.confidence ?? 0.7,
      validFrom: parseWhen(args.validFrom, now), validTo: parseWhen(args.validTo, now),
      source: { kind: 'agent', ref: ctx.runId, trusted: true }, createdBy: ctx.agent.id,
    });
    return json({ ok: true, id: item.id, outcome: 'added' });
  },
});

const recall = defineTool<{ query: string; in?: string[]; limit?: number; kinds?: KnowledgeKind[] }>({
  name: 'knowledge.recall',
  description: 'Search what the team and I know in the memory tree, by meaning: in the folders of `in` (e.g. "company/customers"), else all of it. Notes say when they were saved; knowledge.correct fixes a wrong one.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 1000 }, in: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 } },
      limit: { type: 'integer', minimum: 1, maximum: 20 }, kinds: { type: 'array', items: { type: 'string', enum: [...KINDS, 'reference'] } },
    },
    required: ['query'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Recall "${clip(args.query, 60)}"`),
  async run(args, ctx) {
    const hits = await ctx.services.knowledge.search({ text: args.query, folders: args.in?.length ? args.in : [''], conversationId: readChat(ctx), limit: args.limit ?? 8, kinds: args.kinds }).catch(() => []);
    const lines: string[] = [];
    for (const hit of hits) {
      const item = hit.item;
      const validity = item.validTo ? ` (valid until ${new Date(item.validTo).toISOString().slice(0, 10)})` : '';
      const area = item.scope === 'mode' ? ` [${item.scopeId} mode]` : '';
      lines.push(`- [${item.id}] ${item.title}${validity}${item.description ? ` (${clip(item.description, DESCRIPTION_SHOWN)})` : ''}: ${clip(item.body, 800)} — ${hit.why}${area}`);
    }
    const words = ctx.services.vectors?.available() === false;
    if (!lines.length) return text(words ? `${WORDS_ONLY} It found nothing.` : 'Nothing relevant found.');
    return text([...(words ? [WORDS_ONLY] : []), ...lines].join('\n'));
  },
});

const correctMemory = defineTool<{ id: string; body?: string; title?: string; validTo?: string }>({
  name: 'knowledge.correct',
  description: 'Correct or end a stored item; the old version is kept as history.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string', minLength: 1 }, title: { type: 'string' }, validTo: { type: 'string' } }, required: ['id'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Correct memory ${args.id}`, args.id),
  async run(args, ctx) {
    if (!ctx.services.knowledge.get(args.id)) return failure('Memory item not found.');
    const next = ctx.services.knowledge.correct(args.id, { body: args.body, title: args.title, validTo: parseWhen(args.validTo, ctx.services.clock.now()) }, ctx.agent.id);
    return json({ ok: true, id: next.id, supersedes: args.id });
  },
});

const PATH = { type: 'string', minLength: 1, maxLength: 512 } as const;
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** One memory folder as text: the main AI's memory.browse and the subconscious's (subconscious/tools.ts). */
export function folderText(folder: MemoryFolder): string {
  return [
    `memory/${folder.path}`.replace(/\/$/, ''),
    ...(folder.description ? [folder.description] : []),
    ...folder.folders.map((entry) => `${entry.path}/${entry.description ? ` – ${clip(entry.description, 160)}` : ''}`),
    ...folder.files.map((entry) => `${entry.path} – ${entry.title}${entry.kind ? ` [${entry.kind}]` : ''} (${day(entry.updated)})${entry.description ? ` – ${entry.description}` : ''}`),
    ...(folder.more ? ['… and older files.'] : []),
    ...(!folder.folders.length && !folder.files.length ? ['Empty.'] : []),
  ].join('\n');
}

const browse = defineTool<{ folder?: string }>({
  name: 'memory.browse',
  description: 'One folder of the memory tree: what it is for, its subfolders and its newest files (titles, with a file\'s description when it has one). No folder = the top (company, branches, agents, references).',
  inputSchema: { type: 'object', properties: { folder: { type: 'string', maxLength: 512 } }, additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Browse memory ${clip(args.folder ?? '', 60)}`),
  async run(args, ctx) {
    try {
      const folder = ctx.services.knowledge.memoryBrowse(args.folder ?? '');
      return { content: [{ type: 'text', text: folderText(folder) }], structured: folder };
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

const read = defineTool<{ path: string }>({
  name: 'memory.read',
  description: 'One memory file: its title, description, kind, tags, date, source and text.',
  inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Read memory ${clip(args.path, 60)}`, args.path),
  async run(args, ctx) {
    try {
      const file = ctx.services.knowledge.memoryRead(args.path);
      if (!file) return failure(`No memory file ${clip(args.path, 200)}.`);
      const facts = [file.kind, file.tags?.join(', '), day(file.updated), file.source].filter(Boolean).join(' · ');
      return { content: [{ type: 'text', text: `${file.title} (${facts})${file.description ? `\n${file.description}` : ''}\n\n${file.text}` }], structured: file };
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

const write = defineTool<{ path?: string; folder?: string; title: string; text: string; description?: string; kind?: MemoryKind; tags?: string[]; source?: string; validFrom?: string; validTo?: string }>({
  name: 'memory.write',
  description: 'Create or update a memory file; it is findable with vector.search at once. I write one whenever an exchange taught me something that will still matter in weeks – short, dated, with names, in the words someone would search for; what I do not keep, my next turn does not know. folder: where it goes, default my own (agents/<me>); company for everyone, branches/<space> for a branch, or any topic subfolder (created as needed). The same title in a folder updates that file; path names a file to update. description: one line on when the file helps (optional).',
  inputSchema: {
    type: 'object',
    properties: {
      path: PATH, folder: { type: 'string', maxLength: 512 }, title: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 50_000 },
      description: { type: 'string', maxLength: 300 },
      kind: { type: 'string', enum: KINDS }, tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }, source: { type: 'string', maxLength: 500 },
      validFrom: { type: 'string' }, validTo: { type: 'string' },
    },
    required: ['title', 'text'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Write memory "${clip(args.title, 60)}"`),
  async run(args, ctx) {
    const now = ctx.services.clock.now();
    try {
      const result = ctx.services.knowledge.memoryWrite({
        ...(args.path ? { path: args.path } : { folder: args.folder ?? `agents/${ctx.agent.id}` }),
        title: args.title, text: args.text, ...(args.description !== undefined ? { description: args.description } : {}),
        kind: args.kind, tags: args.tags && agentTags(args.tags), source: args.source ?? `run:${ctx.runId}`,
        validFrom: parseWhen(args.validFrom, now), validTo: parseWhen(args.validTo, now), by: ctx.agent.id,
      });
      return json({ ok: true, ...result, ...(ctx.services.vectors?.available() === false ? { note: NOT_EMBEDDED } : {}) });
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

const forget = defineTool<{ path: string }>({
  name: 'memory.forget',
  description: 'Delete a memory file for good, with its old versions.',
  inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Forget memory ${clip(args.path, 60)}`, args.path),
  async run(args, ctx) {
    try {
      const { removed } = ctx.services.knowledge.memoryForget(args.path);
      return removed ? json({ ok: true }) : failure(`No memory file ${clip(args.path, 200)}.`);
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

export const memoryTools: ToolDef[] = [browse, read, write, forget, remember, recall, correctMemory];
