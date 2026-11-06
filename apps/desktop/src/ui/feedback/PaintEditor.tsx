// B-055 Q4 "Paint over": a larger dialog with the draft's screenshot at its export size (paint.ts:
// longest side ≤ 1600 px) and opaque black marks – Pen (round, about 22 px on screen, the default)
// and Box (a filled rectangle) –, Undo, Clear and Done. Closing it in any way (Done, ×, Escape)
// keeps the marks: they are flattened into the report's JPEG before the draft takes them (a Send
// meanwhile waits – draft.ts whilePainting), so a painted shot is never sent raw. The canvas is
// AnnotationCanvas.tsx (reworked: an outline could not hide anything). Mounted once by
// FeedbackMenu.tsx; while it is open the menu steps aside (popover-state.ts).
// Owns: the editor and its marks until Done. Never: uploads or keeps images elsewhere.

import { useEffect, useState } from 'preact/hooks';
import { Dialog } from '../lib/dialog.tsx';
import { errorText } from '../lib/rpc.ts';
import { feedbackDraft, updateDraft, whilePainting } from './draft.ts';
import { AnnotationCanvas } from './AnnotationCanvas.tsx';
import type { PaintMark, PaintTool } from './paint.ts';
import { flatten, loadImage } from './paint-image.ts';
import { closePaint, paintOpen } from './popover-state.ts';

export function PaintEditor() {
  const open = paintOpen.value;
  const shot = feedbackDraft.value.shot;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [marks, setMarks] = useState<readonly PaintMark[]>([]);
  const [tool, setTool] = useState<PaintTool>('pen');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Each opening starts from the draft's marks (Undo reaches back into earlier sessions too).
  useEffect(() => {
    if (!open || !shot) { setImage(null); return; }
    setMarks(feedbackDraft.peek().marks);
    setTool('pen');
    setError(null);
    let live = true;
    loadImage(shot).then((loaded) => { if (live) setImage(loaded); }, (err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [open, shot]);

  const finish = () => {
    if (saving) return;
    const source = shot;
    if (!source || !image) { closePaint(); return; }
    setSaving(true);
    setError(null);
    const kept = [...marks];
    void whilePainting(
      (kept.length ? flatten(source, kept) : Promise.resolve(null))
        .then((painted) => {
          if (feedbackDraft.peek().shot === source) updateDraft({ marks: kept, painted });
          closePaint();
        }),
    ).catch((err) => {
      // A Send waiting for this work also rejects. Keep the marks without a stale flattened image, so a
      // subsequent attempt cannot fall back to the original screenshot or an earlier version of its marks.
      if (feedbackDraft.peek().shot === source) updateDraft({ marks: kept, painted: null });
      setError(errorText(err));
    }).finally(() => setSaving(false));
  };

  return (
    <Dialog open={open && !!shot} onClose={finish} title="Paint over" class="paint-dialog" width={1040}>
      <div class="paint-stage">
        {image ? <AnnotationCanvas image={image} marks={marks} tool={tool} onMark={(mark) => setMarks([...marks, mark])} /> : <div class="paint-wait" />}
      </div>
      <div class="paint-tools">
        <div class="segmented" role="group" aria-label="Tool">
          <button type="button" class={tool === 'pen' ? 'selected' : ''} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>Pen</button>
          <button type="button" class={tool === 'box' ? 'selected' : ''} aria-pressed={tool === 'box'} onClick={() => setTool('box')}>Box</button>
        </div>
        <button type="button" class="button ghost" disabled={!marks.length || saving} onClick={() => setMarks(marks.slice(0, -1))}>Undo</button>
        <button type="button" class="button ghost" disabled={!marks.length || saving} onClick={() => setMarks([])}>Clear</button>
        <p class="paint-message" role="status">{error}</p>
        <button type="button" class="button primary" disabled={saving || !image} onClick={finish}>Done</button>
      </div>
    </Dialog>
  );
}
