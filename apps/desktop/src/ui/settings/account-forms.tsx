// The one connection form ModelSetup.tsx opens inline under its buttons – "API key" and "Local server" open the same
// small form with their Provider list (endpoint.ts): Provider → Protocol (only "Other" can change it) → API key (with
// "Get a key") → URL (fixed for a named service) → Test → Add, which writes settings.json's providers. Test
// lists the models before saving (accounts.test); a failed test makes Test the filled button until a field changes.
// A server the PC scan found fills the local form.
// Owns: this form. Never: keeps a typed key after the form closes or echoes it anywhere.

import { useState } from 'preact/hooks';
import type { ProviderProtocol } from '../../shared/model/provider-entries.ts';
import type { ProviderId } from '../../shared/model/providers.ts';
import { DialogActions } from '../lib/dialog.tsx';
import { openExternal } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { Select, useBusy } from './controls.tsx';
import { connectionForm, keyStays, modelsText, PROTOCOL_OPTIONS, servicesOf, startUrl, type FormKind } from './endpoint.ts';

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

/** `failedTest`: Test could not reach the endpoint – Add is no longer the filled action until a field changes. */
type Status = { text: string; tone?: 'error' | 'ok'; failedTest?: boolean };
const EMPTY: Status = { text: '' };

/** accounts.test in words: "3 models: a, b, c, …", or why not; a failed one marks Test as the next step. */
async function testText(params: { provider: ProviderId; baseUrl?: string; apiKey?: string }): Promise<Status> {
  try {
    const { models } = await rpc.call('accounts.test', params);
    return models.length ? { text: modelsText(models), tone: 'ok' } : { text: modelsText(models), tone: 'error', failedTest: true };
  } catch (error) { return { text: errorText(error), tone: 'error', failedTest: true }; }
}

/** "Get a key" for a service with a key page, else an inert copy of the same size. */
function KeyPageLink(props: { page: string | undefined }) {
  const page = props.page;
  return page
    ? <button type="button" class="first-run-link add-key-link" title={page} onClick={() => openExternal(page)}>Get a key</button>
    : <span class="first-run-link add-key-link inert" aria-hidden="true">Get a key</span>;
}

/** `found`: a server the PC scan saw (its provider and address fill the local form). */
export function ConnectionForm(props: { kind: FormKind; onDone: () => void; found?: { provider: ProviderId; baseUrl: string } }) {
  const services = servicesOf(props.kind);
  const first = props.found ? services.find((service) => service.provider === props.found!.provider) ?? services[0] : services[0];
  const [service, setService] = useState(first.id);
  const [url, setUrl] = useState(props.found?.baseUrl ?? startUrl(first.id, ''));
  const [key, setKey] = useState('');
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-chat');
  const [status, setStatus] = useState<Status>(EMPTY);
  const [testing, test] = useBusy();
  const [busy, run] = useBusy();
  const view = connectionForm({ service, key, url, protocol });
  const target = view.target;
  const pick = (next: string) => {
    if (!keyStays(service, next)) setKey(''); // a key is never saved for, or sent to, another vendor
    setService(next); setUrl(startUrl(next, url)); setStatus(EMPTY);
  };
  const fields = () => ({ provider: target!.provider, ...(target!.baseUrl ? { baseUrl: target!.baseUrl } : {}), ...(target!.apiKey ? { apiKey: target!.apiKey } : {}) });
  const runTest = () => void test(async () => { setStatus(EMPTY); setStatus(await testText(fields())); });
  const submit = () => void run(async () => {
    try {
      await rpc.call('accounts.add', { ...fields(), label: target!.label.slice(0, 80) });
    } catch (failure) { setStatus({ text: errorText(failure), tone: 'error' }); return; }
    setKey('');
    pushToast({ title: `${target!.label} added` });
    props.onDone();
  });
  const id = `add-${props.kind}`;
  const hint = props.kind === 'api' ? 'The key is stored encrypted on this PC' : 'A model server on this PC or in your network';
  return (
    <div class="add-account inline-form">
      <span class="field-label">Provider</span>
      <Select label="Provider" value={service} onChange={pick}
        options={services.map((entry) => ({ value: entry.id, label: entry.name, ...(entry.note ? { hint: entry.note } : {}) }))} />
      <span class="field-label">Protocol</span>
      <Select label="Protocol" value={view.protocol} disabled={!view.protocolEditable} onChange={(next) => { setProtocol(next as ProviderProtocol); setStatus(EMPTY); }}
        options={view.protocolEditable ? PROTOCOL_OPTIONS.slice(0, -1) : PROTOCOL_OPTIONS} />
      <span class="field-label add-key-label"><label for={`${id}-key`}>API key</label><KeyPageLink page={view.service?.keyPage} /></span>
      <input id={`${id}-key`} class="input" type="password" autocomplete="off" placeholder={view.needsKey ? '' : 'Optional'} value={key}
        onInput={(event) => { setKey(value(event)); setStatus(EMPTY); }} />
      <label class="field-label" for={`${id}-url`}>URL</label>
      <input id={`${id}-url`} class="input" type="url" placeholder="https://llm.example.com/v1" value={view.url} readOnly={!view.urlEditable}
        onInput={(event) => { setUrl(value(event)); setStatus(EMPTY); }} />
      <DialogActions message={testing ? 'Testing…' : status.text || hint} tone={(!testing && status.text && status.tone) || 'muted'}>
        <Button variant="secondary" onClick={props.onDone}>Cancel</Button>
        <Button variant={status.failedTest ? 'primary' : 'secondary'} busy={testing} disabled={!view.testable || busy} onClick={runTest}>Test</Button>
        <Button variant={status.failedTest ? 'secondary' : 'primary'} busy={busy} disabled={!view.valid || testing} onClick={submit}>Add</Button>
      </DialogActions>
    </div>
  );
}
