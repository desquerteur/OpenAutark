// Pane tab › Video: a chat's video work – the current render playing (streamed, never autoplayed)
// and its versions v1…vN as chips in the line under it (switching keeps the playhead). The chat's
// videos come from the media library (media.list) and stay fresh through media.upserted, so a new
// render shows at once unless the person picked a version. "Comment at 0:12.4" puts a pointer to that
// moment into the chat's message field and the person sends it (video-pointer.ts). A right click offers
// Open, Show in folder and the chat's other renders.
// Owns: that view and the picked version. Never: timelines, keyframes, plans or segment marks, or sends a message.

import { signal, type Signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { MediaInfo } from '../../shared/model/media.ts';
import { MediaPlayer } from '../blocks/ui/Media.tsx';
import { draftFor, updateDraft } from '../chat/composer/draft.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { fullDate } from '../lib/format.ts';
import { playerGuard, streamUrl } from '../lib/media-stream.ts';
import { platform } from '../lib/platform.ts';
import { go } from '../lib/router.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { activeConversationId } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, Spinner, type MenuSection } from '../lib/ui.tsx';
import { mediaFacts } from './media-facts.ts';
import { focusComposer } from './send-page.ts';
import { joinPointer, pointerText, pointLabel, type PointerClip } from './video-pointer.ts';
import { pickAfter, shownVideo, videoRenders } from './video-versions.ts';

/** Adds "[name @ 0:12.4] " to the chat's draft and brings the keyboard there. Never sends. */
function commentAt(chatId: string, clip: PointerClip, ms: number, all: readonly PointerClip[]): void {
  updateDraft(chatId, { text: joinPointer(draftFor(chatId).peek().text, pointerText(clip, ms, all)) });
  if (activeConversationId.peek() !== chatId) go.chat(chatId);
  focusComposer();
}

function CommentButton(props: { chatId: string; clip: PointerClip; all: readonly PointerClip[]; playhead: Signal<number> }) {
  return (
    <span class="pane-comment-cell">
      <Button icon="chat-text" class="tabular" onClick={() => commentAt(props.chatId, props.clip, props.playhead.peek(), props.all)}>Comment at {pointLabel(props.playhead.value)}</Button>
    </span>
  );
}

export function VideoView(props: { conversationId: string; fileId?: string }) {
  const { conversationId } = props;
  const [rows, setRows] = useState<MediaInfo[] | null>(null);
  const [failed, setFailed] = useState('');
  const [picked, setPicked] = useState<string | null>(props.fileId ?? null);
  const player = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef<number | null>(null);
  const playhead = useMemo(() => signal(0), []);
  useEffect(() => { setPicked(props.fileId ?? null); }, [props.fileId]);
  useEffect(() => {
    let alive = true;
    const load = () => rpc.call('media.list', { conversationId, kind: 'video', limit: 200 })
      .then((list) => { if (alive) { setRows(list); setFailed(''); } }, (error: unknown) => { if (alive) setFailed(errorText(error)); });
    void load();
    const offRow = rpc.on('media.upserted', (info) => {
      if (info.conversationId === conversationId && info.kind === 'video') setRows((list) => [...(list ?? []).filter((row) => row.fileId !== info.fileId), info]);
    });
    const offOpen = rpc.onOpen(() => void load());
    return () => { alive = false; offRow(); offOpen(); };
  }, [conversationId]);

  const renders = videoRenders(rows ?? []);
  const shown = shownVideo(renders, picked);
  const clip = shown?.render.versions[shown.index];
  const pick = (fileId: string) => {
    if (fileId === clip?.fileId) return;
    resumeAt.current = player.current?.currentTime ?? null; // a version switch keeps the playhead
    setPicked(pickAfter(renders, fileId));
  };
  const open = (reveal: boolean) => {
    if (clip) rpc.call('files.open', { id: clip.fileId, reveal }).catch((error: unknown) => toastError(error, "Couldn't open the file"));
  };
  const canOpen = platform === 'desktop' && can('files.open');
  const menu = useContextMenu((): MenuSection[] => [
    { items: canOpen && clip ? [{ label: 'Open', onSelect: () => open(false) }, { label: 'Show in folder', onSelect: () => open(true) }] : [] },
    { title: 'Videos', items: renders.filter((render) => render !== shown?.render).slice(0, 12).map((render) => ({ label: render.title, onSelect: () => pick(render.versions.at(-1)!.fileId) })) },
  ]);

  const url = clip ? streamUrl(clip.fileId) : null;
  let stage;
  if (!clip) stage = rows === null && !failed ? <Spinner label="Loading videos" /> : <p class="pane-note">{failed || 'The videos agents make in this chat show up here.'}</p>;
  else if (url) {
    const track = (event: Event) => { playhead.value = (event.currentTarget as HTMLVideoElement).currentTime * 1000; };
    stage = <video ref={player} key={clip.fileId} class="pane-video-player" src={url} controls preload="metadata" playsInline {...playerGuard(url)}
      onTimeUpdate={track} onSeeked={track}
      onLoadedMetadata={(event) => { const at = resumeAt.current; resumeAt.current = null; if (at !== null) event.currentTarget.currentTime = Math.min(at, event.currentTarget.duration || at); track(event); }} />;
  } else stage = <MediaPlayer key={clip.fileId} src={clip.fileId} fileId={clip.fileId} kind="video" />; // no stream route here (the relay's phone app)

  const versions = shown?.render.versions ?? [];
  return (
    <div class="pane-view pane-video" {...menu}>
      <div class="pane-stage">{stage}</div>
      <div class="pane-foot">
        {versions.length > 1 && (
          <div class="pane-video-versions" role="group" aria-label="Versions">
            {versions.map((version, index) => (
              <button key={version.fileId} type="button" class="pane-video-version tabular" aria-pressed={version.fileId === clip?.fileId} title={fullDate(version.createdAt)} onClick={() => pick(version.fileId)}>
                v{index + 1}
              </button>
            ))}
          </div>
        )}
        <span class="pane-foot-text" title={clip?.name}>{clip ? [clip.name, mediaFacts(clip)].filter(Boolean).join(' · ') : ''}</span>
        {clip && url && <CommentButton chatId={conversationId} clip={{ fileId: clip.fileId, name: clip.name }} all={renders.flatMap((render) => render.versions)} playhead={playhead} />}
      </div>
    </div>
  );
}
