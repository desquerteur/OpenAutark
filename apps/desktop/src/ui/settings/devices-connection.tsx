// Settings › Devices › "Connection": the rows behind connecting – whether other PCs and my phone may find this PC and ask
// (devices.findable) and the meeting server devices in other networks find each other over (devices.relay, its state in
// the hint). B-078 (D5): no phone switch and no "reach over" choice – a phone gets in exactly while its accepted row
// exists (Remove ends it); pwa.bind for LAN/Tailscale browsers stays a settings.json key the AI sets (skill phone-access).
// The same keys of settings.json the AI changes. Owner only: the group is not shown to a phone.
// Owns: these rows. Never: lets a device in without the person's Accept, or shows a key.

import { relayAddress, type RelayState } from '../../shared/model/relay.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { act, Group, Row, TextField, Toggle } from './controls.tsx';

/** The meeting server's state in a few words (pure). */
export function relayLine(relay: RelayState | undefined, address: string): string {
  // 'off' with an address: the runtime keeps it unused (as the Remote ID row says) – never "Connecting…" forever
  if (!address || relay?.status === 'off') return 'Off · PCs in other networks find each other there by Remote ID';
  if (relay?.status === 'connected') return `Connected · ${relay.peersOnline} linked ${relay.peersOnline === 1 ? 'PC' : 'PCs'} online there`;
  if (relay?.status === 'error') return `Not connected${relay.error ? `: ${relay.error}` : ''}`;
  return 'Connecting…';
}

export function ConnectionGroup(props: { relay?: RelayState; findable?: boolean }) {
  const devices = settings.value?.devices;
  const saveRelay = (typed: string) => {
    const value = typed.trim();
    void act(async () => {
      const address = value ? relayAddress(value) : ''; // its one spelling: lower case, no default port, no end slash
      if (address === undefined) throw new Error('A meeting server address looks like wss://host');
      await updateSettings({ devices: { relay: address } });
    }, 'Address not saved');
  };
  return (
    <Group title="Connection" id="settings-connection">
      <Row label="Accept connection requests" reserve hint="Other PCs and your phone see this PC and ask; you accept each one">
        <Toggle label="Accept connection requests" checked={props.findable ?? devices?.findable ?? true} disabled={!devices} onChange={(findable) => void act(() => updateSettings({ devices: { findable } }), 'Could not save')} />
      </Row>
      <Row label="Meeting server" reserve hint={relayLine(props.relay, devices?.relay ?? '')}>
        <TextField label="Meeting server" type="url" placeholder="wss://…" maxLength={300} value={devices?.relay ?? ''} disabled={!devices} onCommit={saveRelay} />
      </Row>
    </Group>
  );
}
