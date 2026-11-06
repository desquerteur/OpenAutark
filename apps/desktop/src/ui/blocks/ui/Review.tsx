// `review` ask widget: the human looks at a result (image, audio, video, document or link) and
// gives a verdict. The first option answers at once; any other option asks for a short note
// first, so the agent knows what to change.
// Answer: {verdict, note?}. Owns: preview + verdict. Never: auto-loads remote media.

import { useState } from 'preact/hooks';
import { Button, Icon } from '../../lib/ui.tsx';
import { toastError } from '../../lib/toasts.ts';
import { isFileId, isRemoteUrl, openLink, openPath, platform } from '../host.ts';
import { Inline } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { MediaImage, MediaPlayer, mediaKind } from './Media.tsx';
import { useDraft } from './use-draft.ts';
import { s, strings } from './util.ts';

const DEFAULT_OPTIONS = ['Looks good', 'Needs changes'];
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp3|wav|ogg|oga|m4a|aac|flac|opus|mp4|webm|mov|m4v|mkv|ogv)(?:[?#]|$)/i;

/** True when the source is something the media renderers can show inline. */
function isMedia(src: string, kind: string): boolean {
  if (kind === 'image' || kind === 'audio' || kind === 'video') return true;
  return isFileId(src) || src.startsWith('data:image/') || MEDIA_EXT.test(src);
}

function Preview(props: { src: string; kind: string }) {
  const { src, kind } = props;
  if (!src) return null;
  if (isMedia(src, kind)) {
    const type = mediaKind(src, kind || undefined);
    return <div class="w-review-media">{type === 'image' ? <MediaImage src={src} /> : <MediaPlayer src={src} kind={type} />}</div>;
  }
  const remote = isRemoteUrl(src);
  const name = remote ? src : src.split(/[\\/]/).pop() || src;
  const open = async (reveal: boolean) => {
    try {
      if (remote) openLink(src);
      else await openPath(src, reveal);
    } catch (error) { toastError(error, "Couldn't open the file"); }
  };
  return (
    <div class="w-review-file">
      <Icon name={remote ? 'app-window' : 'file'} size={18} />
      <span class="w-review-name" title={src}>{name}</span>
      {(remote || platform === 'desktop') && <button type="button" class="button secondary" onClick={() => void open(false)}>Open</button>}
    </div>
  );
}

export function Review(props: AskWidgetProps) {
  const { block } = props;
  const options = strings(block.options).slice(0, 4);
  const choices = options.length ? options : DEFAULT_OPTIONS;
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useDraft<string>(`${props.draftKey}.note`, '');

  const pick = (verdict: string, index: number) => {
    if (index === 0) { void props.submit(note.trim() ? { verdict, note: note.trim() } : { verdict }); return; }
    setPending(verdict);
  };
  const sendPending = () => {
    if (!pending) return;
    void props.submit(note.trim() ? { verdict: pending, note: note.trim() } : { verdict: pending });
  };

  return (
    <div class="w-review">
      <Preview src={s(block.src)} kind={s(block.kind)} />
      {block.question !== undefined && <div class="w-question"><Inline text={s(block.question)} /></div>}
      {pending ? (
        <form class="w-review-note" onSubmit={(event) => { event.preventDefault(); sendPending(); }}>
          <textarea class="input" rows={3} value={note} placeholder="What should change?" aria-label="Note" autoFocus
            onInput={(event) => setNote((event.currentTarget as HTMLTextAreaElement).value)} />
          <div class="w-actions">
            <Button type="submit" variant="primary" busy={props.busy}>{pending}</Button>
            <Button variant="ghost" disabled={props.busy} onClick={() => setPending(null)}>Back</Button>
          </div>
        </form>
      ) : (
        <div class="w-actions">
          {choices.map((choice, index) => (
            <Button key={choice} variant={index === 0 ? 'primary' : 'secondary'} busy={index === 0 && props.busy} disabled={props.busy}
              onClick={() => pick(choice, index)}>
              {choice}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
