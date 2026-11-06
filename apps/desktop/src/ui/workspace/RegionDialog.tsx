// Mark a region (the pane's menu, on a website or the Screen tab), one action: a picture of what is shown right now opens in
// a dialog like the feedback's Paint over, the person drags a rectangle (again: a new one) and Add to message cuts it
// out and attaches it to the open chat's message field, with the page's address (send-page.ts). The person sends the
// message. Over a page the native view hides while the dialog is open, so the picture is taken first.
// Owns: the dialog, the drag and the cut. Never: sends a message, keeps a picture or reads a page beyond it.

import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { bridge } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { activeConversationId } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { hostOf } from './browser-model.ts';
import { isRegion, regionBox, regionPixels, regionPoint, type RegionBox, type RegionPoint } from './region.ts';
import { putIntoDraft } from './send-page.ts';

interface RegionAsk { src: string; name: string; address?: string }

const regionAsk = signal<RegionAsk | null>(null);

/** Only with a chat open: that is where the region goes. */
function chatOpen(): boolean {
  if (activeConversationId.peek()) return true;
  pushToast({ title: 'Open a chat to add a region to', tone: 'info' });
  return false;
}

/** The menu that asked lay over the page, which hides the native view: it is shown again before its picture is taken. */
const menuGone = () => new Promise<void>((resolve) => { setTimeout(resolve, 150); });

/** A region of the page of website tab `id`. */
export async function markPage(id: string): Promise<void> {
  if (!chatOpen()) return;
  try {
    await menuGone();
    const shot = await bridge!.workspaceBrowser!.capture(id);
    regionAsk.value = { src: shot.dataUrl, name: `${hostOf(shot.url) || 'page'}-region.png`, address: shot.url };
  } catch (error) { toastError(error, 'Could not take a picture of the page'); }
}

/** A region of this PC's screen. */
export async function markScreen(): Promise<void> {
  if (!chatOpen()) return;
  try {
    const shot = await rpc.call('computer.preview', {});
    regionAsk.value = { src: shot.dataUrl, name: 'screen-region.png' };
  } catch (error) { toastError(error, 'Could not take a picture of the screen'); }
}

async function cut(image: HTMLImageElement, box: RegionBox): Promise<Blob> {
  const part = regionPixels(box, { width: image.naturalWidth, height: image.naturalHeight });
  const canvas = document.createElement('canvas');
  canvas.width = part.width;
  canvas.height = part.height;
  canvas.getContext('2d')!.drawImage(image, part.x, part.y, part.width, part.height, 0, 0, part.width, part.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error('The region could not be cut out.')); }, 'image/png'));
}

export function RegionDialog() {
  const ask = regionAsk.value;
  const image = useRef<HTMLImageElement>(null);
  const start = useRef<RegionPoint | null>(null);
  const [box, setBox] = useState<RegionBox | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setBox(null); setError(''); }, [ask]);
  const close = () => { regionAsk.value = null; };
  const at = (event: PointerEvent) => regionPoint(event.clientX, event.clientY, image.current!.getBoundingClientRect());
  const add = () => {
    const chatId = activeConversationId.peek();
    if (!ask || !box || !image.current || !chatId || saving) return;
    setSaving(true);
    cut(image.current, box).then((blob) => putIntoDraft(chatId, blob, ask.name, ask.address)).then(close, (failed: unknown) => setError(errorText(failed))).finally(() => setSaving(false));
  };
  return (
    <Dialog open={ask !== null} onClose={close} title="Mark a region" class="paint-dialog region-dialog" width={1040}>
      <div class="paint-stage">
        {ask && (
          <div class="region-frame"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
              start.current = at(event);
              setBox(null);
            }}
            onPointerMove={(event) => { if (start.current) setBox(regionBox(start.current, at(event))); }}
            onPointerUp={(event) => {
              if (!start.current) return;
              const drawn = regionBox(start.current, at(event));
              start.current = null;
              setBox(isRegion(drawn) ? drawn : null);
            }}
            onPointerCancel={() => { start.current = null; setBox(null); }}>
            <img ref={image} src={ask.src} alt="The picture to mark a region on" draggable={false} />
            {box && <div class="region-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />}
          </div>
        )}
      </div>
      <DialogActions message={error || 'Drag over the part you mean.'} tone={error ? 'error' : 'muted'}>
        <Button variant="primary" disabled={!box || saving} onClick={add}>Add to message</Button>
      </DialogActions>
    </Dialog>
  );
}
