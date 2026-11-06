// `form` ask widget: a short form (text, longtext, number, date, time, select, toggle, email,
// url, secret). Secret values go with the answer to the runtime, which stores them encrypted and
// hands the agent only `secret://<id>` handles (secrets/capture.ts, PM6) – on every device that
// may answer, as long as the connection is secure. On plain LAN http the secret fields stay
// disabled with one note, and a required one keeps the form from being sent.
// Answer: {values: {name: value}}. Owns: field rendering, required checks, keeping secret values
// out of drafts. Never: persists secret values in drafts or local state after sending.

import { useState } from 'preact/hooks';
import { secure } from '../../lib/session.ts';
import { Button } from '../../lib/ui.tsx';
import { Inline } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { useDraft } from './use-draft.ts';
import { items, s, strings } from './util.ts';

type FieldKind = 'text' | 'longtext' | 'number' | 'date' | 'time' | 'select' | 'toggle' | 'email' | 'url' | 'secret';

interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  options: string[];
  required: boolean;
  value?: unknown;
  placeholder?: string;
}

const KINDS = new Set<FieldKind>(['text', 'longtext', 'number', 'date', 'time', 'select', 'toggle', 'email', 'url', 'secret']);

function fieldsOf(value: unknown): Field[] {
  return items(value).map((raw, i) => {
    const kind = (KINDS.has(s(raw.kind) as FieldKind) ? s(raw.kind) : 'text') as FieldKind;
    return {
      name: s(raw.name) || `field_${i + 1}`,
      label: s(raw.label) || s(raw.name),
      kind,
      options: strings(raw.options),
      required: raw.required === true,
      value: kind === 'secret' ? undefined : raw.value,
      placeholder: s(raw.placeholder) || undefined,
    };
  }).filter((field) => field.label);
}

/** Shown on secret fields where the connection is not secure (the runtime refuses them there too). */
export const INSECURE_SECRET_NOTE = 'Secrets need HTTPS – open the app through its HTTPS address or use the PC.';

function initialValue(field: Field): string | boolean {
  if (field.kind === 'toggle') return field.value === true || field.value === 'true';
  return field.value === undefined || field.value === null ? '' : String(field.value);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

/** First problem of a field, or undefined. */
function problemOf(field: Field, value: string | boolean): string | undefined {
  if (typeof value === 'boolean') return undefined;
  const text = value.trim();
  if (!text) return field.required ? 'Required' : undefined;
  if (field.kind === 'email' && !EMAIL.test(text)) return 'Not an email address';
  if (field.kind === 'url' && !URL_RE.test(text)) return 'Not a link (http/https)';
  if (field.kind === 'number' && !Number.isFinite(Number(text.replace(',', '.')))) return 'Not a number';
  return undefined;
}

export function Form(props: AskWidgetProps) {
  const { block } = props;
  const fields = fieldsOf(block.fields);
  const plain = fields.filter((field) => field.kind !== 'secret');
  const [values, setValues] = useDraft<Record<string, string | boolean>>(`${props.draftKey}.values`,
    Object.fromEntries(plain.map((field) => [field.name, initialValue(field)])));
  // Secret values live only in component memory (never in the local draft).
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);

  const valueOf = (field: Field): string | boolean => (field.kind === 'secret' ? secrets[field.name] ?? '' : values[field.name] ?? initialValue(field));
  const set = (field: Field, value: string | boolean) => {
    if (field.kind === 'secret') setSecrets({ ...secrets, [field.name]: String(value) });
    else setValues({ ...values, [field.name]: value });
  };
  const problems = Object.fromEntries(fields.map((field) => [field.name, problemOf(field, valueOf(field))]));
  const secretNote = fields.some((field) => field.kind === 'secret') && !secure.value ? INSECURE_SECRET_NOTE : undefined;
  const valid = fields.every((field) => !problems[field.name]); // a required secret stays empty while disabled

  const send = async () => {
    setTouched(true);
    if (!valid || props.busy) return;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = valueOf(field);
      if (field.kind === 'secret') {
        // Sent as typed: the runtime stores it and the agent gets the handle (never the value).
        if (String(value) && !secretNote) out[field.name] = String(value);
      } else if (field.kind === 'toggle') out[field.name] = value === true;
      else if (field.kind === 'number') out[field.name] = String(value).trim() === '' ? null : Number(String(value).replace(',', '.'));
      else out[field.name] = String(value).trim();
    }
    // Kept in component memory only until it was sent (a failed send can be retried).
    if (await props.submit({ values: out })) setSecrets({});
  };

  return (
    <form class="w-form" noValidate onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {fields.map((field) => {
        const id = `${props.draftKey}-${field.name}`;
        const value = valueOf(field);
        const problem = touched ? problems[field.name] : undefined;
        if (field.kind === 'toggle') {
          return (
            <label key={field.name} class="w-form-toggle">
              <input type="checkbox" checked={value === true} disabled={props.busy}
                onChange={(event) => set(field, (event.currentTarget as HTMLInputElement).checked)} />
              <Inline text={field.label} />
            </label>
          );
        }
        return (
          <div key={field.name} class={`w-form-field${problem ? ' has-problem' : ''}`}>
            <label class="field-label" for={id}><Inline text={field.label} />{field.required && <span class="w-required" aria-hidden="true"> *</span>}</label>
            <FieldInput id={id} field={field} value={String(value)} disabled={props.busy || (field.kind === 'secret' && secretNote !== undefined)} onInput={(next) => set(field, next)} />
            {field.kind === 'secret' && secretNote && <span class="w-form-note">{secretNote}</span>}
            {problem && <span class="w-form-problem" role="alert">{problem}</span>}
          </div>
        );
      })}
      <div class="w-actions">
        <Button type="submit" variant="primary" busy={props.busy} disabled={touched && !valid}>
          {s(block.submit) || 'Send'}
        </Button>
      </div>
    </form>
  );
}

function FieldInput(props: { id: string; field: Field; value: string; disabled: boolean; onInput: (value: string) => void }) {
  const { field } = props;
  const common = {
    id: props.id,
    class: 'input',
    value: props.value,
    disabled: props.disabled,
    required: field.required,
    placeholder: field.placeholder,
    'aria-required': field.required || undefined,
  };
  const onInput = (event: Event) => props.onInput((event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
  switch (field.kind) {
    case 'longtext':
      return <textarea {...common} rows={4} onInput={onInput} />;
    case 'select':
      return (
        <select {...common} class="input w-select" onChange={(event) => props.onInput((event.currentTarget as HTMLSelectElement).value)}>
          {!field.required || !props.value ? <option value="">–</option> : null}
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      );
    case 'secret':
      return <input {...common} type="password" autocomplete="off" spellcheck={false} onInput={onInput} />;
    case 'number':
      return <input {...common} type="text" inputMode="decimal" onInput={onInput} />;
    case 'date':
    case 'time':
    case 'email':
    case 'url':
      return <input {...common} type={field.kind} onInput={onInput} />;
    default:
      return <input {...common} type="text" onInput={onInput} />;
  }
}
