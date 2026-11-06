// Settings › Apps › "Add an app": a search over the one-click catalog in a list box of one fixed height (typing never moves what
// is below it; nothing found offers the AI, which also searches the MCP registry), each with Connect, and two rows that open a
// dialog: an MCP server by address or command, and a mailbox. A token dialog serves a catalog entry that needs a key and a
// connected app that asks for one. Each writes one entry of the connector files (apps-files.ts); the runtime connects, a server
// that signs in opens the browser, and the Connected row shows how it went.
// Owns: these rows and dialogs. Never: keeps a typed token or password after saving, writes one into a file, or logs it.

import { useState } from 'preact/hooks';
import type { ConnectedApp } from '../../shared/model/apps.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { openExternal } from '../lib/platform.ts';
import { errorText } from '../lib/rpc.ts';
import { Button } from '../lib/ui.tsx';
import { setUpWithAi } from '../team/set-up-with-ai.ts';
import { ActionButton, Group, Row, Segmented, useBusy } from './controls.tsx';
import { APP_CATALOG, catalogConnected, searchCatalog, type CatalogEntry } from './apps-catalog.ts';
import { editConnectors, fileOf, mailEntry, nameFromAddress, splitCommand, storeKey, tokenHeaders, withEntry, withToken, type MailFields } from './apps-files.ts';

const valueOf = (event: Event) => (event.currentTarget as HTMLInputElement).value;
const addMcp = (name: string, entry: Record<string, unknown>) => editConnectors('mcp.json', (text) => withEntry('mcp.json', text, name, entry));
const storeToken = (name: string, token: string) => storeKey(`${name} token`, 'token', token, `Connects the app ${name} (Settings › Apps).`);

/** What the token dialog is for: a catalog entry to connect or a connected app. */
export type TokenTarget = { kind: 'catalog'; entry: CatalogEntry } | { kind: 'app'; app: ConnectedApp };

function TokenForm(props: { target: TokenTarget; onClose: () => void }) {
  const { target } = props;
  const name = target.kind === 'catalog' ? target.entry.name : target.app.name;
  const hint = target.kind === 'catalog' ? target.entry.tokenHint : APP_CATALOG.find((entry) => catalogConnected(entry, [target.app.address]))?.tokenHint;
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const save = () => void run(async () => {
    setError('');
    try {
      const secretId = await storeToken(name, token.trim());
      if (target.kind === 'catalog') await addMcp(name, { url: target.entry.url, headers: tokenHeaders(secretId) });
      else await editConnectors(fileOf(target.app), (text) => withToken(fileOf(target.app), text, name, secretId));
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  return (
    <>
      <label class="field-label" for="apps-token">{hint?.label ?? 'Token'}</label>
      <input id="apps-token" class="input" type="password" autocomplete="off" spellcheck={false} value={token} onInput={(event) => setToken(valueOf(event))} />
      <DialogActions message={error || 'Goes into Secrets; the file holds only its handle'} tone={error ? 'error' : 'muted'}>
        {hint && <Button variant="ghost" onClick={() => openExternal(hint.createUrl)}>Create one</Button>}
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!token.trim()} onClick={save}>Connect</Button>
      </DialogActions>
    </>
  );
}

export function TokenDialog(props: { target: TokenTarget | null; onClose: () => void }) {
  const { target } = props;
  const name = target?.kind === 'catalog' ? target.entry.name : target?.app.name;
  return (
    <Dialog open={target !== null} onClose={props.onClose} title={name ? `Connect ${name}` : undefined} width={520} class="secret-edit anchored">
      {target && <TokenForm target={target} onClose={props.onClose} />}
    </Dialog>
  );
}

function CatalogRow(props: { entry: CatalogEntry; connected: boolean; onToken: () => void }) {
  const { entry } = props;
  const [busy, run] = useBusy();
  const connect = () => { if (entry.auth === 'token') props.onToken(); else void run(() => addMcp(entry.name, { url: entry.url })); };
  const menu = entry.tokenHint && !props.connected ? () => [{ items: [{ label: 'Connect with a token', onSelect: props.onToken }] }] : undefined;
  return (
    <Row label={entry.name} hint={entry.blurb} reserve {...(menu ? { menu } : {})}>
      <span class="account-slot">
        <ActionButton label={props.connected ? 'Connected' : 'Connect'} busy={busy} disabled={props.connected} onClick={connect} />
      </span>
    </Row>
  );
}

type ServerKind = 'url' | 'command';
const SERVER_KINDS: Array<{ value: ServerKind; label: string }> = [{ value: 'url', label: 'Web address' }, { value: 'command', label: 'Command on this PC' }];

function ServerForm(props: { onClose: () => void }) {
  const [kind, setKind] = useState<ServerKind>('url');
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const target = address.trim();
  const blocked = !target ? (kind === 'url' ? 'Enter the MCP address the server names for AI tools' : 'Enter the command that starts the server')
    : kind === 'url' && !/^https?:\/\/\S+$/i.test(target) ? 'Enter an address that starts with https://' : '';
  const save = () => void run(async () => {
    setError('');
    try {
      const { command, args } = splitCommand(target);
      const label = name.trim() || nameFromAddress(kind === 'url' ? target : command);
      const headers = kind === 'url' && token.trim() ? { headers: tokenHeaders(await storeToken(label, token.trim())) } : {};
      await addMcp(label, kind === 'url' ? { url: target, ...headers } : { command, args });
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  return (
    <>
      <Segmented label="How it runs" value={kind} options={SERVER_KINDS} onChange={setKind} />
      <label class="field-label" for="apps-address">{kind === 'url' ? 'Address' : 'Command'}</label>
      <input id="apps-address" class="input" autocomplete="off" spellcheck={false} placeholder={kind === 'url' ? 'https://…' : 'npx -y @modelcontextprotocol/server-filesystem C:/Docs'} value={address} onInput={(event) => setAddress(valueOf(event))} />
      <label class="field-label" for="apps-name">Name (optional)</label>
      <input id="apps-name" class="input" autocomplete="off" maxLength={60} value={name} onInput={(event) => setName(valueOf(event))} />
      <label class="field-label" for="apps-server-token">Token (optional)</label>
      <input id="apps-server-token" class="input" type="password" autocomplete="off" spellcheck={false} disabled={kind !== 'url'} value={token} onInput={(event) => setToken(valueOf(event))} />
      <DialogActions message={error || blocked} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(blocked)} onClick={save}>Connect</Button>
      </DialogActions>
    </>
  );
}

const NO_MAIL: MailFields = { address: '', password: '', imapHost: '', imapPort: '', smtpHost: '', smtpPort: '' };

function MailForm(props: { onClose: () => void }) {
  const [fields, setFields] = useState(NO_MAIL);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const { blocked, entry } = mailEntry(fields);
  const input = (key: keyof MailFields, id: string, label: string, more: { type?: string; placeholder?: string } = {}) => (
    <>
      <label class="field-label" for={id}>{label}</label>
      <input id={id} class="input" autocomplete="off" spellcheck={false} {...more} value={fields[key]} onInput={(event) => setFields({ ...fields, [key]: valueOf(event) })} />
    </>
  );
  const save = () => void run(async () => {
    setError('');
    try {
      const address = fields.address.trim();
      const password = `secret://${await storeKey(address, 'password', fields.password, `Password of the mailbox ${address} (Settings › Apps).`)}`;
      await editConnectors('mail.json', (text) => withEntry('mail.json', text, address, { ...entry, password }));
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  return (
    <>
      {input('address', 'apps-mail-address', 'Email address', { placeholder: 'name@example.com' })}
      {input('password', 'apps-mail-password', 'Password (Gmail, iCloud and Yahoo need an app password)', { type: 'password' })}
      <div class="apps-mail-servers">
        <div>{input('imapHost', 'apps-mail-imap', 'IMAP server (optional)', { placeholder: 'found from the address' })}</div>
        <div>{input('imapPort', 'apps-mail-imap-port', 'Port', { placeholder: '993' })}</div>
        <div>{input('smtpHost', 'apps-mail-smtp', 'SMTP server (optional)', { placeholder: 'found from the address' })}</div>
        <div>{input('smtpPort', 'apps-mail-smtp-port', 'Port', { placeholder: '465' })}</div>
      </div>
      <DialogActions message={error || blocked} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(blocked)} onClick={save}>Connect</Button>
      </DialogActions>
    </>
  );
}

/** "Add an app"; `apps`: the connected ones (a catalog entry of theirs says Connected). */
export function AddApps(props: { apps: readonly ConnectedApp[] }) {
  const [query, setQuery] = useState('');
  const [token, setToken] = useState<TokenTarget | null>(null);
  const [form, setForm] = useState<'server' | 'mail' | null>(null);
  const hits = searchCatalog(query);
  const addresses = props.apps.map((app) => app.address);
  return (
    <Group title="Add an app" id="apps-add">
      <input class="input apps-search" type="search" aria-label="Search apps" placeholder="Search apps" autocomplete="off" spellcheck={false} value={query} onInput={(event) => setQuery(valueOf(event))} />
      <div class="apps-list" role="region" aria-label="Apps to add">
        {hits.map((entry) => <CatalogRow key={entry.url} entry={entry} connected={catalogConnected(entry, addresses)} onToken={() => setToken({ kind: 'catalog', entry })} />)}
        {!hits.length && (
          <Row label={`"${query.trim()}" is not in this list`} hint="The AI can look for its MCP server or call its API directly" reserve>
            <span class="account-slot"><ActionButton label="Ask the AI" onClick={() => void setUpWithAi(`Connect an app: ${query.trim()}`)} /></span>
          </Row>
        )}
      </div>
      <Row label="Add by address" hint="Any MCP server, by its web address or a command on this PC" reserve>
        <span class="account-slot"><ActionButton label="Add" onClick={() => setForm('server')} /></span>
      </Row>
      <Row label="Add email" hint="A mailbox agents read, sort, draft and send from; new mail wakes an agent" reserve>
        <span class="account-slot"><ActionButton label="Add" onClick={() => setForm('mail')} /></span>
      </Row>
      <TokenDialog target={token} onClose={() => setToken(null)} />
      <Dialog open={form !== null} onClose={() => setForm(null)} title={form === 'mail' ? 'Add email' : 'Add by address'} width={520} class="secret-edit anchored">
        {form === 'server' && <ServerForm onClose={() => setForm(null)} />}
        {form === 'mail' && <MailForm onClose={() => setForm(null)} />}
      </Dialog>
    </Group>
  );
}
