// One run item as a compact step line (D5, like Codex; split from run-items.tsx, which lists them):
// a 24 px line – a fixed 16 px icon slot (a spinner while a call runs), the verb, the target with
// an ellipsis –, red when it failed, a click opens its details below (input and output, the reasoning
// summary, the answer's text). Lines per kind: tool calls (step-view.ts callStep),
// "Thought · <headline>" (muted, shimmering while written), plans ("Plan · 2 of 5 done"), errors, the final answer's branch ("Answer · Kept
// internal / Posted quietly / Posted"); an agent's update stays its text.
// Owns: this markup. Never: shows more than the runtime journaled (outputs are already truncated and
// secret-redacted there) or invents a thought.

import type { ComponentChildren } from 'preact';
import { useContext, useState } from 'preact/hooks';
import type { RunItem } from '../../shared/model/runs.ts';
import { Icon, Spinner } from '../lib/ui.tsx';
import type { IconName } from '../lib/icons.tsx';
import { plainPreview } from '../lib/format.ts';
import { previewData, type RunEntry } from './model.ts';
import { isCommandText } from '../../shared/text/step-label.ts';
import { STEP_ICONS, answerOf, callStep, thoughtLine, thoughtParts } from './step-view.ts';
import { SplitStep, SplitStepRows } from '../splits/SplitRows.tsx'; // B-057
import { SPLIT_TOOL } from '../splits/split-text.ts';

function Data(props: { label: string; value: unknown }) {
  const text = previewData(props.value);
  if (!text) return null;
  return (
    <div class="run-data">
      <span class="run-data-label">{props.label}</span>
      <pre class="run-data-value">{text}</pre>
    </div>
  );
}

/** The fixed 16 px icon slot of a step line: a spinner while it runs, never a moving text. */
function StepIcon(props: { name: IconName; running?: boolean }) {
  return <span class="run-item-icon" aria-hidden="true">{props.running ? <Spinner size={12} label="Running" /> : <Icon name={props.name} size={14} />}</span>;
}

/** One 24 px line: icon, verb, target (ellipsis); a click opens its details below. */
function StepHead(props: { icon: IconName; running?: boolean; verb?: string; target?: string; mono?: boolean; open: boolean; onToggle: () => void; title?: string; children?: ComponentChildren }) {
  return (
    <button type="button" class="run-item-head" aria-expanded={props.open} onClick={props.onToggle} title={props.title}>
      <StepIcon name={props.icon} running={props.running} />
      {props.verb && <span class="run-item-verb">{props.verb}</span>}
      {props.target && <span class={`run-item-target${props.mono ? ' mono' : ''}`}>{props.target}</span>}
      {props.children}
    </button>
  );
}

export function ToolEntry(props: { call: RunItem; result?: RunItem; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const { call, result, live } = props;
  const failed = result?.data.ok === false || call.effectStatus === 'failed';
  const running = !result && live === true;
  const step = callStep(call);
  const output = result ? (result.data.preview ?? result.data.summary ?? result.data.output) : undefined;
  // Settled outside effects are the normal case; only an open or unknown one says so on the line.
  const effect = !running && (call.effectStatus === 'unknown' || call.effectStatus === 'pending') ? call.effectStatus : undefined;
  return (
    <li class={`run-item tool${failed ? ' failed' : ''}${running ? ' running' : ''}`}>
      <StepHead icon={failed ? 'warning-circle' : STEP_ICONS[step.kind]} running={running} verb={running ? step.active : step.verb}
        target={step.target || call.name || 'Tool'} mono={isCommandText(step)} open={open} onToggle={() => setOpen(!open)} title={call.name}>
        {effect && <span class={`run-effect ${effect}`}>{effect}</span>}
        {!result && !live && !effect && <span class="run-effect pending">no result</span>}
      </StepHead>
      {open && (
        <div class="run-item-body">
          <Data label={call.name ? `Input · ${call.name}` : 'Input'} value={call.data.args} />
          {result && <Data label={result.data.ok === false ? 'Error' : 'Output'} value={output} />}
          {call.effectStatus && call.effectStatus !== 'none' && <p class="run-item-note">Effect: {call.effectStatus}</p>}
        </div>
      )}
    </li>
  );
}

/** "Thought · <headline>", muted, shimmering while it is still written; opens to the summary. */
function ThoughtEntry(props: { item: RunItem; live: boolean }) {
  const [open, setOpen] = useState(false);
  const line = thoughtLine(props.item, props.live);
  return (
    <li class={`run-item reasoning${line.live ? ' live' : ''}`}>
      <StepHead icon="brain" verb={line.verb} target={line.headline ? `· ${line.headline}` : undefined} open={open} onToggle={() => setOpen(!open)} />
      {open && (
        <div class="run-item-body run-thought">
          {thoughtParts(line.text).map((part, index) => (part.heading ? <strong key={index}>{part.text}</strong> : <p key={index}>{part.text}</p>))}
        </div>
      )}
    </li>
  );
}

/** Where the final answer went (D4): "Kept internal", "Posted quietly" or "Posted"; opens to its text. */
function AnswerEntry(props: { answer: NonNullable<ReturnType<typeof answerOf>> }) {
  const [open, setOpen] = useState(false);
  const { answer } = props;
  return (
    <li class={`run-item answer ${answer.branch}`}>
      <StepHead icon={answer.branch === 'internal' ? 'eye-slash' : 'chat-text'} verb="Answer" target={`· ${answer.label}`} open={open} onToggle={() => setOpen(!open)} />
      {open && answer.text && <div class="run-item-body"><p class="run-item-text">{answer.text}</p></div>}
    </li>
  );
}

function OtherEntry(props: { item: RunItem; live: boolean }) {
  const { item, live } = props;
  const [open, setOpen] = useState(false);
  const data = item.data;
  const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
  const toggle = () => setOpen(!open);
  if (item.kind === 'note' && data.commentary === true) return <li class="run-item commentary"><p class="run-item-text">{text('text')}</p></li>;
  const answer = answerOf(item);
  if (answer) return <AnswerEntry answer={answer} />;
  switch (item.kind) {
    case 'reasoning':
      return <ThoughtEntry item={item} live={live} />;
    case 'plan': {
      const steps = Array.isArray(data.steps) ? data.steps : [];
      const done = steps.filter((step) => typeof step === 'object' && step !== null && (step as { status?: unknown }).status === 'done').length;
      return (
        <li class="run-item plan">
          <StepHead icon="list-checks" verb="Plan" target={`· ${done} of ${steps.length} done`} open={open} onToggle={toggle} />
          {open && <ol class="run-plan">{steps.map((step, index) => <li key={index}>{typeof step === 'string' ? step : typeof (step as { text?: unknown }).text === 'string' ? (step as { text: string }).text : previewData(step, 200)}</li>)}</ol>}
        </li>
      );
    }
    case 'error':
      return (
        <li class="run-item error failed">
          <StepHead icon="warning-circle" target={plainPreview(text('message') || previewData(data, 300), 200)} open={open} onToggle={toggle} />
          {open && <div class="run-item-body"><Data label="Details" value={data} /></div>}
        </li>
      );
    default:
      return (
        <li class={`run-item ${item.kind}`}>
          <StepHead icon={item.kind === 'effect' ? 'lightning' : 'info'} target={item.name ?? (item.kind === 'note' ? 'Note' : item.kind === 'effect' ? 'Effect' : item.kind)} open={open} onToggle={toggle}>
            {item.effectStatus && item.effectStatus !== 'none' && <span class={`run-effect ${item.effectStatus}`}>{item.effectStatus}</span>}
          </StepHead>
          {open && <div class="run-item-body"><Data label="Details" value={data} /></div>}
        </li>
      );
  }
}

/** One entry of a run (a call with its result, or another item) as its line. B-057: the parent's agents.split call is
 *  "Split · 3 of 5 done" with its split rows (splits/SplitRows.tsx); a refused one stays an ordinary call line, and so
 *  does every one in Team › agent › Runs (SplitStepRows false: RunSplits lists the run's splits below its steps). */
export function StepEntry(props: { entry: RunEntry; live: boolean }) {
  const { entry, live } = props;
  const splitRows = useContext(SplitStepRows); // B-057
  if (splitRows && entry.kind === 'tool' && entry.call.name === SPLIT_TOOL && entry.result?.data.ok !== false) return <SplitStep call={entry.call} result={entry.result} live={live} />;
  return entry.kind === 'tool'
    ? <ToolEntry call={entry.call} result={entry.result} live={live} />
    : <OtherEntry item={entry.item} live={live} />;
}

export const entryKey = (entry: RunEntry) => (entry.kind === 'tool' ? entry.call.id : entry.item.id);
