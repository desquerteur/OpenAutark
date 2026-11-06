// The rows that connect PCs, shared by Settings › Devices (DevicesGroup.tsx) and the first run's Connect card
// (onboarding/ConnectCard.tsx): this PC's Remote ID (Copy; the hint says whether the meeting server lets PCs in other
// networks find it), the PCs on this network (remote.nearby) with Connect, "Connect my other device" by Remote ID or
// address (B-078: my own devices carry no role – the same company on both; the wire role stays 'ceo'), or "Join a company"
// as an employee when the company menu asked for that (its one fixed line: this PC's request with the code, or why it
// failed), and a PC or my phone (B-078) asking here with its code (Accept – an employee's PC with the person it belongs
// to – / Decline); plus
// the live-state hooks they read.
// Owns: these rows and hooks. Never: shows keys, or accepts without the person's click.

import { useEffect, useState } from 'preact/hooks';
import type { Person } from '../../shared/model/people.ts';
import type { RelayState } from '../../shared/model/relay.ts';
import type { JoinRole, NearbyPc, RemoteIncoming, RemoteState } from '../../shared/model/remote.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { act, Row, useAsync, useBusy } from './controls.tsx';
import { connectLine, groupDigits, incomingText, remoteIdHint, typedTarget } from './connect-text.ts';

/** A value kept current by an event (`on` returns its unsubscribe). */
export function useLive<T>(readable: boolean, load: () => Promise<T>, on?: (set: (next: T) => void) => () => void) {
  const state = useAsync(() => (readable ? load() : Promise.resolve(undefined)), [readable]);
  useEffect(() => (readable && on ? on((next) => state.set(next)) : undefined), [readable]);
  return state;
}

/** This PC's connect state (remote.state) and the meeting server's (remote.relay), both kept current. */
export function useConnectState() {
  const remote = useLive(can('remote.state'), () => rpc.call('remote.state'), (set) => rpc.on('remote.updated', set));
  const relay = useLive<RelayState>(can('remote.relay'), () => rpc.call('remote.relay'), (set) => rpc.on('relay.updated', set));
  return { remote, relay };
}

/** The people an employee's device can belong to (the owner left out). */
export function usePeople(): Person[] {
  const people = useAsync(() => (can('people.list') ? rpc.call('people.list') : Promise.resolve<Person[]>([])), []);
  return (people.data ?? []).filter((person) => person.id !== 'human');
}

export function PersonSelect(props: { people: Person[]; value: string; onChange: (id: string) => void; label: string; me?: string }) {
  return (
    <select class="set-input remote-role" aria-label={props.label} value={props.value} onChange={(event) => props.onChange((event.currentTarget as HTMLSelectElement).value)}>
      {props.me !== undefined && <option value="">{props.me}</option>}
      {props.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
    </select>
  );
}

/** This PC's Remote ID with Copy; the hint: through the meeting server, or only on this network. */
export function RemoteIdRow(props: { remote?: RemoteState; relay?: RelayState }) {
  const id = props.remote?.self.remoteId;
  const copy = () => {
    if (id) navigator.clipboard.writeText(groupDigits(id)).then(() => pushToast({ title: 'Remote ID copied' }), (cause: unknown) => toastError(cause, 'Could not copy'));
  };
  return (
    <Row label="Remote ID" hint={remoteIdHint(props.relay, props.remote?.self.findable)} reserve>
      <span class="remote-id">{id ? groupDigits(id) : ''}</span>
      <button type="button" class="button ghost small" disabled={!id} onClick={copy}>Copy</button>
    </Row>
  );
}

/** The PCs on this network that accept requests, each with Connect (as the chosen role). */
export function NearbyRows(props: { role: JoinRole; onError: (text: string | null) => void }) {
  const nearby = useAsync(() => (can('remote.nearby') ? rpc.call('remote.nearby', {}) : Promise.resolve<NearbyPc[]>([])), []);
  const [busy, run] = useBusy();
  const connect = (pc: NearbyPc) => void run(async () => {
    props.onError(null);
    try { await rpc.call('remote.connect', { target: pc.remoteId, role: props.role }); } catch (cause) { props.onError(errorText(cause)); }
  });
  return (
    <>
      {(nearby.data ?? []).filter((pc) => pc.state !== 'linked').map((pc) => (
        <Row key={`${pc.deviceId}:${pc.fingerprint}`} label={pc.name} hint={`On this network · Remote ID ${groupDigits(pc.remoteId)}`}
          menu={() => [{ items: [{ label: 'Refresh list', onSelect: () => void rpc.call('remote.nearby', { refresh: true }).then(nearby.set, () => undefined) }] }]}>
          <Button variant="ghost" class="small" disabled={busy || pc.state === 'waiting'} onClick={() => connect(pc)}>{pc.state === 'waiting' ? 'Waiting…' : 'Connect'}</Button>
        </Row>
      ))}
    </>
  );
}

/**
 * "Connect my other device" (role 'ceo' on the wire: the same company on both, no role to pick) or, from the company
 * menu's "Join a company as employee", "Join a company": a Remote ID or address and the line with this PC's request
 * (its code, Cancel) or the last error.
 */
export function ConnectRow(props: { remote?: RemoteState; role: JoinRole; error: string | null; onError: (text: string | null) => void }) {
  const [target, setTarget] = useState('');
  const [busy, run] = useBusy();
  const line = connectLine(props.remote?.outgoing, props.error);
  const connect = () => void run(async () => {
    props.onError(null);
    try { await rpc.call('remote.connect', { target: target.trim(), role: props.role }); setTarget(''); } catch (cause) { props.onError(errorText(cause)); }
  });
  const end = () => void rpc.call('remote.cancel').catch((cause) => toastError(cause, 'Could not cancel'));
  return (
    <div class="set-row remote-connect-row">
      <div class="set-row-text">
        <div class="set-row-label">{props.role === 'employee' ? 'Join a company' : 'Connect my other device'}</div>
        <div class="set-row-hint remote-slot" role="status">
          <span class="remote-slot-line">
            <span class={`remote-slot-title${line.tone ? ` ${line.tone}` : ''}`} title={line.text}>{line.text}</span>
            {line.code && <span class="remote-slot-code" aria-label={`Code ${line.code.split('').join(' ')}`}>code {line.code}</span>}
            {line.action && <button type="button" class="text-button" onClick={end}>{line.action === 'cancel' ? 'Cancel' : 'Close'}</button>}
          </span>
        </div>
      </div>
      <div class="set-row-control">
        <div class="set-inline">
          <input class="set-input" aria-label="Remote ID or address of the other PC" placeholder="Remote ID or address" value={target} autoComplete="off"
            onInput={(event) => { setTarget(typedTarget((event.currentTarget as HTMLInputElement).value)); props.onError(null); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && target.trim()) connect(); }} />
          <Button variant="ghost" class="small" busy={busy} disabled={!target.trim() || props.remote?.outgoing?.status === 'waiting'} onClick={connect}>Connect</Button>
        </div>
      </div>
    </div>
  );
}

/** A PC or my phone asking here: its code to compare, Accept (an employee's PC with its person) / Decline; `onDecided` after the answer went in. */
export function IncomingRow(props: { request: RemoteIncoming; people: Person[]; onDecided?: (accepted: boolean) => void }) {
  const { request } = props;
  const [person, setPerson] = useState(props.people[0]?.id ?? '');
  const [busy, run] = useBusy();
  const employee = request.role === 'employee';
  const answer = (accept: boolean) => void run(async () => {
    const done = await act(() => rpc.call('remote.decide', { id: request.id, accept, ...(accept && employee ? { personId: person } : {}) }), accept ? 'Could not accept' : 'Could not decline');
    if (done) props.onDecided?.(accept);
  });
  const words = incomingText(request);
  return (
    <Row label={<><span class="dot pairing" aria-hidden="true" /> {words.label}</>} hint={words.hint}>
      <span class="remote-slot-code" aria-label={`Code ${request.code.split('').join(' ')}`}>{request.code}</span>
      {employee && <PersonSelect people={props.people} value={person} onChange={setPerson} label="This PC belongs to" />}
      <Button variant="primary" class="small" disabled={busy || (employee && !person)} onClick={() => answer(true)}>Accept</Button>
      <Button variant="ghost" class="small" disabled={busy} onClick={() => answer(false)}>Decline</Button>
    </Row>
  );
}
