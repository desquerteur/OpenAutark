// AF-005 Settings › Connectors › "Own MCP server": one form for a web server (HTTP / SSE: address, an optional token,
// headers) or a program on this PC (stdio: command, arguments, folder, environment variables), and "Paste JSON" for the
// mcpServers config Claude Desktop and Claude Code use, checked as it is typed (mcp-import.ts) with every error named.
// Both write mcp.json through saveServers (apps-files.ts): every value of the Name | Value rows and the token go into
// Secrets first and the file holds their handles; the runtime connects and the Connected row shows how it went.
// Owns: these two forms. Never: keeps a typed value after saving, writes one into a file, or logs it.

import { useState } from 'preact/hooks';
import { newId } from '../../shared/ids.ts';
import { DialogActions } from '../lib/dialog.tsx';
import { errorText } from '../lib/rpc.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { Segmented, useBusy } from './controls.tsx';
import { saveServers } from './apps-files.ts';
import { NO_SERVER, serverDraft, type ServerFields, type ServerKind } from './apps-server-entry.ts';
import { checkImport, importSummary } from './mcp-import.ts';
import { NameValueRows } from './SecretRows.tsx';
import { withEmptyRow, type KvRow } from './secret-groups.ts';

const valueOf = (event: Event) => (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
const fresh = (): KvRow => ({ id: newId('req'), name: '', value: '' });
const KINDS: Array<{ value: ServerKind; label: string }> = [{ value: 'url', label: 'Web address (HTTP)' }, { value: 'command', label: 'Command on this PC (stdio)' }];

function connected(names: readonly string[]): void {
  pushToast({ title: names.length === 1 ? `${names[0]} added` : `${names.length} servers added`, body: 'It connects now – its row shows how it went' });
}

export function ServerForm(props: { onClose: () => void }) {
  const [fields, setFields] = useState<ServerFields>({ ...NO_SERVER, rows: [fresh()] });
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const set = (patch: Partial<ServerFields>) => setFields({ ...fields, ...patch });
  const { blocked, server } = serverDraft(fields);
  const url = fields.kind === 'url';
  const save = () => void run(async () => {
    setError('');
    try {
      if (!server) return;
      connected(await saveServers([server]));
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  const input = (key: 'address' | 'args' | 'cwd' | 'name' | 'token', id: string, label: string, more: { type?: string; placeholder?: string; maxLength?: number } = {}) => (
    <>
      <label class="field-label" for={id}>{label}</label>
      <input id={id} class="input" autocomplete="off" spellcheck={false} {...more} value={fields[key]} onInput={(event) => set({ [key]: valueOf(event) })} />
    </>
  );
  return (
    <>
      <Segmented label="How it runs" value={fields.kind} options={KINDS} onChange={(kind) => set({ kind, rows: [fresh()] })} />
      {url
        ? input('address', 'apps-address', 'Address', { placeholder: 'https://…/mcp' })
        : input('address', 'apps-address', 'Command', { placeholder: 'npx -y @modelcontextprotocol/server-filesystem C:/Docs' })}
      {!url && input('args', 'apps-args', 'More arguments (optional)', { placeholder: '--read-only "C:/My files"' })}
      {!url && input('cwd', 'apps-cwd', 'Folder it starts in (optional)')}
      {input('name', 'apps-name', 'Name (optional)', { maxLength: 60 })}
      {url && input('token', 'apps-server-token', 'Token (optional, sent as Authorization: Bearer …)', { type: 'password' })}
      <div class="field-label apps-rows-label">{url ? 'Headers (optional)' : 'Environment variables (optional)'}</div>
      <div class="apps-rows">
        <NameValueRows rows={fields.rows} onChange={(rows) => set({ rows: withEmptyRow(rows, fresh) })} onEnter={() => { if (!blocked && !busy) save(); }} />
      </div>
      <p class="secret-field-hint">Each value goes into Secrets; mcp.json holds only its secret:// handle.</p>
      <DialogActions message={error || blocked} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(blocked)} onClick={save}>Connect</Button>
      </DialogActions>
    </>
  );
}

export function ImportForm(props: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const check = checkImport(text);
  const lines = text.trim() ? (check.errors.length ? check.errors : importSummary(check)) : [];
  const notes = check.errors.length ? [] : check.servers.flatMap((server) => server.notes);
  const blocked = !text.trim() ? 'Paste the "mcpServers" JSON from Claude Desktop, Claude Code or Cursor' : check.errors.length ? `${check.errors.length === 1 ? 'One problem' : `${check.errors.length} problems`} – fix the JSON first` : '';
  const save = () => void run(async () => {
    setError('');
    try {
      connected(await saveServers(check.servers));
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  return (
    <>
      <label class="field-label" for="apps-import">JSON</label>
      <textarea id="apps-import" class="input apps-import-text" spellcheck={false} autocomplete="off"
        placeholder={'{\n  "mcpServers": {\n    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Docs"] }\n  }\n}'}
        value={text} onInput={(event) => setText(valueOf(event))} />
      <ul class={`apps-import-check${check.errors.length ? ' error' : ''}`} aria-live="polite" aria-label="Check">
        {lines.map((line) => <li key={line}>{line}</li>)}
        {notes.map((line) => <li key={line} class="note">{line}</li>)}
      </ul>
      <DialogActions message={error || blocked || 'Keys in "env" and "headers" go into Secrets; the file gets their handles'} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(blocked)} onClick={save}>{check.servers.length > 1 ? `Add ${check.servers.length} servers` : 'Add'}</Button>
      </DialogActions>
    </>
  );
}
