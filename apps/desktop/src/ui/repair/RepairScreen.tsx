// The repair screen (23.10.2026): replaces the whole app while the runtime runs in repair mode (a
// broken upgrade, data of a newer version, a failed safety copy, damaged data or a crash loop at
// start). It says what happened in plain words with the technical line below, and offers Try
// again, Restore for each copy from before an update this version can open (after a confirmation;
// the replaced data is kept) and Export diagnostics (a redacted file shown in the file manager).
// A retry or restore stays busy only until the restarted runtime answers again (screenStatus): when
// it lands on the repair screen again, every button works again and the screen says so.
// Owns: the screen. Never: changes data itself (the runtime does on the person's click), or shows a
// secret (the problem detail is redacted by the runtime).

import { useState } from 'preact/hooks';
import type { RepairState } from '../../shared/model/repair.ts';
import { confirm, ConfirmHost } from '../lib/dialog.tsx';
import { errorText } from '../lib/rpc.ts';
import { fullDate } from '../lib/format.ts';
import { Button, Icon } from '../lib/ui.tsx';
import { copyLabel, problemText, restorable, screenStatus, type LastAction, type RepairAction } from './repair-text.ts';
import { exportDiagnostics, restoreCopy, retryStart } from './repair-state.ts';

export function RepairScreen(props: { state: RepairState }) {
  const { state } = props;
  const problem = state.problem;
  const [last, setLast] = useState<LastAction | null>(null);
  if (!problem) return null;
  const copies = state.backups.filter((copy) => restorable(copy, state.appSchema));
  const text = problemText(problem, copies);
  const { busy, note } = screenStatus(last, state);

  const run = async (kind: RepairAction, action: () => Promise<string>) => {
    const on = state;
    setLast({ kind, state: on, done: false });
    try {
      const done = await action();
      // Retry and restore restart the runtime: they stay busy until it answers again (a new state).
      setLast({ kind, state: on, done: kind === 'diagnostics', note: { text: done } });
    } catch (error) {
      setLast({ kind, state: on, done: true, note: { text: errorText(error), error: true } });
    }
  };
  const retry = () => run('retry', async () => { await retryStart(); return 'Starting again…'; });
  const diagnostics = () => run('diagnostics', async () => `Saved to ${(await exportDiagnostics()).path}`);
  const restore = async (id: string, label: string) => {
    const ok = await confirm({
      title: 'Restore this copy?',
      body: `${label}. Your current data is moved to a separate folder in the data folder and kept. Changes made after this copy are not in it.`,
      confirmLabel: 'Restore',
    });
    if (ok) await run(`restore:${id}`, async () => { await restoreCopy(id); return 'Restored. Starting again…'; });
  };
  const newer = state.backups.length - copies.length;

  return (
    <div class="repair-view">
      <section class="repair-card" role="alert" aria-labelledby="repair-title">
        <Icon name="warning-circle" size={28} />
        <h1 id="repair-title">{text.title}</h1>
        {text.body.map((line) => <p key={line}>{line}</p>)}
        {problem.detail && <p class="repair-detail">{problem.detail}</p>}
        <div class="repair-actions">
          <Button variant="primary" busy={busy === 'retry'} disabled={busy !== null} onClick={() => void retry()}>Try again</Button>
          <Button busy={busy === 'diagnostics'} disabled={busy !== null && busy !== 'diagnostics'} onClick={() => void diagnostics()}>Export diagnostics</Button>
        </div>
        {copies.length > 0 && (
          <div class="repair-copies" aria-label="Copies from before updates">
            {copies.map((copy) => {
              const label = copyLabel(copy, fullDate);
              return (
                <div key={copy.id} class="repair-copy">
                  <span>{label}</span>
                  <Button busy={busy === `restore:${copy.id}`} disabled={busy !== null} onClick={() => void restore(copy.id, label)}>Restore</Button>
                </div>
              );
            })}
          </div>
        )}
        {newer > 0 && <p class="repair-muted">{newer === 1 ? 'One copy is' : `${newer} copies are`} from a newer version and cannot be opened here.</p>}
        {note && <p class={`repair-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}
      </section>
      <ConfirmHost />
    </div>
  );
}
