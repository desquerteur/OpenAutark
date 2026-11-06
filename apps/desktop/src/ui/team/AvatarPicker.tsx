// Avatar picker of the agent editor (O6): a live preview drawn with the real avatar rules, the
// type (Initials from the name, Emoji, Image), the six palette colors for initials and emoji,
// emoji quick picks plus a field for any other emoji, and an image upload – cropped to a square
// and scaled to 256 px in the browser before it is stored, so avatars stay small on every device.
// Choices made in one type are kept while switching to another.
// Owns: the picker's markup and the image preparation. Never: saves the agent (the editor sends
// the patch) or invents avatars – what it shows is what the person picks.

import { useState } from 'preact/hooks';
import type { Avatar as AvatarModel } from '../../shared/model/org.ts';
import { avatarInitials } from '../../shared/text/avatar-looks.ts';
import { Avatar, Button, Icon } from '../lib/ui.tsx';
import { agents } from '../lib/store.ts';
import { uploadFile } from '../lib/files.ts';
import { toastError } from '../lib/toasts.ts';
import { Segmented } from '../settings/controls.tsx';
import { EMOJI_PICKS, PALETTE_SIZE, firstEmoji, previewLook, shownColor } from './editor-model.ts';

const AVATAR_PX = 256;
const KINDS: Array<{ value: AvatarModel['kind']; label: string }> = [
  { value: 'initials', label: 'Initials' },
  { value: 'emoji', label: 'Emoji' },
  { value: 'image', label: 'Image' },
];

/** A square, at most 256 px PNG of the picked image (refuses what the browser cannot read). */
async function squareImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('This image cannot be read here. Choose a PNG, JPEG, GIF or WebP image.'); }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const size = Math.max(1, Math.min(AVATAR_PX, side));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This image cannot be read here.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('This image cannot be read here.');
    return blob;
  } finally {
    bitmap.close();
  }
}

export interface AvatarPickerProps {
  agentId: string;
  /** The name as typed in the editor (initials follow it). */
  name: string;
  value: AvatarModel;
  onChange: (avatar: AvatarModel) => void;
}

export function AvatarPicker(props: AvatarPickerProps) {
  const { agentId, name, value, onChange } = props;
  const [tab, setTab] = useState<AvatarModel['kind']>(value.kind);
  const [emoji, setEmoji] = useState(value.kind === 'emoji' ? value.value : '');
  const [typed, setTyped] = useState('');
  const [imageId, setImageId] = useState(value.kind === 'image' ? value.value : '');
  const [uploading, setUploading] = useState(false);
  const look = previewLook(agents.value, agentId, name, value);
  const color = shownColor(agentId, value, look);
  const letters = avatarInitials(name.trim() || '?');

  const pickKind = (kind: AvatarModel['kind']) => {
    setTab(kind);
    if (kind === value.kind) return; // back to the current type: nothing changes
    if (kind === 'initials') onChange({ kind: 'initials', value: letters, color });
    else if (kind === 'emoji' && emoji) onChange({ kind: 'emoji', value: emoji, color });
    else if (kind === 'image' && imageId) onChange({ kind: 'image', value: imageId });
  };
  const pickEmoji = (next: string) => {
    if (!next) return;
    setEmoji(next);
    onChange({ kind: 'emoji', value: next, color });
  };
  const pickColor = (index: number) => {
    if (value.kind === 'image') return;
    onChange({ ...value, color: index });
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const ref = await uploadFile(await squareImage(file), 'avatar.png');
      setImageId(ref.fileId);
      onChange({ kind: 'image', value: ref.fileId });
    } catch (error) {
      toastError(error, 'Could not use this image');
    } finally {
      setUploading(false);
    }
  };
  const choose = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => void upload(input.files?.[0]);
    input.click();
  };

  const preview: AvatarModel = value.kind === 'initials' ? { kind: 'initials', value: look?.text ?? letters, color } : value;
  const showPalette = tab !== 'image';
  return (
    <div class="avatar-picker">
      <div class="avatar-picker-head">
        <Avatar name={name || '?'} avatar={preview} size={56} class="avatar-picker-preview" title="Avatar preview" agent />
        <Segmented label="Avatar type" value={tab} options={KINDS} onChange={pickKind} />
      </div>
      {showPalette && (
        <div class="avatar-swatches" role="radiogroup" aria-label="Avatar color">
          {Array.from({ length: PALETTE_SIZE }, (_, index) => (
            <button key={index} type="button" role="radio" aria-checked={value.kind !== 'image' && color === index} aria-label={`Color ${index + 1}`}
              class={`avatar-swatch${value.kind !== 'image' && color === index ? ' on' : ''}`} data-color={index}
              disabled={tab === 'emoji' && value.kind !== 'emoji'} onClick={() => pickColor(index)}>
              {value.kind !== 'image' && color === index && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
      {tab === 'emoji' && (
        <div class="avatar-emoji-picker">
          <div class="avatar-emoji-picks" role="radiogroup" aria-label="Emoji">
            {EMOJI_PICKS.map((pick) => (
              <button key={pick} type="button" role="radio" aria-checked={value.kind === 'emoji' && value.value === pick}
                class={`avatar-emoji-pick${value.kind === 'emoji' && value.value === pick ? ' on' : ''}`} onClick={() => pickEmoji(pick)}>{pick}</button>
            ))}
          </div>
          <input class="input avatar-emoji-input" type="text" value={typed} maxLength={16} aria-label="Other emoji" placeholder="Other emoji"
            onInput={(event) => {
              const text = (event.currentTarget as HTMLInputElement).value;
              setTyped(text);
              const found = firstEmoji(text);
              if (found) pickEmoji(found);
            }} />
        </div>
      )}
      {tab === 'image' && (
        <div class="avatar-image-actions">
          <Button variant="secondary" busy={uploading} onClick={choose}>{imageId ? 'Choose another image' : 'Upload image'}</Button>
        </div>
      )}
    </div>
  );
}
