// The agent's "rich answers" system-prompt fragment, generated from the CATALOG
// (web-genui §7.4). Tiers: 'lite' for small local models (mermaid + lite blocks),
// 'full' (~400 tokens), and 'full' + app for models that may write sandboxed mini-tools (and
// mini-app to-dos: todo=true, reason=, F01). B-076 (owner 05.11.: a click is just the click): a click on an
// ask block reaches the agent as the person's line with what they picked (shared/blocks/answer-text.ts), said in
// the agent's own voice; "I can't do this: …" means "find a way without them" (F06); the help for an ask block
// says what its line reads, and for record/upload that the files arrive attached with where they are stored.
// X03: the mini-app guide teaches wf.upload (files handed back with wf.complete, limits from app-files.ts).
// B-041: never "set yourself a timer" (a timer block instead).
// B-078 D9: ask blocks are quick replies the agent offers while it carries on with the likeliest answer; only
// "important":true (or "todo":true, a timer) puts one on the person's list; the legacy approve card is not taught.
// Also generates the on-demand detail text of the `ui.help` tool (runtime/tools/builtin/ui.ts, F08):
// one block type, the mini-app guide, mermaid or the topic index.
// B-049 F5 (lean prompt): the stable prompt carries only blockLine – that blocks exist, their type names by tier and
// where the props are; the quick reference (blockPrompt) is loaded on use as ui.help "blocks".
// Owns: the wording agents see about blocks. Never: lists anything that is not in the
// catalog.

import { APP_UPLOAD_LIMITS, sizeText } from './app-files.ts';
import { CATALOG, LIMITS, specFor } from './catalog.ts';
import type { BlockSpec } from './catalog.ts';

export type PromptTier = 'lite' | 'full';

export interface PromptOptions {
  tier?: PromptTier;
  /** Teach the ```app escape hatch (default: true for full, false for lite). */
  app?: boolean;
  /** The help tool's name as the engine exposes it ("ui__help"); named only when the agent has it. */
  helpTool?: string;
}

/** Wraps signatures into lines of at most `width` characters, two spaces apart. */
function wrap(items: string[], width = 118): string[] {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (line && line.length + item.length + 2 > width) { lines.push(` ${line}`); line = ''; }
    line = line ? `${line}  ${item}` : item;
  }
  if (line) lines.push(` ${line}`);
  return lines;
}

/** The catalog types the agent writes (B-078: a legacy type such as approve is only rendered, never taught). */
function specsFor(kind: BlockSpec['kind'], tier: PromptTier): BlockSpec[] {
  return CATALOG.filter(spec => spec.kind === kind && !spec.legacy && (tier === 'full' || spec.tier === 'lite'));
}

/** The prompt fragment. Deterministic: same options → same text (prompt-cache friendly). */
export function blockPrompt(opts: PromptOptions = {}): string {
  const tier = opts.tier ?? 'full';
  const app = opts.app ?? tier === 'full';
  const display = specsFor('display', tier);
  const ask = specsFor('ask', tier);
  const lines = [
    '## Rich answers',
    `Default to plain Markdown. Add a visual block only when it is clearly faster to grasp than text; max ~3 per message.`,
    tier === 'full'
      ? 'Diagrams: ```mermaid (flowchart, sequence, state, gantt, mindmap). Labels ≤ 5 words.'
      : 'Diagrams: ```mermaid flowchart. Labels ≤ 5 words.',
    'Structured blocks: ```ui with one JSON object (or an array), each with "type":',
    ...wrap(display.map(spec => spec.signature)),
    'Quick replies to the human (in my message; their click reaches me later as their line with what they picked;',
    '"I can\'t do this: …" means they cannot – I find a way without them):',
    ...wrap(ask.map(spec => spec.signature)),
    tier === 'full'
      ? 'Optional: "id" (reuse it to update a block), "title"; on asking blocks "important":true, "due", "why", "todo":true.'
      : 'Optional: "id" (reuse it to update a block), "title"; on asking blocks "important":true.',
    'Buttons are answers I offer, not a permission I wait for: I carry on with the likeliest one meanwhile.',
    '"important":true puts the question above the person\'s input field and on their list – for what needs their',
    'hands, presence, identity, a secret they hold or their taste. A timer they need rings from their list.',
  ];
  if (app) {
    lines.push(
      'Rare: if no block fits, ```app title="..." with an HTML fragment (style, markup, script; CSS vars --wf-*;',
      'offline, no network). Send results with wf.send(name,data). todo=true reason=physical|taste|review|identity',
      "makes it an item on the human's to-do list; wf.complete(data) finishes it.",
    );
  }
  // Props, examples and the mini-app guide on demand ("blocks" lists the topics).
  if (opts.helpTool) lines.push(`Details: call ${opts.helpTool} with topic ${app ? '"app", ' : ''}"blocks" or a block type.`);
  return lines.join('\n');
}

/** Display types the short line names as examples (each only when the tier's catalog has it). */
const EXAMPLE_TYPES = ['table', 'chart', 'steps'];

/**
 * B-049 F5: the stable prompt's one rich-answer fact. With the help tool: Markdown first, that ```mermaid and ```ui
 * blocks exist (a few catalog types as examples) and that the help tool's "blocks" topic lists them all – the rest is
 * loaded on use. Without it (nothing to look up): every type name of the tier instead. Deterministic.
 */
export function blockLine(opts: PromptOptions = {}): string {
  const tier = opts.tier ?? 'full';
  const app = opts.app ?? tier === 'full';
  const diagrams = tier === 'full' ? '```mermaid' : '```mermaid flowchart';
  const rare = app ? '; rarely an ```app mini-tool' : '';
  if (opts.helpTool) {
    const examples = EXAMPLE_TYPES.filter(type => specsFor('display', tier).some(spec => spec.type === type));
    return ['## Rich answers', `Markdown by default; ${diagrams} and \`\`\`ui blocks (${examples.join(', ')}, quick replies to the human …) only when clearly faster to grasp, max ~3 per message – ${opts.helpTool} "blocks" lists every type with its fields${app ? ' and the ```app mini-tool' : ''}.`].join('\n');
  }
  const names = (kind: BlockSpec['kind']) => specsFor(kind, tier).map(spec => spec.type).join(', ');
  return [
    '## Rich answers',
    `Markdown by default; a block only when clearly faster to grasp (max ~3 per message): ${diagrams} or \`\`\`ui JSON {"type":…} – display: ${names('display')}; quick replies to the human (important:true puts one on their list): ${names('ask')}${rare}.`,
  ].join('\n');
}

/** Every topic blockHelp knows: the index, the mini-app guide, mermaid and each block type. */
export function helpTopics(): string[] {
  return ['blocks', 'app', 'mermaid', ...CATALOG.map(spec => spec.type)];
}

/** Detail text for the ui.help tool: one block type, "app", "mermaid", or "blocks" for the index. */
export function blockHelp(topic: string): string {
  const key = topic.trim().toLowerCase();
  if (key === 'blocks') return `${blockPrompt({ tier: 'full', app: true })}\n\n${topicIndex()}`; // B-049 F5: the quick reference the stable prompt no longer carries
  if (key === 'app') return APP_GUIDE;
  if (key === 'mermaid') return MERMAID_GUIDE;
  const spec = specFor(key);
  if (!spec) return `Unknown topic "${topic.trim().slice(0, 40)}". Topics: ${helpTopics().join(', ')}.`;
  const props = Object.entries(spec.props).map(([name, prop]) => {
    const kind = prop.values ? prop.values.join('|') : prop.type;
    return `- ${name}${prop.required ? '' : '?'}: ${kind}${prop.doc ? ` – ${prop.doc}` : ''}`;
  });
  const lines = [
    `## ${spec.type} (${spec.kind === 'ask' ? 'asks the human' : 'display'})`,
    spec.doc,
    `Signature: ${spec.signature}`,
    'Props:',
    ...props,
    '- id?: string – reuse to replace an earlier block in this chat',
    '- title?: string',
  ];
  if (spec.kind === 'ask') {
    lines.push('- important?: boolean – true puts it above the person\'s input field and on their list (what needs their hands, presence, identity, secret or taste)',
      '- todo?: boolean – true puts it on their list without the strip', '- due?: ISO datetime or duration ("PT2H")', '- why?: one line why the human is needed');
    if (spec.legacy) lines.push('Older messages carry this card; I ask a yes/no with a choice block ("options":["Yes","No"]).');
    if (spec.answer) lines.push(`What reaches me when they click or send: ${spec.answer}, as a reply to my message.`);
    if (spec.type === 'record' || spec.type === 'upload') lines.push('The files arrive attached to their line, each with where it is stored.');
    lines.push('When they cannot do it, their line reads "I can\'t do this: <reason>" and I find a way without them.');
  }
  const limits = LIMIT_NOTES[spec.type];
  if (limits) lines.push(limits);
  const example = EXAMPLES[spec.type];
  if (example) lines.push('Example:', '```ui', example, '```');
  return lines.join('\n');
}

/** The "blocks" topic: what each topic is for, one line each (from the catalog). */
function topicIndex(): string {
  const line = (spec: BlockSpec) => `- ${spec.type} – ${spec.doc}`;
  return [
    '## Rich-answer topics',
    '- app – sandboxed ```app mini-tool: look, layout, the wf API, mini-app to-dos',
    '- mermaid – diagram kinds and limits',
    'Display blocks (```ui):',
    ...CATALOG.filter(spec => spec.kind === 'display').map(line),
    'Quick replies to the human (```ui; "important":true also puts one on their list):',
    ...CATALOG.filter(spec => spec.kind === 'ask' && !spec.legacy).map(line),
  ].join('\n');
}

const LIMIT_NOTES: Record<string, string> = {
  timer: 'A timer or reminder the person would otherwise set themselves: "duration" ("PT10M") or "at" rings it.',
  table: `Max ${LIMITS.tableRows} rows; columns: [string | {key,label,align?}], rows: [[…]] or [{…}].`,
  chart: `Max ${LIMITS.chartPoints} points; "y" may be one key or a list of keys (several series).`,
  choice: `Max ${LIMITS.choiceOptions} options: [string | {label,value?,hint?}].`,
};

const EXAMPLES: Record<string, string> = {
  chart: '{"type":"chart","kind":"line","x":"month","y":["visits","signups"],"data":[{"month":"Jan","visits":120,"signups":8},{"month":"Feb","visits":180,"signups":14}]}',
  record: '{"type":"record","id":"intro-video","mode":"video","script":"Hi, I am …","bullets":["Who I am","What the course gives you"],"instructions":"Plug in the camera","due":"PT4H"}',
  choice: '{"type":"choice","id":"thumb","question":"Which thumbnail?","options":["Bright","Dark","Minimal"]}',
  confirm: '{"type":"confirm","instructions":"Plug the camera into the PC","important":true}',
  timer: '{"type":"timer","label":"Call the tax office","at":"2026-10-20T09:00"}',
  progress: '{"type":"progress","id":"render","label":"Rendering video","value":0.4,"status":"running"}',
  form: '{"type":"form","fields":[{"name":"domain","label":"Domain"},{"name":"apiKey","label":"API key","kind":"secret"}]}',
  steps: '{"type":"steps","items":[{"title":"Cut intro","status":"done"},{"title":"Add music","status":"active"},{"title":"Export"}]}',
};

const MERMAID_GUIDE = [
  '## mermaid',
  'Write ```mermaid with flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt, timeline, mindmap or pie.',
  'Keep labels ≤ 5 words, ≤ 25 nodes. No click handlers, HTML labels or custom styles; they are removed.',
  `Max ${LIMITS.mermaidChars} characters. If it does not render, the human sees the source.`,
].join('\n');

const APP_GUIDE = [
  '## app (sandboxed mini-tool)',
  'For what no ui block fits (calculators, mixers, small editors): ```app title="Short name" with an HTML',
  'fragment (no <html>/<head>/<body>), in this order: <style>, markup, <script>. It runs offline in a sandbox:',
  'no network, no storage, no popups. Max 256 KB.',
  'Look: use the CSS variables --wf-bg --wf-surface --wf-fg --wf-muted --wf-border --wf-accent --wf-radius',
  '--wf-font (they follow light/dark), two font weights, sentence case, no gradients or shadows, one column,',
  'no inner scrolling. The frame grows with its content.',
  'API (global `wf`, ready before my script runs):',
  '- wf.send(name, data) – an event or result reaches me as [ui-event …] (a report, not a consent)',
  '- wf.complete(data) – finish the to-do (use ```app todo=true)',
  `- wf.upload(blob, name) – store a recording, image or file (to-do apps; audio, video, images, PDF, text; ≤ ${sizeText(APP_UPLOAD_LIMITS.fileBytes)},`,
  `  ≤ ${APP_UPLOAD_LIMITS.filesPerBlock} per app) → {fileId,name,mime,size}. Put it into wf.complete(data), e.g. wf.complete({take}): the file`,
  '  arrives attached to the person\'s line, with where it is stored. Files the data does not name are dropped; naming none hands',
  '  back all. A refused file rejects with the reason: show it',
  '  and let the human try again.',
  '- wf.record({mode:"audio"|"video", maxSeconds:120, script:"…"}) – open the host recorder for a to-do; the human',
  '  starts, records and sends. Returns {fileId,name,mime,size}; use wf.complete({take}). Ask permissions="microphone"',
  '  (video: permissions="microphone,camera"). getUserMedia does not work inside the opaque frame; the host recorder does.',
  '- wf.state.get() / wf.state.set(obj) – small state kept per block',
  '- wf.expand() – ask for a larger view',
  'Info-string options: title="…", todo=true, reason=…, expand=true, permissions="microphone" (the human grants it once).',
  'expand=true puts an "Open larger" button over the top-right corner: keep about 40 px there free.',
  'todo=true puts the app on the human\'s to-do list under its title (e.g. a recorder for a voice-over); it is done',
  'when the app calls wf.complete(data); the data reaches me as the person\'s line "Done in mini-app" with one',
  '"key: value" line each. reason= says why only they',
  'can do it: physical (presence, recording), taste (their decision, the default), review (they look at a result)',
  'or identity (signature, ID). Secrets are never asked by an app: the secure chat input does that.',
].join('\n');
