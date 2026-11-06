// The person's own line for what they did on an ask block or a to-do (owner 05.11.2026: "das ist nicht eine
// Entscheidung, das ist einfach nur der Button-Klick"): the chat shows it as their line, as a reply to the asking
// message, and the agent that asked reads it as that line (runtime/tasks/answer-receipt.ts). A choice is the picked
// option's text in full (its label; several joined with ", ", an "Other" text as typed), an (older) approve card "Yes"
// or "No" (B-078), a confirm its button label, a review the verdict, a form one "Label: value" line per filled field,
// a checklist what was checked and what stays open, a record or upload what came (the files ride along as
// attachments), a mini-app to-do "Done in mini-app" with the data its app handed back, a decline "I can't do this:
// <reason>"; a note the person added follows on its own line. Also the one-line form of it (the block's receipt,
// the to-do's result summary).
// Used by the runtime (tasks/human.ts, tasks/decline.ts) and the UI's optimistic receipt (ui/blocks/ask.ts).
// Owns: that wording. Never: shows a stored file by its id where its name is known (`names`), or a secret – a secret
// field reaches here only as its secret:// handle (secrets/capture.ts).

/** A widget as stored on a to-do or parsed from a ```ui block (catalog block or mini-app widget). */
export type AnswerWidget = { type?: unknown; [prop: string]: unknown } | undefined;

/** The name of a stored file by its id; undefined when the store does not know it. */
export type FileNames = (fileId: string) => string | undefined;

const FILE_ID = /^[a-f0-9]{64}$/i;
/** The data lines a mini-app hands back: enough for the agent, never a wall of JSON. */
const APP_DATA_CAP = 1500;
const VALUE_CAP = 500;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).map((item) => (typeof item === 'number' ? String(item) : str(item))).filter(Boolean);

/** "I can't do this: <reason>" – the person's words when they decline a to-do. */
export function declineText(reason?: string): string {
  const said = str(reason);
  return said ? `I can't do this: ${said}` : "I can't do this.";
}

/** The answer as the person's line (see the header). `names` resolves stored file ids (the runtime's file store). */
export function answerText(widget: AnswerWidget, answer: unknown, names?: FileNames): string {
  const a = (answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : { value: answer }) as Record<string, unknown>;
  const note = str(a.note);
  const withNote = (head: string): string => (note && note !== head ? `${head}\n${note}` : head);
  switch (widget?.type) {
    case 'choice': return picked(widget, a) || 'Answered';
    case 'approve': return withNote(approvedNo(a) ? 'No' : 'Yes'); // B-078: a yes/no quick reply
    case 'confirm': return withNote(str(widget.confirmLabel) || 'Done');
    case 'review': return withNote(str(a.verdict) || str(a.value) || 'Looked at it');
    case 'timer': return withNote(timerText(a.event));
    case 'record': return withNote(recordText(a.seconds));
    case 'upload': return withNote(uploadText(a, names));
    case 'checklist': return withNote(checklistText(a));
    case 'form': return formText(widget, a, names);
    case 'app': return appText(a, names);
    default: return withNote(str(a.value) || 'Done');
  }
}

/** The line on one line (the block's receipt, the to-do's summary): its lines joined with " · ", cut at `max`. */
export function oneLine(text: string, max = 300): string {
  return cut(text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · '), max);
}

/**
 * An older approve to-do answered "No": by the approve card, or by the Yes/No choice its fence renders as since B-078
 * (the stored widget stays 'approve' while the chat shows a choice).
 */
function approvedNo(a: Record<string, unknown>): boolean {
  if (a.approved === false) return true;
  const said = (Array.isArray(a.choices) ? strings(a.choices) : strings(a.choice ?? a.value)).map((value) => value.toLowerCase());
  return said.includes('no');
}

/** The picked options by the text the person saw (an option's label; a free "Other" text as typed). */
function picked(widget: NonNullable<AnswerWidget>, a: Record<string, unknown>): string {
  const options = Array.isArray(widget.options) ? widget.options : [];
  const label = (value: string): string => {
    for (const option of options) {
      if (!option || typeof option !== 'object') continue;
      const o = option as Record<string, unknown>;
      if ((str(o.value) || str(o.label)) === value && str(o.label)) return str(o.label);
    }
    return value;
  };
  const values = Array.isArray(a.choices) ? strings(a.choices) : strings(a.choice ?? a.value);
  return values.map(label).join(', ');
}

function timerText(event: unknown): string {
  switch (event) {
    case undefined: case 'done': return 'Done';
    case 'snoozed': return 'Snoozed';
    case 'missed': return 'Missed';
    default: return str(event) || 'Done';
  }
}

function recordText(seconds: unknown): string {
  const total = Math.round(Number(seconds) || 0);
  return total > 0 ? `Recorded ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` : 'Recorded';
}

/** A file's name: the store's for a stored id (an id it does not know reads "a file"), a path's last part. */
function fileName(ref: string, names?: FileNames): string | undefined {
  if (FILE_ID.test(ref)) return names?.(ref) ?? (names ? undefined : 'a file');
  return ref.split(/[\\/]/).pop() || ref;
}

function uploadText(a: Record<string, unknown>, names?: FileNames): string {
  const refs = Array.isArray(a.files) ? a.files : [];
  const given = Array.isArray(a.names) ? a.names : [];
  const shown = refs.map((ref, i) => {
    if (typeof ref !== 'string' || !ref.trim()) return undefined;
    // Without the store (the UI's own receipt) the names the widget sent stand in.
    if (FILE_ID.test(ref) && !names) return str(given[i]) || 'a file';
    return fileName(ref.trim(), names);
  }).filter((name): name is string => Boolean(name));
  const unique = [...new Set(shown)];
  if (unique.length) return `Uploaded ${unique.join(', ')}`;
  return refs.length ? `Uploaded ${refs.length} file${refs.length === 1 ? '' : 's'}` : 'Uploaded';
}

function checklistText(a: Record<string, unknown>): string {
  const checked = strings(a.checked);
  const open = strings(a.open);
  const lines = [checked.length ? `Checked: ${checked.join(', ')}` : 'Nothing checked'];
  if (open.length) lines.push(`Still open: ${open.join(', ')}`);
  return lines.join('\n');
}

/** A value as plain text: yes/no, lists joined, a stored file by its name, a secret's handle as it is. */
function plain(value: unknown, names?: FileNames): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return FILE_ID.test(value.trim()) ? fileName(value.trim(), names) ?? 'a file' : value.trim();
  if (Array.isArray(value)) return value.map((item) => plain(item, names)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const id = str(o.fileId);
    if (FILE_ID.test(id)) return fileName(id, names) ?? (str(o.name) || 'a file');
    try { return JSON.stringify(value) ?? ''; } catch { return ''; }
  }
  return String(value);
}

/** One "Label: value" line per filled field, in the form's order, then values the form does not name. */
function formText(widget: NonNullable<AnswerWidget>, a: Record<string, unknown>, names?: FileNames): string {
  const values = a.values && typeof a.values === 'object' && !Array.isArray(a.values) ? a.values as Record<string, unknown> : {};
  const fields = (Array.isArray(widget.fields) ? widget.fields : []).filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object');
  const lines: string[] = [];
  const named = new Set<string>();
  for (const field of fields) {
    const name = str(field.name);
    if (!name) continue;
    named.add(name);
    const raw = plain(values[name], names);
    // A secret field shows only its secret:// handle; a typed value (the UI's optimistic receipt) reads "saved".
    const text = field.kind === 'secret' && raw && !raw.startsWith('secret://') ? 'saved' : raw;
    if (text) lines.push(`${str(field.label) || name}: ${cut(text, 4000)}`);
  }
  for (const [name, value] of Object.entries(values)) {
    const text = named.has(name) ? '' : plain(value, names);
    if (text) lines.push(`${name}: ${cut(text, 4000)}`);
  }
  const note = str(a.note);
  if (note) lines.push(note);
  return lines.length ? lines.join('\n') : 'Sent';
}

/** A mini-app to-do: "Done in mini-app" and the data its app handed back ("Mark done" by hand says that instead). */
function appText(a: Record<string, unknown>, names?: FileNames): string {
  const note = str(a.note);
  if (a.manual === true) return note || 'Marked done by hand';
  const data = Object.entries(a).filter(([key, value]) => key !== 'note' && !(key === 'done' && value === true)) // done: true says nothing more
    .map(([key, value]) => { const text = plain(value, names); return text ? `${key}: ${cut(text, VALUE_CAP)}` : ''; })
    .filter(Boolean);
  return ['Done in mini-app', ...(data.length ? [cut(data.join('\n'), APP_DATA_CAP)] : []), ...(note ? [note] : [])].join('\n');
}
