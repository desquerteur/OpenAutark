// B-055 Q4: the feedback form – in the header menu (FeedbackMenu.tsx) and in Settings › Feedback's "New report"
// dialog (FeedbackPanel). One field (focused) with the mic inside it (tap to toggle, hold to talk – it keeps adding
// text), the "Screenshot" row where this host captured the window (checked by default, a thumbnail that opens "Paint
// over", one muted line), and one action: Send where this build can send, else Save (delivery.ts). No categories.
// The report carries one image: the painted one flattened, or the original re-encoded (paint.ts reportImage – never
// the raw shot of a painted draft). The draft lives in draft.ts, so closing the menu keeps it; a created report
// clears it. After Send/Save the form says what happened in one line; when the send was not confirmed, the
// action cell of that line reads "Send again" (not Close) and sends the same saved report. The message slot beside
// the action is always reserved, so nothing moves when an error comes.
// Owns: the form, uploading its image and submitting. Never: starts an app change, requests a login, opens a
// browser or discards a failed submission.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FeedbackKind, FeedbackReport } from '../../shared/model/system.ts';
import { uploadFile } from '../lib/files.ts';
import { Icon } from '../lib/icons.tsx';
import { errorText, rpc } from '../lib/rpc.ts';
import { settings } from '../lib/store.ts';
import { Spinner } from '../lib/ui.tsx';
import { canCaptureWindow, dataUrlToBlob, useDictation } from './bridge.ts';
import { appendDraftText, clearDraft, feedbackDraft, paintSettled, shotTaking, takeShot, updateDraft } from './draft.ts';
import type { FeedbackDraft } from './draft.ts';
import { canSendAgain, doneText, sendAgainLabel, sendLabel, sendReport, SHOT_HINT, SHOT_LABEL, SHOT_MISSING, useFeedbackSending } from './delivery.ts';
import { talkError, talkState } from './FeedbackButton.tsx';
import { FeedbackPrivacyNote } from './FeedbackPrivacy.tsx';
import { PAINT_UNREADY, REPORT_IMAGE_NAME, reportImage } from './paint.ts';
import { flatten } from './paint-image.ts';
import { here, openPaint } from './popover-state.ts';

/** Reports from the menu carry no category any more (Q4); the runtime still wants one. */
const REPORT_KIND: FeedbackKind = 'bug';

/** The report's one image, uploaded (painted: as flattened; else the original re-encoded). */
async function uploadImage(draft: FeedbackDraft): Promise<{ screenshotFileId?: string }> {
  const image = reportImage(draft);
  if (!image) return {};
  if (image.kind === 'unready') throw new Error(PAINT_UNREADY);
  const jpeg = image.kind === 'painted' ? image.image : await flatten(image.image, []);
  const file = await uploadFile(dataUrlToBlob(jpeg), REPORT_IMAGE_NAME);
  return { screenshotFileId: file.fileId };
}

function ShotRow(props: { draft: FeedbackDraft; disabled: boolean }) {
  const { draft } = props;
  const taking = shotTaking.value;
  const image = draft.painted ?? draft.shot;
  return (
    <div class={`feedback-shot${draft.withShot && draft.shot ? '' : ' off'}`}>
      <button type="button" class="feedback-thumb" disabled={!draft.shot || props.disabled} onClick={openPaint}
        aria-label="Paint over the screenshot" title="Paint over">
        {image ? <img src={image} alt="" draggable={false} /> : taking ? <Spinner size={16} label="Taking a screenshot" /> : <Icon name="image" size={18} />}
      </button>
      <div class="feedback-shot-text">
        <label class="feedback-check">
          <input type="checkbox" checked={draft.withShot && !!draft.shot} disabled={!draft.shot || props.disabled}
            onChange={(event) => updateDraft({ withShot: (event.currentTarget as HTMLInputElement).checked })} />
          {SHOT_LABEL}
        </label>
        <p class="feedback-shot-hint">{draft.shot || taking ? SHOT_HINT : SHOT_MISSING}</p>
      </div>
    </div>
  );
}

export function FeedbackForm(props: { onClose: () => void }) {
  const draft = feedbackDraft.value;
  const sending = useFeedbackSending(); // undefined until known: "Save" (never sends) meanwhile
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<FeedbackReport | null>(null);
  const submitting = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation(appendDraftText, settings.value?.profile.language);
  const capture = canCaptureWindow();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const area = field.current;
      if (!area) return;
      area.focus({ preventScroll: true });
      area.setSelectionRange(area.value.length, area.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = async () => {
    if (submitting.current || !feedbackDraft.peek().text.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let saved: FeedbackReport | null = null;
    try {
      const canSendHere = sending === true; // what the button said: "Save" (unknown or not set up) never sends
      await paintSettled(); // marks being flattened: their image, never the raw shot
      const current = feedbackDraft.peek();
      const files = await uploadImage(current);
      const where = current.where.view ? current.where : here();
      saved = await rpc.call('feedback.create', { kind: REPORT_KIND, text: current.text.trim(), view: where.view, conversationId: where.conversationId, ...files });
      clearDraft(); // the report holds it now; the next press takes a fresh screenshot
      if (!canSendHere) { setDone(saved); return; } // saved on the PC; nothing is sent
      setDone(await sendReport(saved.id));
    } catch (err) {
      if (saved) setDone(saved); // saved on the PC; the line says so, the error says why it did not go
      setError(errorText(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // Not confirmed (only saved on the PC) where sending works: the same saved report goes out again, in the Close cell.
  const again = async (id: string) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      setDone(await sendReport(id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (done) {
    const report = done;
    const retry = canSendAgain(report.status, sending);
    return (
      <div class="feedback-panel done">
        <p class="feedback-done">{doneText(report.status, sending !== false)}</p>
        <div class="feedback-actions">
          <p class="feedback-message" role="status" title={error ?? undefined}>{error}</p>
          {retry
            ? <button type="button" class="button primary feedback-again" disabled={busy} onClick={() => void again(report.id)}>{sendAgainLabel(busy)}</button>
            : <button type="button" class="button primary" onClick={props.onClose}>Close</button>}
        </div>
      </div>
    );
  }

  const listening = dictation.state === 'listening';
  const transcribing = dictation.state === 'transcribing' || talkState.value === 'transcribing';
  const message = error ?? dictation.error ?? talkError.value;
  return (
    <div class="feedback-panel">
      <div class="feedback-input">
        <textarea
          ref={field}
          class="set-textarea"
          rows={4}
          aria-label="Your feedback"
          placeholder="What happened, or what would you like?"
          value={draft.text} disabled={busy}
          onInput={(event) => updateDraft({ text: (event.currentTarget as HTMLTextAreaElement).value })}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void submit(); }}
        />
        {dictation.available && (
          <button type="button" class={`icon-button mic${listening ? ' active' : ''}`}
            aria-label={listening ? 'Stop dictation' : 'Dictate'} aria-pressed={listening}
            title={listening ? 'Stop dictation' : 'Dictate – tap, or hold to talk'}
            disabled={transcribing || busy} {...dictation.handlers}>
            <Icon name={transcribing ? 'circle-notch' : listening ? 'stop' : 'microphone'} size={18} />
          </button>
        )}
      </div>
      {capture && <ShotRow draft={draft} disabled={busy} />}
      <FeedbackPrivacyNote sending={sending === true} />
      <div class="feedback-actions">
        <p class="feedback-message" role="status" title={message ?? undefined}>{message}</p>
        <button type="button" class="button primary" disabled={busy || !draft.text.trim()} onClick={() => void submit()}>
          {sendLabel(sending, busy)}
        </button>
      </div>
    </div>
  );
}

/**
 * The form on its own (Settings › Feedback "New report"): takes the window's screenshot when it
 * opens unless the draft keeps one (draft.ts keepsShot).
 */
export function FeedbackPanel(props: { onClose: () => void }) {
  useEffect(() => { void takeShot(here()); }, []);
  return <FeedbackForm onClose={props.onClose} />;
}
