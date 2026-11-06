// Team › People › Add person / Edit (F-52): name, title, who they report to (nobody, the owner,
// another person or an agent – one org chart) and what they may do (whether they work with the agents,
// start chats, give tasks to agents) → people.save. Spaces stay system data (B-044 §1.12): "Works with
// your agents" sets every space or none; a list of single spaces set elsewhere stays until it is changed.
// A new person goes straight on to the invite (PersonInvite.tsx). A person whose access was removed keeps name,
// title and manager editable; what they may do comes back with "Invite again" (the runtime refuses
// scopes for them, so the dialog neither shows nor sends them).
// Owns: this dialog. Never: invites or removes access itself.

import { useEffect, useState } from 'preact/hooks';
import type { Person, PersonScopes } from '../../shared/model/people.ts';
import { DEFAULT_PERSON_SCOPES } from '../../shared/model/people.ts';
import { Button, Dialog, Select } from '../lib/ui.tsx';
import { rpc } from '../lib/rpc.ts';
import { agents, settings } from '../lib/store.ts';
import { people, upsertPerson } from '../lib/people.ts';
import { toastError } from '../lib/toasts.ts';
import { withSelf } from '../lib/self-identity.ts';
import { managerOptions } from './people-model.ts';

export function PersonDialog(props: { open: boolean; person?: Person; onClose: () => void; onCreated?: (person: Person) => void }) {
  const current = props.person;
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [manager, setManager] = useState('');
  const [scopes, setScopes] = useState<PersonScopes>(DEFAULT_PERSON_SCOPES);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setName(current?.name ?? '');
    setTitle(current?.title ?? '');
    setManager(current?.managerId ?? (current?.owner ? '' : 'human'));
    setScopes(current?.scopes ?? DEFAULT_PERSON_SCOPES);
  }, [props.open, current?.id]);

  const owner = current?.owner === true;
  const revoked = current?.status === 'revoked';
  const canSave = !busy && (owner || name.trim().length > 0);
  const withAgents = scopes.spaces === 'all' || scopes.spaces.length > 0;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const saved = await rpc.call('people.save', {
        ...(current ? { id: current.id } : {}), ...(owner ? {} : { name: name.trim() }), title: title.trim(),
        ...(owner ? {} : { managerId: manager || null, ...(revoked ? {} : { scopes }) }),
      });
      upsertPerson(saved);
      props.onClose();
      if (!current) props.onCreated?.(saved);
    } catch (error) {
      toastError(error, current ? 'Could not save' : 'Could not add the person');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title={current ? (owner ? 'You' : `Edit ${current.name}`) : 'Add person'} width={460} class="person-dialog">
      {!owner && (
        <>
          <label class="field-label" for="person-name">Name</label>
          <input id="person-name" class="input" type="text" value={name} maxLength={80} required autoFocus
            onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} />
        </>
      )}
      <label class="field-label" for="person-title">Title</label>
      <input id="person-title" class="input" type="text" value={title} maxLength={80} placeholder="Optional"
        onInput={(event) => setTitle((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} />
      {!owner && (
        <>
          <label class="field-label" for="person-manager">Reports to</label>
          <Select id="person-manager" class="person-manager" label="Reports to" value={manager} onChange={setManager}
            options={managerOptions(current?.id, withSelf(people.value, settings.value?.profile), agents.value)} />
          {!revoked && <fieldset class="person-scopes">
            <legend class="field-label">Permissions</legend>
            <label class="check-row">
              <input type="checkbox" checked={withAgents} onChange={(event) => setScopes({ ...scopes, spaces: (event.currentTarget as HTMLInputElement).checked ? 'all' : [] })} />
              <span>Works with your agents</span>
            </label>
            <label class="check-row">
              <input type="checkbox" checked={scopes.startChats} onChange={(event) => setScopes({ ...scopes, startChats: (event.currentTarget as HTMLInputElement).checked })} />
              <span>Starts chats and groups</span>
            </label>
            <label class="check-row">
              <input type="checkbox" checked={scopes.assignAgents} onChange={(event) => setScopes({ ...scopes, assignAgents: (event.currentTarget as HTMLInputElement).checked })} />
              <span>Gives tasks to agents</span>
            </label>
          </fieldset>}
        </>
      )}
      <div class="dialog-actions">
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!canSave} onClick={() => void save()}>{current ? 'Save' : 'Add and invite'}</Button>
      </div>
    </Dialog>
  );
}
