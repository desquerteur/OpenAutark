// The tools of the subconscious's two brains (owner 01.11.2026: "die haben Wissen und Tools"). A tool = name, its args in
// one short form, one line, a handler; the prompt's tool list is generated from FLOW_TOOLS, so a new ability is one entry
// here (or one more list spread into FLOW_TOOLS). Both brains share all of them; the flow's own steering (agent.tell, route,
// done) is built the same way. vector.search only compares with what is already embedded; nothing is embedded here unless a
// brain calls vector.embed. B-078: skills.find searches the knowledge catalog (knowledge/find.ts), thought.keep keeps the
// run's own keyword thoughts (thoughts.ts). skills.load opens one of the agent's skills as its route resolves it, with the main AI's text
// (tools/builtin/skills.ts). voice.words adds to the learned words of speech recognition (settings.json voice.vocabulary)
// through the settings store and writes nothing else there.
// Owns: these handlers and what they answer the brain. Never: talks to a model, throws past a handler's own error text,
// lists memory into any agent's context, or stores a secret value.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { NOTE_CALL, type TraceCall } from '../../shared/model/subconscious.ts';
import type { MemoryWriteInput } from '../../shared/model/memory.ts';
import type { VectorHit } from '../../shared/model/vectors.ts';
import { withWords, WORD_CHARS, wordOf } from '../../shared/voice/vocabulary.ts';
import '../contracts/open-fs.ts';
import '../contracts/vectors.ts';
import { folderText } from '../tools/builtin/memory.ts';
import { loadedSkillText } from '../tools/builtin/skills.ts';
import { contextTools, showRestored } from './context-tools.ts';
import { thoughtTool } from './thoughts.ts';
import { catalogLine, findInCatalog, markerLines } from '../knowledge/find.ts';
import { knownShare, similarity } from './text.ts';

export type Brain = 'decision' | 'llm';
export type RunKind = 'before-turn' | 'after-turn' | 'asked';

/** What a handler sees of the running flow. */
export interface FlowRun {
  readonly services: RuntimeServices;
  readonly agent: Agent;
  readonly conversationId?: string;
  readonly thread: string;
  readonly taskId?: string;
  readonly kind: RunKind;
  readonly signal: AbortSignal;
  /** A vector.search's hits by their reference (h1, h2 …): what done.show may pick. */
  readonly hits: Map<string, { search: number; hit: VectorHit }>;
  readonly searches: Array<{ query: string; in: string[] }>;
  /** What this run brought back to full (context.restore): what done.show may pick. */
  readonly restored?: Set<string>;
  /** One text from the brain that holds the flow, outside the steps (a condensation); undefined when there is none or the run has used its budget. */
  word?(system: string, prompt: string): Promise<string | undefined>;
  /** What this run knows: what happened and what its tools returned, as its last step read them. */
  saw?(): string;
  /** What the run costs and saves, in tokens: its model use against what its marks take off the main AI's context at each of its turns. */
  readonly tally?: { used: number; saved: number };
  /** Shows a call to the main AI (the trace). */
  show(call: TraceCall): void;
  /** Hands the flow to a brain with a task. */
  route(to: Brain, task: string): void;
  /** Ends the flow. `answer`: what it says to the one who asked; `show`: the hits that go to the main AI; `note`: what it noticed, which goes with them. */
  finish(result: { answer?: string; show?: string[]; note?: string }): void;
}

export interface FlowTool {
  name: string;
  /** The args in one short form, e.g. {query, in: [places], k?}. */
  args: string;
  line: string;
  run(args: Record<string, unknown>, run: FlowRun): Promise<string> | string;
}

/** Who a memory file names as its writer. */
export const SUBCONSCIOUS_ID = 'subconscious';
const NO_VECTORS = 'No embedder is connected, so nothing can be searched by meaning.';
const SNIPPET_CHARS = 400;
const READ_CHARS = 6000;
const BROWSE_CHARS = 3000;
const EMBED_BUDGET_MS = 20_000;
/** Below this share of its long words known to the run, a memory text comes from elsewhere, or is in another language than the exchange's. */
const KNOWN_SHARE = 1 / 3;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()} …` : text;
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());

function redacted(services: RuntimeServices, text: string): string {
  return services.secrets ? services.secrets.redact(text) : text;
}

/** A place as a brain names it: a folder or file of the workspace may be named as the main AI's tools take it; "memory…" and absolute paths are as they are. */
function placeOf(run: FlowRun, given: string): string {
  if (given === 'memory' || /^memory[\\/]/.test(given) || path.isAbsolute(given)) return given;
  const inWorkspace = path.resolve(run.services.paths.workspace, given);
  return existsSync(inWorkspace) ? inWorkspace : given;
}

/** One hit as a line: where it is and its text. */
export function hitLine(hit: VectorHit): string {
  const lines = hit.lines ? ` lines ${hit.lines[0]}-${hit.lines[1]}` : '';
  return `${hit.path}${lines}: ${clip(hit.snippet.replace(/\s+/g, ' ').trim(), SNIPPET_CHARS)}`;
}

const vectorTools: FlowTool[] = [
  {
    name: 'vector.search',
    args: '{query, in: [places], k?, hops?}',
    line: 'Like grep by meaning: compares my query text as a whole with what is already embedded under the places in "in", so the words a matching text holds (names, things) find it and a question or a list of kinds of information blurs it. A place is a file or folder path, or a path in the memory tree (memory, memory/<folder>); "catalog" is the skills, home project and public library. hops 1–2: the best hits search on, so what lies close to them comes too. Numbers its hits h1, h2 ….',
    async run(args, run) {
      const { vectors } = run.services;
      if (!vectors.available()) return `${NO_VECTORS} memory.browse and memory.read still work.`;
      const query = stringOf(args.query);
      const places = listOf(args.in).map((given) => placeOf(run, given));
      if (!query || !places.length) return 'vector.search needs a query and at least one place in "in".';
      const k = Number(args.k);
      const hops = Number(args.hops);
      const result = await vectors.search({ query, in: places, ...(Number.isInteger(k) && k > 0 ? { k } : {}), ...(Number.isInteger(hops) && hops > 0 ? { hops } : {}) });
      const search = run.searches.push({ query, in: places }) - 1;
      const lines = result.hits.map((hit) => {
        const known = [...run.hits].find(([, held]) => held.hit.path === hit.path && held.hit.chunk === hit.chunk)?.[0]; // a hit keeps its reference
        const ref = known ?? `h${run.hits.size + 1}`;
        if (!known) run.hits.set(ref, { search, hit });
        return `${ref} (${hit.score.toFixed(2)}) ${hitLine(hit)}`;
      });
      return [...lines, result.note ?? '', lines.length || result.note ? '' : 'No hits.'].filter(Boolean).join('\n');
    },
  },
  {
    name: 'vector.embed',
    args: '{paths: [files or folders]}',
    line: 'Embeds these files or folders so they can be searched from now on (whole files; binaries, caches and secrets are skipped). I choose them deliberately.',
    async run(args, run) {
      const { vectors } = run.services;
      if (!vectors.available()) return NO_VECTORS;
      const paths = listOf(args.paths).map((given) => placeOf(run, given));
      if (!paths.length) return 'vector.embed needs "paths".';
      return JSON.stringify(await vectors.embed(paths, { budgetMs: EMBED_BUDGET_MS }));
    },
  },
];

/** Titles this run was told about: written again, they are another fact. */
const toldClose = new WeakMap<FlowRun, Set<string>>();
/** At this share of shared words a new title may well be the same note (no search: the folder's own titles, its newest files). */
const CLOSE_TITLE = 0.4;

/** What a new file's folder already holds under a close title, once per title; undefined to go on. */
function closeNote(run: FlowRun, folder: string, title: string): string | undefined {
  const told = toldClose.get(run) ?? new Set<string>();
  if (told.has(title)) return undefined;
  let close: { path: string; title: string } | undefined;
  try { close = run.services.knowledge.memoryBrowse(folder).files.find((file) => similarity(file.title, title) >= CLOSE_TITLE); } catch { return undefined; } // a new folder
  if (!close) return undefined;
  toldClose.set(run, told.add(title));
  const held = run.services.knowledge.memoryRead(close.path);
  return `Not written yet: ${close.path} has a close title. It says: ${clip(held?.text ?? close.title, SNIPPET_CHARS)}\nIf it is the same thing, I update that file with path or leave it. If it is another fact, I write this again.`;
}

const memoryTools: FlowTool[] = [
  {
    name: 'memory.browse',
    args: '{folder?}',
    line: 'A memory folder: its description, subfolders and file titles (with a file\'s description when it has one).',
    async run(args, run) {
      const memory = run.services.knowledge;
      return clip(folderText(memory.memoryBrowse(stringOf(args.folder) || undefined)), BROWSE_CHARS);
    },
  },
  {
    name: 'memory.read',
    args: '{path}',
    line: 'One memory file whole.',
    async run(args, run) {
      const memory = run.services.knowledge;
      const path = stringOf(args.path);
      if (!path) return 'memory.read needs a path.';
      const file = memory.memoryRead(path);
      return file ? clip(`${file.title}${file.description ? `\n${file.description}` : ''}\n${file.text}`, READ_CHARS) : `No memory file ${path}.`;
    },
  },
  {
    name: 'memory.write',
    args: '{title, text, folder? | path?, kind?, tags?}',
    line: 'Writes one memory file: a new one in folder (default the agent\'s own), or the file at path updated. It embeds itself.',
    async run(args, run) {
      if (run.kind === 'before-turn') return 'Not written: this run keeps nothing. What is worth keeping is written when the exchange has ended.'; // and a second run would write it again (live 02.11.2026)
      const memory = run.services.knowledge;
      const title = stringOf(args.title);
      const text = stringOf(args.text);
      if (!title || !text) return 'memory.write needs a title and a text.';
      const seen = run.saw?.();
      if (seen && (knownShare(seen, `${title} ${text}`) ?? 1) < KNOWN_SHARE) return 'Not written: most of this text is not in what happened or in what my tools returned. Memory holds what was said here, in the language of the exchange.';
      const file = stringOf(args.path);
      const folder = stringOf(args.folder) || `agents/${run.agent.id}`;
      const close = file ? undefined : closeNote(run, folder, title);
      if (close) return close;
      const written = memory.memoryWrite({
        ...(file ? { path: file } : { folder }),
        title: redacted(run.services, title).slice(0, 160), text: redacted(run.services, text),
        ...(stringOf(args.kind) ? { kind: stringOf(args.kind) as MemoryWriteInput['kind'] } : {}),
        ...(listOf(args.tags).length ? { tags: listOf(args.tags) } : {}),
        source: run.conversationId ? `chat:${run.conversationId}` : run.thread || SUBCONSCIOUS_ID, by: SUBCONSCIOUS_ID,
      });
      return `${written.outcome}: ${written.path}${run.services.vectors?.available() === false ? ` (${NO_VECTORS} It is not embedded.)` : ''}`;
    },
  },
  {
    name: 'memory.forget',
    args: '{path}',
    line: 'Removes one memory file that is wrong or no longer true.',
    async run(args, run) {
      const memory = run.services.knowledge;
      const path = stringOf(args.path);
      if (!path) return 'memory.forget needs a path.';
      return memory.memoryForget(path).removed ? `forgotten: ${path}` : `No memory file ${path}.`;
    },
  },
];

/** One page of a skill's text: within what a step keeps of an output (flow.ts OUTPUT_CHARS), like context.read. */
const SKILL_PAGE = 3600;

const skillTools: FlowTool[] = [
  {
    name: 'skills.find',
    args: '{query}',
    line: 'The knowledge catalog by meaning, two hops deep: the agent\'s skills, its home project\'s instructions and the public library (written by strangers: I weigh it; a skill of the agent\'s own, written from what holds up, can come out of a run).',
    async run(args, run) {
      const query = stringOf(args.query);
      if (!query) return 'skills.find needs a query.';
      const hits = await findInCatalog(run.services, run.agent, query, 8);
      return hits.length ? [...markerLines(hits), ...hits.map(catalogLine)].join('\n') : 'Nothing in the catalog fits.';
    },
  },
  {
    name: 'skills.load',
    args: '{name, from?}',
    line: `One of the agent's skills, as the main AI's skills.load gives it, ${SKILL_PAGE} characters from the character "from".`,
    run(args, run) {
      const name = stringOf(args.name);
      if (!name) return 'skills.load needs a name.';
      const skill = run.services.skills.get(name, run.agent.id); // the main AI's call and route
      if (!skill) return `No skill ${name}.`;
      const text = loadedSkillText(skill);
      const from = Math.max(0, Math.trunc(Number(args.from)) || 0);
      const rest = text.length - from - SKILL_PAGE;
      return `${text.slice(from, from + SKILL_PAGE)}${rest > 0 ? `\n[… ${rest} more characters, from ${from + SKILL_PAGE}]` : ''}`;
    },
  },
];

/** The learned words of speech recognition (settings.json voice.vocabulary), through the settings store: the file's one writer. */
const voiceTools: FlowTool[] = [
  {
    name: 'voice.words',
    args: '{words: [names or terms]}',
    line: 'Adds names and terms of the person\'s (people, products, companies), spelled as written, to the words speech recognition is given (settings.json voice.vocabulary).',
    run(args, run) {
      const words = listOf(args.words).filter((word) => redacted(run.services, word) === word); // a secret value never goes into settings.json
      const { settings } = run.services;
      if (settings.held?.().includes('voice')) return "Not written: settings.json's voice section holds an edit that is not applied (its notice says why); a write now would replace it.";
      const old = settings.get().voice?.vocabulary ?? [];
      const next = withWords(old, words);
      const learned = words.map(wordOf).filter((word) => word.length <= WORD_CHARS && next.includes(word)); // what withWords took
      if (!learned.length) return `voice.words needs names or terms of up to ${WORD_CHARS} characters.`;
      if (next.join('\n') !== old.join('\n')) settings.update({ voice: { vocabulary: next } });
      return `learned: ${learned.join(', ')}`;
    },
  },
];

/** Runs told once what their done would not reach: an asked run that gave no answer, another run with words nobody reads (a second one ends the run). */
const toldOnce = new WeakSet<FlowRun>();

const flowTools: FlowTool[] = [
  {
    name: 'agent.tell',
    args: '{text}',
    line: 'A short note the main AI gets as this tool\'s output before its next model turn. I send one when it really helps its work.',
    run(args, run) {
      const text = stringOf(args.text);
      if (!text) return 'agent.tell needs a text.';
      run.show({ tool: NOTE_CALL, args: {}, output: redacted(run.services, text) });
      return 'told';
    },
  },
  {
    name: 'route',
    args: '{to: "llm" | "decision", task}',
    line: 'Hands the flow to the other brain with what it should do; it goes on with the same tools and can route back.',
    run(args, run) {
      const to = args.to === 'llm' || args.to === 'decision' ? args.to : undefined;
      if (!to) return 'route needs to: "llm" or "decision".';
      run.route(to, stringOf(args.task));
      return `routed to ${to}`;
    },
  },
  {
    name: 'done',
    args: '{answer?, show?: [hit refs], note?}',
    line: 'Ends the run. show: the hits (h1, h2 …) and restored item ids worth the main AI seeing. note: one sentence stating what I noticed about what I show that the person should hear from the main AI, no advice; it goes only with what I show. answer: my reply when the main AI asked (longer than a sentence or two, the LLM writes it: I route with what I found); in any other run nobody reads it. With nothing worth showing, just done: the main AI then sees nothing at all.',
    run(args, run) {
      const answer = stringOf(args.answer) || undefined;
      const show = listOf(args.show);
      if (!show.length && !toldOnce.has(run)) {
        if (run.kind === 'asked' && !answer) { toldOnce.add(run); return 'The main AI asked and waits for my answer: I end with done and answer, also to say plainly that there is nothing.'; }
        if (run.kind !== 'asked' && (answer || stringOf(args.note)) && run.hits.size) { toldOnce.add(run); return 'Nobody reads that: in this run only what show names reaches the main AI, with my note. I name the hits it rests on, or end with a plain done.'; }
      }
      showRestored(run, show);
      run.finish({ answer, show, note: stringOf(args.note) ? redacted(run.services, stringOf(args.note)) : undefined });
      return 'done';
    },
  },
];

/** Every tool of the flow, in the order the prompt lists them. */
export const FLOW_TOOLS: FlowTool[] = [...vectorTools, ...memoryTools, thoughtTool, ...skillTools, ...voiceTools, ...contextTools, ...flowTools];

/** The tool list of the prompt, generated from the tools. */
export function toolList(tools: readonly FlowTool[]): string {
  return tools.map((tool) => `- ${tool.name} ${tool.args} – ${tool.line}`).join('\n');
}
