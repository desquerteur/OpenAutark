// `upload` ask widget: the human hands over files. Drop zone + file picker, uploads run at
// once in ≤ 4 MB chunks with progress, files can be removed before "Send".
// Answer: {files: [fileId], names: [name]} (ids of the content-addressed blob store).
// Owns: selection, accept filtering and upload progress. Never: reads files it was not given.

import { useRef, useState } from 'preact/hooks';
import { Button, Icon, IconButton, Spinner } from '../../lib/ui.tsx';
import { fileSize } from '../../lib/format.ts';
import { toastError } from '../../lib/toasts.ts';
import { uploadBlob } from '../host.ts';
import { Inline, Markdown } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { useDraft } from './use-draft.ts';
import { s, strings } from './util.ts';

interface Done { id: string; name: string; size: number }
interface Running { key: number; name: string; ratio: number }

/** True when the file matches one accept entry ("image/*", "video/mp4", ".pdf"); empty = all. */
export function accepts(file: { name: string; type: string }, accept: string[]): boolean {
  if (!accept.length) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return accept.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith('.')) return name.endsWith(entry);
    if (entry.endsWith('/*')) return type.startsWith(entry.slice(0, -1));
    if (entry.includes('/')) return type === entry;
    return name.endsWith(`.${entry}`); // "pdf" written without the dot
  });
}

let nextKey = 1;

export function Upload(props: AskWidgetProps) {
  const { block } = props;
  const accept = strings(block.accept);
  const multiple = block.multiple !== false;
  const [files, setFiles] = useDraft<Done[]>(`${props.draftKey}.files`, []);
  const [running, setRunning] = useState<Running[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(files);
  current.current = files;

  const add = async (list: File[]) => {
    const wanted = list.filter((file) => accepts(file, accept));
    if (wanted.length < list.length) toastError(`Only ${accept.join(', ')}`, 'Some files were skipped');
    const take = multiple ? wanted : wanted.slice(0, 1);
    for (const file of take) {
      const key = nextKey++;
      setRunning((now) => [...now, { key, name: file.name, ratio: 0 }]);
      try {
        const ref = await uploadBlob(file, file.name, (ratio) => setRunning((now) => now.map((entry) => (entry.key === key ? { ...entry, ratio } : entry))));
        const next = { id: ref.id, name: ref.name || file.name, size: ref.size };
        const kept = multiple ? current.current.filter((entry) => entry.id !== next.id) : [];
        current.current = [...kept, next]; // later files of this batch build on it before the re-render
        setFiles(current.current);
      } catch (error) {
        toastError(error, `Upload of ${file.name} failed`);
      } finally {
        setRunning((now) => now.filter((entry) => entry.key !== key));
      }
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const list = [...(event.dataTransfer?.files ?? [])];
    if (list.length) void add(list);
  };

  const busy = props.busy || running.length > 0;
  return (
    <div class="w-upload">
      {block.instructions !== undefined && <Markdown text={s(block.instructions)} class="w-details" />}
      <button
        type="button"
        class={`w-drop${over ? ' is-over' : ''}`}
        disabled={props.busy}
        onClick={() => input.current?.click()}
        onDragOver={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Icon name="paperclip" size={18} />
        <span><Inline text={s(block.label) || 'Files'} /></span>
        {accept.length > 0 && <small class="muted">{accept.join(', ')}</small>}
      </button>
      <input ref={input} type="file" hidden multiple={multiple} accept={accept.join(',') || undefined}
        onChange={(event) => { const el = event.currentTarget as HTMLInputElement; void add([...(el.files ?? [])]); el.value = ''; }} />
      {(files.length > 0 || running.length > 0) && (
        <ul class="w-upload-list">
          {files.map((file) => (
            <li key={file.id}>
              <Icon name="file" size={16} />
              <span class="w-upload-name" title={file.name}>{file.name}</span>
              <span class="muted tabular">{fileSize(file.size)}</span>
              <IconButton icon="x" label={`Remove ${file.name}`} size="small" iconSize={14} disabled={props.busy}
                onClick={() => setFiles(files.filter((entry) => entry.id !== file.id))} />
            </li>
          ))}
          {running.map((entry) => (
            <li key={`run-${entry.key}`} class="is-running">
              <Spinner size={14} />
              <span class="w-upload-name">{entry.name}</span>
              <span class="muted tabular">{Math.round(entry.ratio * 100)} %</span>
            </li>
          ))}
        </ul>
      )}
      <div class="w-actions">
        <Button variant="primary" busy={props.busy} disabled={busy || files.length === 0}
          onClick={() => void props.submit({ files: files.map((file) => file.id), names: files.map((file) => file.name) })}>
          Send
        </Button>
      </div>
    </div>
  );
}
