// Generative-UI block catalog – the single source for what agents may render inline.
// Owns: block types, their props, aliases, tiers. The parser/validator (parse.ts), the
// agent prompt fragment (prompt.ts) and every renderer (desktop, PWA, phone) derive from it.
// Never: allows raw HTML outside the sandboxed ```app fence.
//
// Agents write normal Markdown. Inside it:
//   ```mermaid  → diagram (rendered once on the PC, cached as SVG)
//   ```ui       → one JSON object (or array) with "type" from this catalog
//   ```app      → HTML fragment mini-tool in a sandboxed iframe (no network)

import { SYSTEM_ID } from '../ids.ts';

export type DisplayBlockType =
  | 'callout' | 'steps' | 'table' | 'stats' | 'chart' | 'timeline'
  | 'compare' | 'cards' | 'media' | 'file' | 'progress' | 'tabs';

/**
 * Ask blocks need a human answer – they are quick replies the agent offers, never a permission (B-078 D9). Only an
 * important one ("important": true or "priority": "high"), one with "todo": true and a timer become items on the
 * person's list (becomesTodo); the rest stay in the message and answer from there.
 */
export type AskBlockType =
  | 'choice' | 'form' | 'approve' | 'checklist' | 'timer' | 'record' | 'upload' | 'confirm' | 'review';

export type BlockType = DisplayBlockType | AskBlockType;

/** A parsed and normalized ```ui block. Props are type-specific (see CATALOG). */
export interface UiBlock {
  type: BlockType;
  id?: string; // agent slug; a later block with the same id in the same chat replaces it
  title?: string;
  // ask-block options
  todo?: boolean; // true: also an item on the person's list (see becomesTodo)
  important?: boolean; // B-078: shown in the strip above the person's input field and on their list
  due?: string; // ISO datetime or ISO duration ("PT2H")
  priority?: 'normal' | 'high'; // 'high' reads as important
  why?: string; // one line why the human is needed
  [prop: string]: unknown;
}

export type PropType = 'string' | 'number' | 'boolean' | 'string[]' | 'object' | 'object[]' | 'any';

export interface PropSpec {
  type: PropType;
  required?: boolean;
  values?: readonly string[]; // enum
  doc?: string;
}

export interface BlockSpec {
  type: BlockType;
  kind: 'display' | 'ask';
  tier: 'lite' | 'full'; // lite = also taught to small local models
  doc: string; // one line, used in the prompt fragment and docs
  props: Record<string, PropSpec>;
  /** Short signature shown to the model, e.g. "choice{question,options,multi?}". */
  signature: string;
  answer?: string; // what reaches the agent: the person's line for a click or entry (shared/blocks/answer-text.ts)
  /** B-078: kept only so older messages and the host's own to-dos render; agents ask with the type it maps to. */
  legacy?: true;
}

export const CATALOG: readonly BlockSpec[] = [
  // ------------------------------------------------------------- display blocks
  { type: 'callout', kind: 'display', tier: 'lite', doc: 'Key point, result or warning.',
    signature: 'callout{tone:info|success|warning|danger,text}',
    props: { tone: { type: 'string', values: ['info', 'success', 'warning', 'danger'] }, text: { type: 'string', required: true } } },
  { type: 'steps', kind: 'display', tier: 'lite', doc: 'Plan, process or "what I did".',
    signature: 'steps{items:[{title,text?,status?:done|active|todo|failed}]}',
    props: { items: { type: 'object[]', required: true } } },
  { type: 'table', kind: 'display', tier: 'lite', doc: 'Tabular data.',
    signature: 'table{columns,rows,caption?}',
    props: { columns: { type: 'any', required: true }, rows: { type: 'any', required: true }, caption: { type: 'string' } } },
  { type: 'stats', kind: 'display', tier: 'full', doc: 'KPI tiles.',
    signature: 'stats{items:[{label,value,delta?,trend?:up|down|flat}]}',
    props: { items: { type: 'object[]', required: true } } },
  { type: 'chart', kind: 'display', tier: 'full', doc: 'Chart (bar, line, area, donut, scatter).',
    signature: 'chart{kind:bar|line|area|donut|scatter,data:[{}],x,y,stacked?,unit?}',
    props: { kind: { type: 'string', required: true, values: ['bar', 'line', 'area', 'donut', 'scatter'] },
      data: { type: 'object[]', required: true }, x: { type: 'string', required: true }, y: { type: 'any', required: true },
      stacked: { type: 'boolean' }, unit: { type: 'string' } } },
  { type: 'timeline', kind: 'display', tier: 'full', doc: 'Chronology or schedule.',
    signature: 'timeline{items:[{date,title,text?}]}',
    props: { items: { type: 'object[]', required: true } } },
  { type: 'compare', kind: 'display', tier: 'full', doc: 'Options side by side.',
    signature: 'compare{options:[{name,pros?,cons?,facts?,pick?}]}',
    props: { options: { type: 'object[]', required: true } } },
  { type: 'cards', kind: 'display', tier: 'full', doc: 'Links, results or a gallery (3–8).',
    signature: 'cards{items:[{title,text?,url?,image?,meta?}]}',
    props: { items: { type: 'object[]', required: true } } },
  { type: 'media', kind: 'display', tier: 'full', doc: 'Image, audio or video.',
    signature: 'media{src,kind?:image|audio|video,caption?}',
    props: { src: { type: 'string' }, kind: { type: 'string', values: ['image', 'audio', 'video'] }, caption: { type: 'string' }, items: { type: 'object[]' },
      fileId: { type: 'string', doc: 'stored file id (the host adds it for workspace paths)' } } },
  { type: 'file', kind: 'display', tier: 'full', doc: 'A deliverable file (Open / Show in folder).',
    signature: 'file{path,label?,note?}',
    props: { path: { type: 'string', doc: 'workspace path (required unless fileId is given)' }, label: { type: 'string' }, note: { type: 'string' },
      fileId: { type: 'string', doc: 'stored file id (the host adds it for workspace paths)' } } },
  { type: 'progress', kind: 'display', tier: 'full', doc: 'Status of long work; reuse "id" to update it.',
    signature: 'progress{label,value?:0..1,status?:running|blocked|done|failed,detail?}',
    props: { label: { type: 'string', required: true }, value: { type: 'number' },
      status: { type: 'string', values: ['running', 'blocked', 'done', 'failed'] }, detail: { type: 'string' } } },
  { type: 'tabs', kind: 'display', tier: 'full', doc: 'Group blocks into tabs to save space.',
    signature: 'tabs{tabs:[{label,blocks:[]}]}',
    props: { tabs: { type: 'object[]', required: true } } },

  // ------------------------------------------------------------- ask blocks
  { type: 'choice', kind: 'ask', tier: 'lite', doc: 'Ask the human to pick an option.',
    signature: 'choice{question,options,multi?,allowOther?}',
    props: { question: { type: 'string', required: true }, options: { type: 'any', required: true }, multi: { type: 'boolean' }, allowOther: { type: 'boolean' } },
    answer: 'their line with the picked option\'s text in full (several joined with ", "; an "Other" text as typed)' },
  { type: 'form', kind: 'ask', tier: 'full', doc: 'Short form (a secret field is stored safely and reaches me as its handle; domain: the site a secret is for).',
    signature: 'form{fields:[{name,label,kind?:text|longtext|number|date|time|select|toggle|email|url|secret,domain?,options?,required?}],submit?}',
    props: { fields: { type: 'object[]', required: true }, submit: { type: 'string' } },
    answer: 'their line with one "Label: value" line per filled field (a secret as its secret:// handle)' },
  { type: 'approve', kind: 'ask', tier: 'lite', legacy: true, doc: 'A yes/no quick reply (older messages; I ask with choice).',
    signature: 'approve{action,amount?:{value,currency},risk?:low|medium|high,details?}',
    props: { action: { type: 'string', required: true }, amount: { type: 'object' }, risk: { type: 'string', values: ['low', 'medium', 'high'] }, details: { type: 'string' } },
    answer: 'their line "Yes" or "No" (+ their note)' },
  { type: 'checklist', kind: 'ask', tier: 'full', doc: 'Things the human ticks off.',
    signature: 'checklist{items:[text|{text,done?}]}',
    props: { items: { type: 'any', required: true } },
    answer: 'their line "Checked: …" (+ "Still open: …")' },
  { type: 'timer', kind: 'ask', tier: 'full', doc: 'Reminder or countdown for the human.',
    signature: 'timer{label,at?|duration?,repeat?:daily|weekdays|weekly}',
    props: { label: { type: 'string', required: true }, at: { type: 'string' }, duration: { type: 'string' }, repeat: { type: 'string', values: ['daily', 'weekdays', 'weekly'] } },
    answer: 'their line "Done" (or "Snoozed", "Missed")' },
  { type: 'record', kind: 'ask', tier: 'lite', doc: 'Recorder; with "script" it becomes a teleprompter.',
    signature: 'record{mode:audio|video|screen,script?,bullets?,instructions?,maxSeconds?,camera?:front|back|any}',
    props: { mode: { type: 'string', required: true, values: ['audio', 'video', 'screen'] }, script: { type: 'string' }, bullets: { type: 'string[]' },
      instructions: { type: 'string' }, maxSeconds: { type: 'number' }, camera: { type: 'string', values: ['front', 'back', 'any'] } },
    answer: 'their line "Recorded m:ss" with the recording attached' },
  { type: 'upload', kind: 'ask', tier: 'full', doc: 'Ask the human for files.',
    signature: 'upload{label,accept?,multiple?,instructions?}',
    props: { label: { type: 'string', required: true }, accept: { type: 'string[]' }, multiple: { type: 'boolean' }, instructions: { type: 'string' } },
    answer: 'their line "Uploaded <names>" with the files attached' },
  { type: 'confirm', kind: 'ask', tier: 'lite', doc: 'Something the human does outside, then confirms.',
    signature: 'confirm{instructions,url?,confirmLabel?}',
    props: { instructions: { type: 'string', required: true }, url: { type: 'string' }, confirmLabel: { type: 'string' } },
    answer: 'their line with the button label ("Done" unless confirmLabel says otherwise; + their note)' },
  { type: 'review', kind: 'ask', tier: 'full', doc: 'Ask the human to look at a result and give a verdict.',
    signature: 'review{src,kind?,question?,options?}',
    props: { src: { type: 'string', required: true }, kind: { type: 'string' }, question: { type: 'string' }, options: { type: 'string[]' } },
    answer: 'their line with the verdict (+ their note)' },
];

/** Model variance → canonical type. */
export const ALIASES: Readonly<Record<string, BlockType>> = {
  reminder: 'timer', countdown: 'timer', alarm: 'timer',
  recorder: 'record', audio_recorder: 'record', teleprompter: 'record', video: 'record', recording: 'record',
  approval: 'choice', consent: 'choice', yes_no: 'choice', yesno: 'choice', // B-078: a yes/no is a quick reply
  question: 'choice', buttons: 'choice', select: 'choice', poll: 'choice',
  filedrop: 'upload', file_upload: 'upload',
  kpi: 'stats', metrics: 'stats',
  alert: 'callout', note: 'callout', warning: 'callout',
  todo_list: 'checklist', todos: 'checklist',
  plan: 'steps', process: 'steps',
  gallery: 'cards', links: 'cards',
  image: 'media', audio: 'media',
  status: 'progress',
};

export const ASK_TYPES: ReadonlySet<BlockType> = new Set(CATALOG.filter(spec => spec.kind === 'ask').map(spec => spec.type));

/** The options a yes/no quick reply offers (an "approval"/"consent" block, the old approve card). */
export const YES_NO: readonly string[] = ['Yes', 'No'];

/** Important: "important": true or "priority": "high" – the strip above the person's input field shows it. */
export function isImportantAsk(block: { important?: unknown; priority?: unknown }): boolean {
  return block.important === true || block.priority === 'high';
}

/** A form that asks for a secret only the person holds (a field of kind "secret"). */
function asksSecret(block: { type?: unknown; fields?: unknown }): boolean {
  return block.type === 'form' && Array.isArray(block.fields) && block.fields.some((field) => (field as { kind?: unknown })?.kind === 'secret');
}

/**
 * B-078 D9: an ask block that becomes an item on the person's list – important, "todo": true, a timer (it rings) or a
 * form for a secret only they hold (its value is captured through the to-do).
 */
export function becomesTodo(block: { type?: unknown; todo?: unknown; important?: unknown; priority?: unknown; fields?: unknown }): boolean {
  if (block.todo === false) return false;
  return isImportantAsk(block) || block.todo === true || block.type === 'timer' || asksSecret(block);
}

export function specFor(type: string): BlockSpec | undefined {
  return CATALOG.find(spec => spec.type === type);
}

/** Size and count limits enforced by the parser and renderers. */
export const LIMITS = {
  uiJsonBytes: 64 * 1024,
  appHtmlBytes: 256 * 1024,
  blocksPerMessage: 12,
  tableRows: 200,
  chartPoints: 2000,
  choiceOptions: 8,
  liveAppFrames: 3,
  mermaidChars: 8000,
} as const;

/**
 * Props only the host sets on a to-do widget – a device's access request `accessRequestId` (runtime/remote/todo.ts).
 * validateBlock and human.ask drop them from everything an agent writes.
 */
export const HOST_ONLY_PROPS: readonly string[] = ['accessRequestId'];

/**
 * A to-do the host opened ('system') and bound with one of HOST_ONLY_PROPS: only the person
 * answers it, agents may read it but never change it, and its widget keeps its form ("Show as…"
 * would drop the binding).
 */
export function isHostBoundTodo(task: { createdBy: string; widget?: unknown }): boolean {
  if (task.createdBy !== SYSTEM_ID || !task.widget || typeof task.widget !== 'object') return false;
  const widget = task.widget as Record<string, unknown>;
  return HOST_ONLY_PROPS.some((key) => typeof widget[key] === 'string' && widget[key] !== '');
}

