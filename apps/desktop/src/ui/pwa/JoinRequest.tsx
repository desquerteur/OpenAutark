// The join screen of a person's phone or browser (F-52): opened from an invite link or its QR code
// it asks at once; otherwise "Enter the invite code" (the 6 digits the person who invited you can
// show). While the organisation's owner decides it says where that happens; then "You joined"
// (the page opens as you), declined, expired or the reason, each with "Enter code". App.tsx shows
// it instead of the shell while joining.
// Owns: this screen. Never: the request logic (pwa/join.ts), the ticket or the token.

import { useEffect, useState } from 'preact/hooks';
import { Button, Spinner } from '../lib/ui.tsx';
import { joining, pageJoin } from './join.ts';

export function JoinRequest() {
  const flow = pageJoin();
  const [code, setCode] = useState('');
  useEffect(() => { flow.resume(); }, []);
  const state = flow.state.value;
  const digits = code.replace(/\D/g, '');
  const send = () => { if (digits.length === 6) void flow.ask({ code: digits }); };

  if (state.step === 'asking') return <div class="boot boot-note access-request" role="status"><p>Asking to join…</p><Spinner size={16} /></div>;
  if (state.step === 'waiting') {
    return (
      <div class="boot boot-note access-request" role="status" aria-live="polite">
        <p>Waiting to be let in</p>
        <p>The person who invited you allows this device on their PC.</p>
        <p class="muted">You can close this page; open the invite page again to keep waiting.</p>
        <Button variant="ghost" onClick={() => flow.cancel()}>Cancel</Button>
      </div>
    );
  }
  if (state.step === 'accepted') return <div class="boot boot-note access-request" role="status"><p>You joined.</p><Spinner size={16} label="Opening Autark" /></div>;
  const ended = state.step === 'denied' ? (state.reason ?? 'Not let in.') : state.step === 'expired' ? 'Nobody let this device in in time.' : state.step === 'failed' ? state.message : undefined;
  return (
    <div class="boot boot-note access-request" role={ended ? 'alert' : 'dialog'} aria-label="Join an organisation">
      <p>{ended ? 'Not joined yet' : 'Join an organisation'}</p>
      {ended && <p class="muted">{ended}</p>}
      <p class="muted">Enter the invite code the person who invited you shows, or open their invite link.</p>
      <input class="set-input access-code-input" aria-label="Invite code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 digits" maxLength={7} value={code}
        onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter') send(); }} />
      <div class="scan-actions">
        <Button variant="primary" disabled={digits.length !== 6} onClick={send}>Join</Button>
        <Button variant="ghost" onClick={() => { joining.value = false; }}>Back</Button>
      </div>
    </div>
  );
}
