// Owns: secret reference chips shared by the composer and message history.
// Never: fetches or displays secret values; ids are references, not downloadable files.
import { Icon, IconButton } from '../lib/ui.tsx';

export function SecretAttachments(props: { ids?: string[]; onRemove?: (id: string) => void }) {
  if (!props.ids?.length) return null;
  return <div class="composer-attachments secret-attachments">{props.ids.map(id => <span class="file-chip" key={id}>
    <span class="secret-chip-label"><Icon name="key" size={16} /><span>Secret</span></span>
    {props.onRemove && <IconButton icon="x" label="Remove secret" size="small" onClick={() => props.onRemove?.(id)} />}
  </span>)}</div>;
}
