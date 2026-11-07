// Settings › Connectors › "Add a connector": a search over the one-click catalog in a list box of one fixed height (typing
// never moves what is below it; nothing found offers the AI, which also searches the MCP registry), each with Connect, and
// three rows that open a dialog: an own MCP server (AF-005: web address with headers, or a command with arguments and
// environment variables – apps-server.tsx), pasted JSON in the format of Claude Desktop / Claude Code (apps-server.tsx) and
// a mailbox. A key dialog serves a catalog entry that needs a token (GitHub) or the keys of a local server (Google, Slack,
// Discord) and a connected app that asks for one. Each writes entries of the connector files (apps-files.ts); the runtime
// connects, a server that signs in opens the browser, and the Connected row shows how it went.
// Owns: these rows and dialogs. Never: keeps a typed token or password after saving, writes one into a file, or logs it.

import { useState } from 'preact/hooks';
import type { ConnectedApp } from '../../shared/model/apps.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { openExternal } from '../lib/platform.ts';
import { errorText } from '../lib/rpc.ts';
import { Button } from '../lib/ui.tsx';
import { setUpWithAi } from '../team/set-up-with-ai.ts';
import { ActionButton, Group, Row, useBusy } from './controls.tsx';
import { APP_CATALOG, catalogConnected, catalogEntry, searchCatalog, type CatalogEntry, type CatalogKey } from './apps-catalog.ts';
import { editConnectors, fileOf, mailEntry, storeKey, tokenHeaders, withEntry, withToken, type MailFields } from './apps-files.ts';
import { ImportForm, ServerForm } from './apps-server.tsx';

const valueOf = (event: Event) => (event.currentTarget as HTMLInputElement).value;
const addMcp = (name: string, entry: Record<string, unknown>) => editConnectors('mcp.json', (text) => withEntry('mcp.json', text, name, entry));
const storeToken = (name: string, token: string) => storeKey(`${name} token`, 'token', token, `Connects the app ${name} (Settings › Connectors).`);

/** What the key dialog is for: a catalog entry to connect or a connected app. */
export type TokenTarget = { kind: 'catalog'; entry: CatalogEntry } | { kind: 'app'; app: ConnectedApp };

/** The fields the dialog asks for: one token, or the keys of a local catalog server. */
function keysOf(target: TokenTarget): readonly CatalogKey[] {
  if (target.kind === 'catalog' && target.entry.keys?.length) return target.entry.keys;
  const hint = target.kind === 'catalog' ? target.entry.tokenHint : APP_CATALOG.find((entry) => entry.url && catalogConnected(entry, [target.app.address]))?.tokenHint;
  return [{ env: '', label: hint?.label ?? 'Token' }];
}

function TokenForm(props: { target: TokenTarget; onClose: () => void }) {
  const { target } = props;
  const name = target.kind === 'catalog' ? target.entry.name : target.app.name;
  const hint = target.kind === 'catalog' ? target.entry.tokenHint : APP_CATALOG.find((entry) => entry.url && catalogConnected(entry, [target.app.address]))?.tokenHint;
  const keys = keysOf(target);
  const [values, setValues] = useState<string[]>(() => keys.map(() => ''));
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const save = () => void run(async () => {
    setError('');
    try {
      if (target.kind === 'catalog' && target.entry.keys?.length) {
        const handles: Record<string, string> = {};
        for (const [index, key] of target.entry.keys.entries()) {
          handles[key.env] = `secret://${await storeKey(`${name} · ${key.label}`, 'token', values[index].trim(), `Connects ${name} (Settings › Connectors).`)}`;
        }
        await addMcp(name, catalogEntry(target.entry, handles));
      } else {
        const secretId = await storeToken(name, values[0].trim());
        if (target.kind === 'catalog') await addMcp(name, { url: target.entry.url, headers: tokenHeaders(secretId) });
        else await editConnectors(fileOf(target.app), (text) => withToken(fileOf(target.app), text, name, secretId));
      }
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  const needs = target.kind === 'catalog' && target.entry.needs ? `Runs on this PC with ${target.entry.needs}. ` : '';
  return (
    <>
      {keys.map((key, index) => (
        <div key={key.env || 'token'} class="apps-key">
          <label class="field-label" for={`apps-token-${index}`}>{key.label}</label>
          <input id={`apps-token-${index}`} class="input" type="password" autocomplete="off" spellcheck={false} value={values[index]}
            onInput={(event) => setValues(values.map((value, at) => (at === index ? valueOf(event) : value)))} />
        </div>
      ))}
      <DialogActions message={error || `${needs}Goes into Secrets; the file holds only its handle`} tone={error ? 'error' : 'muted'}>
        {hint && <Button variant="ghost" onClick={() => openExternal(hint.createUrl)}>Create one</Button>}
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={values.some((value) => !value.trim())} onClick={save}>Connect</Button>
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
  const connect = () => { if (entry.auth === 'token' || entry.auth === 'keys') props.onToken(); else void run(() => addMcp(entry.name, catalogEntry(entry))); };
  const menu = entry.tokenHint && entry.auth !== 'keys' && !props.connected ? () => [{ items: [{ label: 'Connect with a token', onSelect: props.onToken }] }] : undefined;
  return (
    <Row label={entry.name} hint={entry.blurb} reserve {...(menu ? { menu } : {})}>
      <span class="account-slot">
        <ActionButton label={props.connected ? 'Connected' : 'Connect'} busy={busy} disabled={props.connected} onClick={connect} />
      </span>
    </Row>
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
      const password = `secret://${await storeKey(address, 'password', fields.password, `Password of the mailbox ${address} (Settings › Connectors).`)}`;
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

type FormKind = 'server' | 'json' | 'mail';
const FORM_TITLES: Readonly<Record<FormKind, string>> = { server: 'Own MCP server', json: 'Paste JSON', mail: 'Add email' };

/** "Add a connector"; `apps`: the connected ones (a catalog entry of theirs says Connected). */
export function AddApps(props: { apps: readonly ConnectedApp[] }) {
  const [query, setQuery] = useState('');
  const [token, setToken] = useState<TokenTarget | null>(null);
  const [form, setForm] = useState<FormKind | null>(null);
  const hits = searchCatalog(query);
  const addresses = props.apps.map((app) => app.address);
  const names = props.apps.map((app) => app.name);
  return (
    <Group title="Add a connector" id="apps-add">
      <input class="input apps-search" type="search" aria-label="Search apps" placeholder="Search GitHub, Google, Notion, Slack…" autocomplete="off" spellcheck={false} value={query} onInput={(event) => setQuery(valueOf(event))} />
      <div class="apps-list" role="region" aria-label="Apps to add">
        {hits.map((entry) => <CatalogRow key={entry.name} entry={entry} connected={catalogConnected(entry, addresses, names)} onToken={() => setToken({ kind: 'catalog', entry })} />)}
        {!hits.length && (
          <Row label={`"${query.trim()}" is not in this list`} hint="The AI can look for its MCP server or call its API directly" reserve>
            <span class="account-slot"><ActionButton label="Ask the AI" onClick={() => void setUpWithAi(`Connect an app: ${query.trim()}`)} /></span>
          </Row>
        )}
      </div>
      <Row label="Own MCP server" hint="Any MCP server: a web address (HTTP) with headers, or a command on this PC (stdio) with its variables" reserve>
        <span class="account-slot"><ActionButton label="Add" onClick={() => setForm('server')} /></span>
      </Row>
      <Row label="Paste JSON" hint={'The "mcpServers" config of Claude Desktop, Claude Code or Cursor – checked before it goes in'} reserve>
        <span class="account-slot"><ActionButton label="Paste" onClick={() => setForm('json')} /></span>
      </Row>
      <Row label="Add email" hint="A mailbox agents read, sort, draft and send from; new mail wakes an agent" reserve>
        <span class="account-slot"><ActionButton label="Add" onClick={() => setForm('mail')} /></span>
      </Row>
      <TokenDialog target={token} onClose={() => setToken(null)} />
      <Dialog open={form !== null} onClose={() => setForm(null)} title={form ? FORM_TITLES[form] : undefined} width={form === 'json' ? 600 : 520} class="secret-edit anchored">
        {form === 'server' && <ServerForm onClose={() => setForm(null)} />}
        {form === 'json' && <ImportForm onClose={() => setForm(null)} />}
        {form === 'mail' && <MailForm onClose={() => setForm(null)} />}
      </Dialog>
    </Group>
  );
}
