// Name | Value rows for secrets (owner 04.11.2026: name and value side by side, paste a
// .env, drop a file, "like the cron jobs, not a pop-up"): rows of [Name][Value •••][×] with one empty row always at the
// end; a pasted .env or JSON splits into rows (secret-groups.ts pastedRows). SecretBand is the Secrets page's fixed slot
// above the catalog: Add (secrets.save, the kind from the name), Choose file… (secrets.import), and 'Login, card or
// fields…' or a catalog row's Edit swap its content for SecretForm in the same slot; one reserved line holds results and
// errors; a right-click (long press) on the rows' band lists where each browser exports, whole, and copies its address;
// the slot and the catalog under it take a dropped file (colour only). ChatSecretBar is
// the composer's secret mode (Plus › Secret) above the text: each row goes to secrets.capture and comes back as a chip;
// × or Esc leaves it. Both keep one fixed height, so nothing below or beside them moves.
// Owns: these rows and their actions. Never: puts a value in a draft, a message, storage or a log – values live only in
// this component's state until they are sent.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { newId } from '../../shared/ids.ts';
import { kindForName } from '../../shared/model/key-values.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { Button, Icon } from '../lib/ui.tsx';
import { BandFoot, SecretForm, type SecretTarget } from './SecretForm.tsx';
import { BAND_HINT, exportMenu, importLine, pastedRows, readyRows, withEmptyRow, type KvRow } from './secret-groups.ts';

const MAX_BYTES = 5 * 1024 * 1024;
/** AF-005: the same rows for a connector's headers and variables (apps-server.tsx). */
export { Rows as NameValueRows };
const fresh = (): KvRow => ({ id: newId('req'), name: '', value: '' });
const textOf = (event: Event) => (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;

interface Line { text: string; tone: 'muted' | 'error' | 'ok' }

/** The rows of both variants; Enter in a field is `onEnter` (Shift+Enter: a line break in a value). */
function Rows(props: { rows: KvRow[]; onChange: (rows: KvRow[]) => void; onEnter: () => void }) {
  const { rows, onChange } = props;
  const set = (index: number, patch: Partial<KvRow>) => onChange(withEmptyRow(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)), fresh));
  const paste = (index: number, field: 'name' | 'value') => (event: ClipboardEvent) => {
    const next = pastedRows(rows, index, field, event.clipboardData?.getData('text') ?? '', fresh);
    if (next) { event.preventDefault(); onChange(next); }
  };
  return (
    <div class="secret-kv-rows" onKeyDown={(event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || (event.target as HTMLElement).tagName === 'BUTTON') return;
      event.preventDefault();
      props.onEnter();
    }}>
      {rows.map((row, index) => (
        <div key={row.id} class="secret-kv-row">
          <input class="input" aria-label={`Name ${index + 1}`} placeholder="Name" maxLength={120} autocomplete="off" spellcheck={false}
            value={row.name} onInput={(event) => set(index, { name: textOf(event) })} onPaste={paste(index, 'name')} />
          <textarea class="input secret-kv-value" rows={1} aria-label={`Value ${index + 1}`} placeholder="Value" autocomplete="off" spellcheck={false} maxLength={16_384}
            value={row.value} onInput={(event) => set(index, { value: textOf(event) })} onPaste={paste(index, 'value')} />
          {index === rows.length - 1 && !row.name && !row.value
            ? <span class="secret-kv-gap" aria-hidden="true" />
            : <button type="button" class="icon-button small" aria-label={`Remove row ${index + 1}`} title="Remove" onClick={() => onChange(withEmptyRow(rows.filter((_, at) => at !== index), fresh))}><Icon name="x" size={16} /></button>}
        </div>
      ))}
    </div>
  );
}

/** What the slot shows instead of the rows: SecretForm for a new login, card or fields (no target) or a catalog entry. */
export interface BandForm { key: string; target?: SecretTarget }

/** Settings › Secrets: the fixed slot above the catalog (`children`, which the drop zone includes). `onForm(true)`: a new entry's form. */
export function SecretBand(props: { form?: BandForm; onForm: (open: boolean) => void; onSaved: () => void; children: ComponentChildren }) {
  const [rows, setRows] = useState<KvRow[]>(() => [fresh()]);
  const [line, setLine] = useState<Line | undefined>(undefined);
  const [busy, setBusy] = useState<'' | 'add' | 'import'>('');
  const [over, setOver] = useState(false);
  const bandRef = useRef<HTMLDivElement>(null); // the band, not the drop zone: that holds the whole catalog and is taller than the view
  const canImport = can('secrets.import');
  useEffect(() => { if (props.form) bandRef.current?.scrollIntoView({ block: 'nearest' }); }, [props.form?.key]);
  const { ready, blocked } = readyRows(rows, true);

  const run = async (kind: 'add' | 'import', work: () => Promise<Line>) => {
    if (busy) return;
    setBusy(kind);
    try { setLine(await work()); } finally { setBusy(''); }
  };
  const add = () => void run('add', async () => {
    if (blocked) return { text: blocked, tone: 'error' };
    const left: KvRow[] = [];
    let added = 0;
    let failure = '';
    for (const row of rows) {
      if (!ready.includes(row)) { left.push(row); continue; }
      try {
        await rpc.call('secrets.save', { label: row.name.trim(), kind: kindForName(row.name), value: row.value, description: '' });
        added++;
      } catch (error) { left.push(row); failure ||= errorText(error); }
    }
    setRows(withEmptyRow(left, fresh));
    if (added) props.onSaved();
    if (failure) return { text: `${added} added · ${failure}`, tone: 'error' };
    return { text: `${added} ${added === 1 ? 'secret' : 'secrets'} added – agents use each by its handle`, tone: 'ok' };
  });
  const importFiles = (files: File[]) => void run('import', async () => {
    setLine({ text: 'Importing…', tone: 'muted' });
    const lines: string[] = [];
    let failed = false;
    for (const file of files) {
      try {
        if (file.size > MAX_BYTES) throw new Error('The file is larger than 5 MB.');
        lines.push(importLine(await rpc.call('secrets.import', { text: await file.text(), fileName: file.name })));
      } catch (error) { lines.push(`${file.name}: ${errorText(error)}`); failed = true; }
    }
    props.onSaved();
    return { text: lines.join(' '), tone: failed ? 'error' : 'ok' };
  });
  const pick = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) importFiles(files);
  };
  const carriesFiles = (event: DragEvent) => canImport && Boolean(event.dataTransfer?.types.includes('Files'));
  const sources = useContextMenu(() => exportMenu((address) => {
    navigator.clipboard.writeText(address).then(() => setLine({ text: `Copied ${address} – open it in that browser`, tone: 'ok' }), (error: unknown) => setLine({ text: errorText(error), tone: 'error' }));
  }));

  return (
    <div class={`secret-drop${over ? ' drop-over' : ''}`}
      onDragOver={(event) => { if (carriesFiles(event)) { event.preventDefault(); setOver(true); } }}
      onDragLeave={(event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(event) => { if (!carriesFiles(event)) return; event.preventDefault(); setOver(false); importFiles([...(event.dataTransfer?.files ?? [])]); }}>
      <div ref={bandRef} class="secret-band" role="group" aria-label="Add secrets" {...(canImport && !props.form ? sources : {})}>
        {props.form
          ? <SecretForm key={props.form.key} target={props.form.target} onCancel={() => props.onForm(false)} onDone={() => { props.onForm(false); props.onSaved(); }} />
          : (
            <>
              <div class="secret-band-body"><Rows rows={rows} onChange={(next) => { setRows(next); setLine(undefined); }} onEnter={add} /></div>
              <BandFoot line={line?.text ?? BAND_HINT} tone={line?.tone ?? 'muted'}>
                <Button variant="primary" class="small" busy={busy === 'add'} disabled={!ready.length || busy !== ''} onClick={add}>Add</Button>
                {canImport && (
                  <label class="button secondary small">
                    Choose file…
                    <input type="file" hidden multiple onChange={pick} />
                  </label>
                )}
                <button type="button" class="button ghost small secret-band-more" onClick={() => props.onForm(true)}>Login, card or fields…</button>
              </BandFoot>
            </>
          )}
      </div>
      {props.children}
    </div>
  );
}

/** The composer's secret mode: rows above the text; each row with a value goes to the vault and comes back as a chip (`room`: how many more fit). */
export function ChatSecretBar(props: { conversationId: string; room: number; onAttach: (id: string) => void; onLeave: () => void }) {
  const [rows, setRows] = useState<KvRow[]>(() => [fresh()]);
  const [line, setLine] = useState<Line | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('.secret-kv-value')?.focus(); }, []); // a pasted value lands masked
  const { ready, blocked } = readyRows(rows, false);

  const attach = async () => {
    if (busy) return;
    if (blocked || ready.length > props.room) { setLine({ text: blocked || `A message carries at most 20 secrets – ${props.room} more fit.`, tone: 'error' }); return; }
    setBusy(true);
    const left: KvRow[] = [];
    let failure = '';
    try {
      for (const row of rows) {
        if (!ready.includes(row)) { left.push(row); continue; }
        try {
          const info = await rpc.call('secrets.capture', { conversationId: props.conversationId, value: row.value, description: row.name.trim(), clientId: row.id });
          props.onAttach(info.id);
        } catch (error) { left.push(row); failure ||= errorText(error); }
      }
    } finally { setBusy(false); }
    if (!failure) { props.onLeave(); return; }
    setRows(withEmptyRow(left, fresh));
    setLine({ text: failure, tone: 'error' });
  };

  return (
    <div ref={ref} class="secret-band chat" role="group" aria-label="Secret"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onLeave(); } }}>
      <div class="secret-band-body"><Rows rows={rows} onChange={(next) => { setRows(next); setLine(undefined); }} onEnter={() => void attach()} /></div>
      <BandFoot line={line?.text ?? 'Stored encrypted; agents use it by its handle'} tone={line?.tone ?? 'muted'}>
        <Button variant="primary" class="small" busy={busy} disabled={!ready.length} onClick={() => void attach()}>Attach</Button>
        <button type="button" class="icon-button small secret-band-close" aria-label="Leave secret mode" title="Back to the message (Esc)" onClick={props.onLeave}><Icon name="x" size={16} /></button>
      </BandFoot>
    </div>
  );
}
