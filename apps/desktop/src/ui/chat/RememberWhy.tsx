// "Remember why…" on the person's own message (its right-click / long-press menu, MessageActions.tsx): one small
// dialog with one text field. Keep saves the person's reason – and the message itself as an example of how they
// write – as a reference through the existing references.remember call. Nothing else to choose: no rights, areas
// or kinds (the runtime picks the chat's area; agents find the reference when it fits).
// The dialog is mounted once (Shell.tsx Overlays); the menu entry only sets `rememberTarget`.
// Owns: the dialog and its open signal (which messages offer it: remember.ts). Never: decides what may be kept (the runtime does).

import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import '../../shared/api/methods-references.ts'; // the references.* method shapes (module augmentation)
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { plainPreview } from '../lib/format.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { rememberParams } from './remember.ts';

/** The message whose "Remember why…" dialog is open. */
export const rememberTarget = signal<Message | null>(null);

function RememberForm(props: { message: Message; onClose: () => void }) {
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = !busy && why.trim().length > 0;
  const keep = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await rpc.call('references.remember', rememberParams(props.message.id, why));
      pushToast({ title: 'Remembered', tone: 'info' }, 2500);
      props.onClose();
    } catch (error) {
      toastError(error, 'Not remembered');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p class="dialog-text remember-quote">{plainPreview(props.message.body, 240)}</p>
      <label class="field-label" for="remember-why-text">Why did you write it like this?</label>
      <textarea id="remember-why-text" class="input remember-why-text" rows={3} maxLength={4000} value={why} autoFocus
        onInput={(event) => setWhy((event.currentTarget as HTMLTextAreaElement).value)} />
      <DialogActions>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void keep()}>Keep</Button>
      </DialogActions>
    </div>
  );
}

/** The one "Remember why" dialog. */
export function RememberWhyHost() {
  const message = rememberTarget.value;
  const close = () => { rememberTarget.value = null; };
  return (
    <Dialog open={message !== null && can('references.remember')} onClose={close} title="Remember why" width={440} class="remember-why">
      {message && <RememberForm key={message.id} message={message} onClose={close} />}
    </Dialog>
  );
}
