// Change lists: after browser.act / browser.batch / browser.wait the agent reads what changed
// against its last snapshot of that tab – lines added and removed, a new dialog, the new address or
// title – instead of the whole snapshot again. The whole snapshot comes when asked (`full`), when there
// is no earlier snapshot of the tab, when the document changed (another address without only a new
// #hash) or when most of the page changed (MOST of the lines). Lines are compared as a multiset of
// trimmed lines (refs stay stable within a document, so an unchanged element is an equal line).
// Owns: the comparison and its text. Never: reads pages.

/** Share of changed lines from which the whole snapshot is sent instead. */
export const MOST = 0.6;
const MAX_ADDED = 60;
const MAX_REMOVED = 25;
const LINE_MAX = 240;

export interface SnapshotChanges {
  /** The text the agent reads: the change list, or the whole snapshot. */
  text: string;
  /** True when `text` is the whole snapshot. */
  full: boolean;
  added: number;
  removed: number;
}

const clean = (line: string) => line.trim().replace(/^- /, '');
const clip = (line: string) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line);
const DIALOG = /^(alertdialog|dialog)\b/;

function sameDocument(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return before === after;
  }
}

function counts(lines: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}

/** Lines of `a` not matched by a line of `b` (multiset difference), in `a`'s order. */
function minus(a: readonly string[], b: Map<string, number>): string[] {
  const left = new Map(b);
  const out: string[] = [];
  for (const line of a) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else out.push(line);
  }
  return out;
}

export interface ChangeInput {
  /** The agent's last snapshot of the tab (undefined: none yet, or the person changed it since). */
  before?: string;
  after: string;
  urlBefore: string;
  url: string;
  titleBefore?: string;
  title: string;
  /** The whole snapshot was asked for. */
  full?: boolean;
}

export function snapshotChanges(input: ChangeInput): SnapshotChanges {
  const after = input.after.split('\n').map(clean).filter(Boolean);
  const whole = (why: string): SnapshotChanges => ({ text: why ? `${why}\n${input.after}` : input.after, full: true, added: after.length, removed: 0 });
  if (input.full) return whole('');
  if (input.before === undefined) return whole('');
  if (!sameDocument(input.urlBefore, input.url)) return whole(`New page (was ${input.urlBefore}):`);
  const before = input.before.split('\n').map(clean).filter(Boolean);
  const added = minus(after, counts(before));
  const removed = minus(before, counts(after));
  const total = Math.max(before.length, after.length, 1);
  if ((added.length + removed.length) / 2 / total >= MOST && added.length + removed.length > 6) return whole('Most of the page changed:');
  const lines: string[] = [];
  if (input.titleBefore !== undefined && input.titleBefore !== input.title) lines.push(`Title now "${input.title}".`);
  if (input.urlBefore !== input.url) lines.push(`Address now ${input.url}.`);
  const dialogs = added.filter((line) => DIALOG.test(line));
  for (const dialog of dialogs.slice(0, 3)) lines.push(`New dialog: ${clip(dialog)}`);
  if (!added.length && !removed.length) {
    lines.push('No change in the page since my last snapshot of this tab.');
  } else {
    lines.push(`Changes since my last snapshot of this tab (+${added.length} −${removed.length} lines; browser.snapshot shows all):`);
    for (const line of added.slice(0, MAX_ADDED)) lines.push(`+ ${clip(line)}`);
    if (added.length > MAX_ADDED) lines.push(`+ … ${added.length - MAX_ADDED} more`);
    for (const line of removed.slice(0, MAX_REMOVED)) lines.push(`− ${clip(line)}`);
    if (removed.length > MAX_REMOVED) lines.push(`− … ${removed.length - MAX_REMOVED} more`);
  }
  return { text: lines.join('\n'), full: false, added: added.length, removed: removed.length };
}
