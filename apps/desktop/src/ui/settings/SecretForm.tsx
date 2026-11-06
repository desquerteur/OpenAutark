// Settings › Secrets: the form that adds or edits an entry of the catalog in the band's slot above the list (SecretRows.tsx,
// owner 04.11.2026: no pop-up) – name, what it is for, and then a single value (API key, token, password, note; a stored
// single card keeps its kind) or the fields of a login, a card or a group of free fields (secret-groups.ts), with the type
// chosen once when the entry is new (a login first) or comes from a route file without a value. On edit an empty input
// keeps the stored value and Remove marks a stored field for deletion on save, in place, so nothing moves. A refusal of
// the runtime (an invalid 2FA key …) shows in the band's reserved line. The route follows from name and type; the AI and
// the route files can name another. Nothing here limits where a secret works.
// Owns: this form and the band's foot (BandFoot). Never: displays, logs or keeps a value after saving.

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { SecretFileEntry, SecretGroup, SecretGroupKind, SecretInfo } from '../../shared/model/security.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { Button } from '../lib/ui.tsx';
import { Select, useBusy, type Option } from './controls.tsx';
import {
  addField, CVC_HINT, draftFields, FIELD_KINDS, fieldLabel, groupBlocked, groupPayload, masked, TOTP_HINT, type FieldDraft, type GroupDraft,
} from './secret-groups.ts';

/** What the dialog is for: nothing (a new entry), a stored single secret, a stored group with its fields, or a file's entry without a value. */
export type SecretTarget =
  | { type: 'single'; info: SecretInfo }
  | { type: 'group'; group: SecretGroup; fields: SecretInfo[] }
  | { type: 'missing'; file: SecretFileEntry };

type NewKind = SecretInfo['kind'] | SecretGroupKind;
const GROUP_KINDS: readonly string[] = ['login', 'card', 'other'] satisfies SecretGroupKind[];
const isGroupKind = (kind: string): kind is SecretGroupKind => GROUP_KINDS.includes(kind);

/** The types a new entry can have (a card is always its fields). */
const NEW_KINDS: Array<Option<NewKind>> = [
  { value: 'api_key', label: 'API key' }, { value: 'token', label: 'Token' }, { value: 'password', label: 'Password' }, { value: 'note', label: 'Secure note' },
  { value: 'login', label: 'Login' }, { value: 'card', label: 'Payment card' }, { value: 'other', label: 'Several fields' },
];

const valueOf = (event: Event) => (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;

/** The band's foot: one row of actions and one reserved line (two lines at most, the whole text as its tooltip). */
export function BandFoot(props: { line: string; tone?: 'muted' | 'error' | 'ok'; children: ComponentChildren }) {
  return (
    <div class="secret-band-foot">
      <div class="secret-band-actions">{props.children}</div>
      <p class={`secret-band-line ${props.tone ?? 'muted'}`} role="status" title={props.line || undefined}>{props.line}</p>
    </div>
  );
}

/** The fields of a login, a card or a free group; `onChange` gets the whole list. */
function GroupFields(props: { draft: GroupDraft; onChange: (next: Partial<GroupDraft>) => void }) {
  const { draft, onChange } = props;
  const setField = (index: number, next: Partial<FieldDraft>) => onChange({ fields: draft.fields.map((field, at) => (at === index ? { ...field, ...next } : field)) });
  const more = draft.kind === 'other' ? addField(draft.fields) : undefined;
  return (
    <>
      {draft.fields.map((field, index) => {
        const named = field.template || field.id;
        const gone = Boolean(field.id && draft.removed.includes(field.id));
        const title = fieldLabel(field.field);
        const hint = field.kind === 'totp' ? TOTP_HINT : field.field === 'cvc' ? CVC_HINT : undefined;
        return (
          <div key={field.id ?? `${field.template ? field.field : 'new'}-${index}`} class="secret-field">
            <div class="secret-field-head">
              {named
                ? <span class="field-label">{title}</span>
                : (
                  <>
                    <input class="input" aria-label={`Field ${index + 1} name`} placeholder="Field name" maxLength={40} value={field.field} onInput={(event) => setField(index, { field: valueOf(event) })} />
                    <Select label={`Field ${index + 1} type`} value={field.kind} options={FIELD_KINDS} onChange={(kind) => setField(index, { kind })} />
                  </>
                )}
              {field.id
                ? <button type="button" class="button ghost small danger" aria-label={`${gone ? 'Keep' : 'Remove'} ${title}`} onClick={() => onChange({ removed: gone ? draft.removed.filter((id) => id !== field.id) : [...draft.removed, field.id!] })}>{gone ? 'Keep' : 'Remove'}</button>
                : !named && draft.fields.length > 1 && <button type="button" class="button ghost small danger" aria-label={`Remove field ${index + 1}`} onClick={() => onChange({ fields: draft.fields.filter((_, at) => at !== index) })}>Remove</button>}
            </div>
            <input class="input" type={masked(field.kind) ? 'password' : 'text'} autocomplete="off" aria-label={named ? title : `Field ${index + 1} value`} disabled={gone}
              placeholder={gone ? 'Removed on save' : field.id ? 'Empty keeps the stored value' : ''} value={field.value} onInput={(event) => setField(index, { value: valueOf(event) })} />
            {hint && <p class="secret-field-hint">{hint}</p>}
          </div>
        );
      })}
      {more && <button type="button" class="button ghost small secret-add-field" onClick={() => onChange({ fields: more })}>Add field</button>}
    </>
  );
}

export function SecretForm(props: { target?: SecretTarget; onDone: () => void; onCancel: () => void }) {
  const { target } = props;
  const single = target?.type === 'single' ? target.info : undefined;
  const group = target?.type === 'group' ? target : undefined;
  const file = target?.type === 'missing' ? target.file : undefined;
  const fileKind = file && NEW_KINDS.some((option) => option.value === file.kind) ? file.kind : undefined;
  const [kind, setKindNow] = useState<NewKind>(single?.kind ?? group?.group.kind ?? fileKind ?? 'login');
  const [label, setLabel] = useState(single?.label ?? group?.group.label ?? file?.name ?? '');
  const [purpose, setPurpose] = useState(single?.description ?? group?.group.description ?? file?.purpose ?? '');
  const [value, setValue] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>(() => (isGroupKind(kind) ? draftFields(kind, group?.fields) : []));
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, run] = useBusy();
  const choosesType = !single && !group;
  const grouped = !single && isGroupKind(kind);
  const setKind = (next: NewKind) => { setKindNow(next); setFields(isGroupKind(next) ? draftFields(next) : []); };
  const draft: GroupDraft = { kind: grouped ? kind : 'other', label, description: purpose, fields, removed };
  const blocked = grouped ? groupBlocked(draft, Boolean(group))
    : !label.trim() ? 'Enter a name to save' : !single && !value ? 'Enter the value to save' : '';
  const submit = () => void run(async () => {
    setError(undefined);
    try {
      if (grouped) {
        const id = group?.group.id ?? file?.id;
        await rpc.call('secrets.saveGroup', groupPayload(draft, id ? { id, stored: Boolean(group), ...(file ? { route: file.route } : {}) } : undefined));
      } else {
        const id = single?.id ?? file?.id;
        await rpc.call('secrets.save', {
          ...(id ? { id } : {}), label: label.trim(), kind: kind as SecretInfo['kind'], description: purpose.trim(), ...(value ? { value } : {}), ...(file ? { route: file.route } : {}),
        });
      }
      props.onDone();
    } catch (failure) { setError(errorText(failure)); }
  });
  return (
    <>
      <div class="secret-band-body secret-edit">
        <label class="field-label" for="secret-name">Name</label>
        <input id="secret-name" class="input" maxLength={120} value={label} onInput={(event) => setLabel(valueOf(event))} />
        <label class="field-label" for="secret-purpose">What it is for</label>
        <textarea id="secret-purpose" class="input secret-purpose-field" rows={3} maxLength={grouped ? 500 : 4000} value={purpose} onInput={(event) => setPurpose(valueOf(event))} />
        {choosesType && (
          <>
            <span class="field-label">Type</span>
            <Select label="Type" value={kind} options={NEW_KINDS} onChange={setKind} />
          </>
        )}
        {grouped
          ? <GroupFields draft={draft} onChange={(next) => { if (next.fields) setFields(next.fields); if (next.removed) setRemoved(next.removed); }} />
          : (
            <>
              <label class="field-label" for="secret-value">{single ? 'New value (empty keeps the stored one)' : 'Value'}</label>
              <input id="secret-value" class="input" type="password" autocomplete="off" value={value} onInput={(event) => setValue(valueOf(event))} />
            </>
          )}
      </div>
      <BandFoot line={error ?? (blocked || 'Stored encrypted; agents use it by its handle')} tone={error ? 'error' : 'muted'}>
        <Button variant="primary" class="small" busy={busy} disabled={Boolean(blocked)} onClick={submit}>Save</Button>
        <Button variant="secondary" class="small" onClick={props.onCancel}>Cancel</Button>
      </BandFoot>
    </>
  );
}
