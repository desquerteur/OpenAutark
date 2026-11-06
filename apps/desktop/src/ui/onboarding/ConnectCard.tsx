// The first run's Connect card (opened from the tour's top bar, FirstRun.tsx, or at once for a company started from the
// company menu's "+"): this PC's Remote ID, a PC asking here, the PCs on this network and the connect row by the other
// PC's Remote ID – the rows of Settings › Devices (settings/connect-rows.tsx). `role` 'ceo' is my other device (a full
// mirror, no role to pick), 'employee' joins someone else's company as one person's PC. Both screens show the same code;
// the person accepts on the PC that was asked. Linked as my other device (either way round), or accepted as the employee
// this card was opened for, this PC skips the rest of the first run (onboarding done). Back returns to the tour.
// Owns: this card. Never: copies data from the other PC or says it will.

import { useEffect, useState } from 'preact/hooks';
import type { JoinRole } from '../../shared/model/remote.ts';
import { errorText } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { Button } from '../lib/ui.tsx';
import { ConnectRow, IncomingRow, NearbyRows, RemoteIdRow, useConnectState, usePeople } from '../settings/connect-rows.tsx';
import { linkedAsCeo } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { Card, StatusLine } from './parts.tsx';

/** `onClose`: back to the tour (Back), or after the first run ended here. */
export function ConnectCard(props: { role?: JoinRole; onClose: () => void }) {
  const role = props.role ?? 'ceo';
  const people = usePeople();
  const { remote, relay } = useConnectState();
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const finish = () => {
    setFailed(undefined);
    goStep('done', { onboarding: { completed: true } }).then(props.onClose, (cause: unknown) => setFailed(errorText(cause)));
  };
  const out = remote.data?.outgoing;
  // Linked as my other device, or – for a company started to join one – as its employee: that company is set up already.
  useEffect(() => { if (linkedAsCeo(out) || (role === 'employee' && out?.status === 'accepted' && out.role === 'employee')) finish(); }, [out?.id, out?.status]);
  const title = role === 'employee' ? 'Join a company as employee' : 'Connect to my other device';
  return (
    <Card id="first-run-connect" title={title} actions={<Button variant="secondary" onClick={props.onClose}>Back</Button>}>
      <div class="first-run-rows">
        {can('remote.state') && <RemoteIdRow remote={remote.data} relay={relay.data} />}
        {(remote.data?.incoming ?? []).map((request) => (
          <IncomingRow key={request.id} request={request} people={people} onDecided={(accepted) => { if (accepted && request.role === 'ceo') finish(); }} />
        ))}
        {can('remote.nearby') && <NearbyRows role={role} onError={setError} />}
        {can('remote.connect') && <ConnectRow remote={remote.data} role={role} error={error} onError={setError} />}
      </div>
      <StatusLine text={failed} tone="error" />
    </Card>
  );
}
