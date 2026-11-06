// `media` block and the shared media source resolver. Sources: the block's fileId (stored by the
// runtime for agent outputs – works on every device), blob-store file ids, workspace paths
// (desktop: imported into the blob store, then shown) and remote URLs (click-to-load).
// X09: players stream a stored file (lib/media-stream.ts: wf-file:// on the desktop, /files on the
// PWA, with Range requests) instead of reading it through files.read, so renders over 8 MB play
// and seek; images keep the files.read object URL. A PWA player's URL carries the
// device token, so it gets playerGuard() (no download, casting or context menu).
// A stored image opens as a tab on a click (desktop): inside a tab area in that area, in a message in its chat's area
// (chat/side-pane.ts), else where the frame says (workspace/pages.ts openMedia); players keep their own
// controls. Owns: useMediaUrl, MediaImage, MediaPlayer, the media block. Never: auto-loads remote media
// or shows a local path on a device that cannot open it.

import { useContext, useEffect, useState } from 'preact/hooks';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { showMedia } from '../../chat/side-pane.ts';
import { fileUrl } from '../../lib/files.ts';
import { playerGuard, streamUrl } from '../../lib/media-stream.ts';
import { platform } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';
import { activeConversationId } from '../../lib/store.ts';
import { Icon } from '../../lib/ui.tsx';
import { openMedia } from '../../workspace/pages.ts';
import { SpaceContext } from '../../workspace/space.ts';
import { isFileId, isRemoteUrl } from '../host.ts';
import { items, s } from './util.ts';

const pathIds = new Map<string, Promise<string>>();

/**
 * Resolves a media source to a displayable URL; a valid `preferred` file id wins over `src`.
 * Remote URLs wait for `load()`. `stream`: a stored file plays from its streaming URL where this
 * platform has one (then files.read is never called for it).
 */
export function useMediaUrl(src: string, preferred?: string, options: { stream?: boolean } = {}): { url: string | null; remote: boolean; load(): void; failed: boolean } {
  const stored = preferred && isFileId(preferred) ? preferred : isFileId(src) ? src : null;
  const remote = !stored && isRemoteUrl(src);
  const [clicked, setClicked] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (stored || remote || !src || src.startsWith('data:')) return;
    // A workspace path without a stored file: import once (content-addressed, deduplicated) and show by id.
    let promise = pathIds.get(src);
    if (!promise) {
      promise = rpc.call('files.uploadPath', { path: src }).then(ref => ref.id);
      pathIds.set(src, promise);
      promise.catch(() => pathIds.delete(src));
    }
    let alive = true;
    promise.then(id => { if (alive) setImported(id); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [src, stored]);
  const id = stored ?? imported;
  const streamed = options.stream && id ? streamUrl(id) : null;
  const blobUrl = id && !streamed ? fileUrl(id).value : null;
  const url = remote ? (clicked ? src : null) : !stored && src.startsWith('data:image/') ? src : streamed ?? blobUrl;
  return { url, remote, load: () => setClicked(true), failed };
}

function fileName(src: string): string {
  return src.split(/[\\/]/).pop()?.split('?')[0] || src;
}

export function MediaImage(props: { src: string; fileId?: string; alt?: string }) {
  const media = useMediaUrl(props.src, props.fileId);
  const area = useContext(SpaceContext); // drawn in a tab area: that area's space
  const stored = props.fileId && isFileId(props.fileId) ? props.fileId : isFileId(props.src) ? props.src : null;
  if (media.url && stored && platform === 'desktop') {
    const open = () => {
      const file = { fileId: stored, ...(props.alt ? { name: props.alt } : {}) };
      const chat = activeConversationId.peek();
      if (!area && chat) showMedia(chat, file); else openMedia(file, area);
    };
    return <img class="b-media-img openable" src={media.url} alt={props.alt ?? ''} loading="lazy" onClick={open} />;
  }
  if (media.url) return <img class="b-media-img" src={media.url} alt={props.alt ?? ''} loading="lazy" />;
  if (media.remote) {
    return (
      <button type="button" class="b-media-load" onClick={media.load} title={props.src}>
        <Icon name="image" size={18} /><span>Load image</span>
      </button>
    );
  }
  return <div class="b-media-missing"><Icon name="image" size={18} /><span>{media.failed ? fileName(props.src) : ''}</span></div>;
}

export function MediaPlayer(props: { src: string; fileId?: string; kind: 'audio' | 'video' }) {
  const media = useMediaUrl(props.src, props.fileId, { stream: true });
  if (media.url) {
    const guard = playerGuard(media.url);
    return props.kind === 'audio'
      ? <audio class="b-media-audio" src={media.url} controls preload="metadata" {...guard} />
      : <video class="b-media-video" src={media.url} controls preload="metadata" playsInline {...guard} />;
  }
  if (media.remote) {
    return (
      <button type="button" class="b-media-load" onClick={media.load} title={props.src}>
        <Icon name={props.kind === 'audio' ? 'speaker-high' : 'monitor'} size={18} /><span>Load {props.kind}</span>
      </button>
    );
  }
  return <div class="b-media-missing"><Icon name="file" size={18} /><span>{isFileId(props.src) ? '' : fileName(props.src)}</span></div>;
}

/** image | audio | video from the declared kind or the file extension. */
export function mediaKind(src: string, declared?: string): 'image' | 'audio' | 'video' {
  if (declared === 'image' || declared === 'audio' || declared === 'video') return declared;
  const ext = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(src)?.[1]?.toLowerCase() ?? '';
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
  return 'image';
}

function One(props: { src: string; fileId?: string; kind?: string; caption?: string }) {
  const kind = mediaKind(props.src, props.kind);
  return (
    <figure class="b-media">
      {kind === 'image'
        ? <MediaImage src={props.src} fileId={props.fileId} alt={props.caption} />
        : <MediaPlayer src={props.src} fileId={props.fileId} kind={kind} />}
      {props.caption && <figcaption>{props.caption}</figcaption>}
    </figure>
  );
}

export function Media(props: { block: UiBlock }) {
  const list = items(props.block.items);
  return (
    <div class="b-media-block">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      {props.block.src !== undefined && (
        <One src={s(props.block.src)} fileId={s(props.block.fileId) || undefined} kind={s(props.block.kind)} caption={s(props.block.caption) || undefined} />
      )}
      {list.length > 0 && (
        <div class="b-media-grid">
          {list.map((item, i) => (
            <One key={i} src={s(item.src ?? item.url)} fileId={s(item.fileId) || undefined} kind={s(item.kind) || undefined} caption={s(item.caption) || undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
