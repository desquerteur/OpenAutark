// AF-013: the approval dialog – an agent wants to do something its access mode or rules do not allow by themselves.
// It shows the oldest waiting request: who asks, what the step is, why it needs the person and what "Always for this
// agent" would add to its rules, with Allow once · Always for <name> · Deny. Escape or the backdrop denies (the safe
// answer); the agent's turn goes on with the answer. Mounted once by the shell, only for the person on the PC.
// Owns: the dialog. Never: judges, or keeps requests itself (lib/access.ts does).

import { useEffect, useState } from 'preact/hooks';
import { ACCESS_MODE_LABELS, type AccessAnswer } from '../../shared/model/access.ts';
import { accessRequests, answerRequest, wireAccess } from '../lib/access.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { isOwner } from '../lib/session.ts';
import { navigate } from '../lib/router.ts';
import { errorText } from '../lib/rpc.ts';

export function AccessRequestHost() {
  useEffect(() => { wireAccess(); }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = accessRequests.value;
  const request = isOwner() ? waiting[0] : undefined;
  useEffect(() => { setError(''); }, [request?.id]);
  const reply = async (answer: AccessAnswer) => {
    if (!request || busy) return;
    setBusy(true);
    try { await answerRequest(request.id, answer); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  if (!request) return null;
  const more = waiting.length > 1 ? ` (1 of ${waiting.length})` : '';
  return (
    <Dialog open onClose={() => void reply('deny')} title={`${request.agentName} asks for approval${more}`} width={480} class="access-request">
      <div class="access-request-body">
        <p class="access-request-step">{request.summary}</p>
        <p class="dialog-text">{request.reason}.</p>
        <p class="access-request-meta">
          Mode: {ACCESS_MODE_LABELS[request.mode].label}
          {request.conversationId && <> · <button type="button" class="access-request-link" onClick={() => navigate({ view: 'chat', id: request.conversationId! })}>Open the chat</button></>}
        </p>
        {request.always && <p class="access-request-meta">“Always for {request.agentName}” will {request.always}.</p>}
      </div>
      <DialogActions message={error}>
        <button type="button" class="button secondary" disabled={busy} onClick={() => void reply('deny')}>Deny</button>
        {request.always && <button type="button" class="button secondary" disabled={busy} onClick={() => void reply('always')}>Always for {request.agentName}</button>}
        <button type="button" class="button primary" disabled={busy} autoFocus onClick={() => void reply('once')}>Allow once</button>
      </DialogActions>
    </Dialog>
  );
}
