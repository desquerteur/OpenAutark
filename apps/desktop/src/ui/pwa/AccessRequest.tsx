// The screen of a phone/browser without access: "Connect this phone" – or "This phone was removed." –
// pointing to the usual way in (B-078 D5: the Android app or the iPhone web app with the PC's Remote ID) and taking
// a 6-digit code from pwa.link (a link the person's agent hands out; the same one-time exchange,
// pwa/install.ts pairWith; paired, the page reloads into the app). An employee joins
// with the invite of their person instead ("I was invited", the join screen pwa/JoinRequest.tsx). A removed person
// (the page's token was a person's – pwa/person-access.ts) sees their own screen: their access was removed, ask the
// CEO for a new invite. App.tsx shows it instead of the shell. Its last line keeps two lines' height, empty or holding
// the reason a code failed, so the centred screen never moves. Inside the iPhone web app (pwa/hosted.ts) it says the
// phone was removed and "Connect again" forgets the pairing, so the shell's Remote ID screen comes back.
// Owns: this screen. Never: the token.

import { useState } from 'preact/hooks';
import { Button } from '../lib/ui.tsx';
import { hostedShell } from './hosted.ts';
import { pairWith } from './install.ts';
import { joining } from './join.ts';
import { readPersonMark, removedPersonText } from './person-access.ts';

export function AccessRequest(props: { removed?: boolean }) {
  const hosted = hostedShell();
  if (hosted) {
    // The iPhone web app pairs by Remote ID in its own shell: a refused token means this phone's row is gone on the PC.
    return (
      <div class="boot boot-note access-request" role="alert">
        <p>This phone was removed.</p>
        <p class="muted">Your PC no longer knows this iPhone. Connect it again with the PC's Remote ID (Settings › Devices).</p>
        <div class="scan-actions">
          <Button variant="primary" onClick={() => void hosted.forget()}>Connect again</Button>
        </div>
      </div>
    );
  }
  const person = props.removed ? readPersonMark() : null;
  if (person) {
    const text = removedPersonText(person);
    return (
      <div class="boot boot-note access-request" role="alert">
        <p>{text.title}</p>
        <p class="muted">{text.detail}</p>
        <div class="scan-actions">
          <Button variant="primary" onClick={() => { joining.value = true; }}>Enter invite code</Button>
        </div>
      </div>
    );
  }
  return <ConnectPhone removed={props.removed} />;
}

function ConnectPhone(props: { removed?: boolean }) {
  const [code, setCode] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = code.replace(/\D/g, '');
  const title = props.removed ? 'This phone was removed.' : 'Connect this phone';
  const send = async () => {
    if (digits.length !== 6 || busy) return;
    setBusy(true);
    const reason = await pairWith(digits);
    if (reason === null) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      location.reload();
      return;
    }
    setFailed(reason);
    setBusy(false);
  };
  return (
    <div class="boot boot-note access-request" role="dialog" aria-label={title}>
      <p>{title}</p>
      <p class="muted">The usual way: the Autark app on Android, or the iPhone web app, with your PC's Remote ID (Settings › Devices › Connect a phone). Got a 6-digit code from your PC? Type it here.</p>
      <input class="set-input access-code-input" aria-label="Code from the PC" inputMode="numeric" autoComplete="one-time-code" placeholder="Code" maxLength={7} value={code}
        onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void send(); }} />
      <div class="scan-actions">
        <Button variant="primary" busy={busy} disabled={digits.length !== 6} onClick={() => void send()}>Connect</Button>
        <Button variant="ghost" onClick={() => { joining.value = true; }}>I was invited to an organisation</Button>
      </div>
      <p class="muted" role="status" aria-live="polite" style={{ minHeight: '3em' }}>{failed ?? ' '}</p>
    </div>
  );
}
