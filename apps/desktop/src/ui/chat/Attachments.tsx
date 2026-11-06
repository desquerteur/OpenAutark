// Attachment rendering: image thumbnails and file chips in messages, removable chips in the composer. On the
// desktop an image or a video of a message opens in the side pane (side-pane.ts); every other file opens with the
// system app, and anywhere else a file downloads.
// Owns: attachment markup. Never: uploads (lib/files.ts) or message state.

import type { Attachment } from '../../shared/model/chat.ts';
import { Icon, IconButton, Spinner } from '../lib/ui.tsx';
import { fileUrl } from '../lib/files.ts';
import { fileSize } from '../lib/format.ts';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { showMedia, showVideo } from './side-pane.ts';

async function openFile(attachment: Attachment): Promise<void> {
  try {
    if (platform === 'desktop') { await rpc.call('files.open', { id: attachment.fileId }); return; }
    const url = fileUrl(attachment.fileId).value;
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.name;
    link.click();
  } catch (error) { toastError(error, 'Could not open file'); }
}

/** Whether this attachment of a message opens in the side pane (desktop; an image or a video). */
function opensInPane(attachment: Attachment): boolean {
  return platform === 'desktop' && (attachment.mime.startsWith('image/') || attachment.mime.startsWith('video/'));
}

/** A click: the side pane for an image or video, else the file itself. */
function openAttachment(attachment: Attachment, conversationId?: string): void {
  if (conversationId && opensInPane(attachment)) {
    if (attachment.mime.startsWith('video/')) showVideo(conversationId, attachment); else showMedia(conversationId, attachment);
    return;
  }
  void openFile(attachment);
}

function ImageThumb(props: { attachment: Attachment; conversationId?: string }) {
  const url = fileUrl(props.attachment.fileId).value;
  return (
    <button type="button" class="attachment-image" title={props.attachment.name} onClick={() => openAttachment(props.attachment, props.conversationId)}>
      {url ? <img src={url} alt={props.attachment.name} loading="lazy" /> : <Spinner size={14} />}
    </button>
  );
}

function AudioPlayer(props: { attachment: Attachment }) {
  const url = fileUrl(props.attachment.fileId).value;
  return url ? <audio class="attachment-audio" controls src={url} preload="metadata" /> : <FileChip attachment={props.attachment} />;
}

function FileChip(props: { attachment: Attachment; conversationId?: string; onRemove?: () => void; busy?: boolean }) {
  const { attachment } = props;
  return (
    <span class="file-chip">
      <button type="button" class="file-chip-open" title={attachment.name} onClick={() => openAttachment(attachment, props.conversationId)}>
        {props.busy ? <Spinner size={14} /> : <Icon name={attachment.mime.startsWith('image/') ? 'image' : 'paperclip'} size={16} />}
        <span class="file-chip-name">{attachment.name}</span>
        {attachment.size > 0 && <span class="file-chip-size tabular">{fileSize(attachment.size)}</span>}
      </button>
      {props.onRemove && <IconButton icon="x" label={`Remove ${attachment.name}`} size="small" iconSize={14} onClick={props.onRemove} />}
    </span>
  );
}

/** A message's attachments; with its chat an image or video opens in the side pane. */
export function AttachmentList(props: { attachments: Attachment[]; conversationId?: string }) {
  const images = props.attachments.filter((attachment) => attachment.mime.startsWith('image/'));
  const audio = props.attachments.filter((attachment) => attachment.mime.startsWith('audio/'));
  const files = props.attachments.filter((attachment) => !attachment.mime.startsWith('image/') && !attachment.mime.startsWith('audio/'));
  return (
    <div class="attachments">
      {images.length > 0 && <div class="attachment-images">{images.map((attachment) => <ImageThumb key={attachment.fileId} attachment={attachment} conversationId={props.conversationId} />)}</div>}
      {audio.map((attachment) => <AudioPlayer key={attachment.fileId} attachment={attachment} />)}
      {files.length > 0 && <div class="attachment-files">{files.map((attachment) => <FileChip key={attachment.fileId} attachment={attachment} conversationId={props.conversationId} />)}</div>}
    </div>
  );
}

/** Composer chips: uploaded attachments + uploads in progress. */
export function ComposerAttachments(props: { attachments: Attachment[]; uploading: string[]; onRemove: (fileId: string) => void }) {
  if (!props.attachments.length && !props.uploading.length) return null;
  return (
    <div class="composer-attachments">
      {props.attachments.map((attachment) => <FileChip key={attachment.fileId} attachment={attachment} onRemove={() => props.onRemove(attachment.fileId)} />)}
      {props.uploading.map((name) => <FileChip key={`up-${name}`} attachment={{ fileId: '', name, mime: '', size: 0 }} busy />)}
    </div>
  );
}
