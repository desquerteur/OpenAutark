// Team › People › a person › Access (F-52, the owner as admin): their devices (Remove ends that
// device's access at once), their chats as titles and members only – never their messages; chats
// without you stay theirs (Join adds you openly), even though they are stored on this PC – and the
// latest audit lines.
// Owns: this dialog. Never: opens a person's chat or shows its messages.

import { useEffect, useState } from 'preact/hooks';
import type { Person, PersonAudit, PersonChat } from '../../shared/model/people.ts';
import { Button, Dialog, confirm } from '../lib/ui.tsx';
import { rpc } from '../lib/rpc.ts';
import { upsertPerson } from '../lib/people.ts';
import { relative } from '../lib/format.ts';
import { toastError } from '../lib/toasts.ts';
import { go } from '../lib/router.ts';

const AUDIT_TEXT: Record<PersonAudit['action'], string> = {
  created: 'Added', updated: 'Changed', invited: 'Invited', invite_closed: 'Invite withdrawn', join_requested: 'A device asked to join',
  joined: 'A device joined', join_declined: 'A device was declined', device_removed: 'A device was removed', revoked: 'Access removed',
  chat_added: 'Added to a chat', chat_removed: 'Removed from a chat', owner_joined_chat: 'You joined a chat of theirs',
};

export function PersonDetails(props: { person: Person | null; onClose: () => void }) {
  const person = props.person;
  const [chats, setChats] = useState<PersonChat[]>([]);
  const [audit, setAudit] = useState<PersonAudit[]>([]);
  useEffect(() => {
    setChats([]); setAudit([]);
    if (!person) return;
    let alive = true;
    rpc.call('people.chats', { id: person.id }).then((list) => { if (alive) setChats(list); }, () => undefined);
    rpc.call('people.audit', { id: person.id, limit: 20 }).then((list) => { if (alive) setAudit(list); }, () => undefined);
    return () => { alive = false; };
  }, [person?.id, person?.updatedAt]);

  /** The admin joins a chat without them – openly: its members see "Added …" (chats.members). */
  const join = async (chat: PersonChat) => {
    if (!(await confirm({ title: `Join ${chat.title || 'this chat'}?`, body: 'Its members see that you joined. Then you can read and write in it.', confirmLabel: 'Join' }))) return;
    try {
      await rpc.call('chats.members', { id: chat.id, add: ['human'] });
      props.onClose();
      go.chat(chat.id);
    } catch (error) { toastError(error, 'Could not join the chat'); }
  };

  const remove = async (deviceId: string, name: string) => {
    if (!person || !(await confirm({ title: `Remove ${name}?`, body: 'This device loses access at once.', confirmLabel: 'Remove', danger: true }))) return;
    try { upsertPerson(await rpc.call('people.removeDevice', { id: person.id, deviceId })); } catch (error) { toastError(error, 'Could not remove the device'); }
  };

  return (
    <Dialog open={person !== null} onClose={props.onClose} title={person ? `${person.name} · Access` : 'Access'} width={480} class="person-details">
      <h3 class="details-heading">Devices</h3>
      {person?.devices?.length ? (
        <ul class="person-list">
          {person.devices.map((device) => (
            <li key={device.id} class="person-list-row">
              <span class="person-list-text"><span>{device.name}</span><small class="muted">{device.lastSeenAt ? `Seen ${relative(device.lastSeenAt)}` : `Joined ${relative(device.createdAt)}`}</small></span>
              <Button variant="ghost" onClick={() => void remove(device.id, device.name)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : <p class="muted">No device yet.</p>}
      <h3 class="details-heading">Chats</h3>
      {chats.length ? (
        <ul class="person-list">
          {chats.map((chat) => (
            <li key={chat.id} class="person-list-row">
              <span class="person-list-text"><span>{chat.title || 'Untitled chat'}</span><small class="muted">{chat.left ? `Left · ${chat.members.join(', ')}` : chat.members.join(', ')}</small></span>
              {!chat.withOwner && <Button variant="ghost" onClick={() => void join(chat)}>Join</Button>}
            </li>
          ))}
        </ul>
      ) : <p class="muted">No chats yet.</p>}
      <p class="muted person-privacy">You see titles and members only. Messages of chats you are not in are not shown unless you join them, but they are stored on this PC.</p>
      {audit.length > 0 && (
        <>
          <h3 class="details-heading">History</h3>
          <ul class="person-list">
            {audit.map((line, index) => <li key={index} class="person-list-row"><span>{AUDIT_TEXT[line.action] ?? line.action}</span><small class="muted">{relative(line.at)}</small></li>)}
          </ul>
        </>
      )}
      <div class="dialog-actions"><Button variant="primary" onClick={props.onClose}>Done</Button></div>
    </Dialog>
  );
}
