// Voice conversation and dictation – one path on the desktop window and the phone.
//   voice:     the page conversation (pwa-conversation.ts, shared/voice/conversation.ts VoiceSessions): up to three
//              chats talk over one microphone, the chat started or focused last listens; opening a talking chat
//              makes it the listening one, End ends that chat's conversation. The status line lists them
//              (shell/StatusLine.tsx); the chat header's call cell starts and ends it (call/CallHeader.tsx).
//   dictation: lib/dictation.ts (recorded, uploaded, voice.transcribe – the runtime picks who hears it), editable
//              text into the draft (the profile language as the hint; a chat's next take waits for its text).
//              Where nothing can hear right now (dictationNote) the take is attached as audio with the note as
//              the hint; a longer take whose transcription failed is attached instead of lost, and a take without
//              words adds nothing. A field that cannot take an attachment (My day: stopDictation({ attach: false }))
//              gets a note instead of the recording. Send waits for the text and does not send a take that came
//              back as a recording or failed (dictateIntoDraft says so). D13: the text goes where the caret or
//              selection was when the mic was pressed (startDictation's target; a field that was not focused
//              appends), edits while recording move that place along (dictation-insert.ts) and the composer gets the
//              caret after the words (dictationCaret). A dictated draft is sent marked as spoken (draft-speech.ts).
//              Dictation and conversation share the one microphone: a dictation ends every conversation first.
// Owns: which conversation and take run and their state signals. Never: audio processing (lib/dictation.ts,
// conversation-audio.ts) or the conversation loop (shared/voice/conversation.ts).

import { effect, signal } from '@preact/signals';
import type { Attachment } from '../../../shared/model/chat.ts';
import type { VoiceSessionEntry, VoiceSessionView } from '../../../shared/voice/conversation.ts';
import { voiceChats, voiceSession, voiceSessions, type VoiceChat } from '../../lib/shell-state.ts';
import { activeConversationId, conversationMap, settings } from '../../lib/store.ts';
import { chatTitle } from '../../lib/chat-naming.ts';
import { can } from '../../lib/session.ts';
import { pushToast, toastError } from '../../lib/toasts.ts';
import { toAttachment } from '../../lib/files.ts';
import { DictationCancelled, TakeNotTranscribed, dictation, dictationNote, recordingProblem } from '../../lib/dictation.ts';
import { draftFor, updateDraft } from './draft.ts';
import { markDictated } from './draft-speech.ts';
import { insertDictation, shiftTarget, type DictationTarget } from './dictation-insert.ts';
import { primeSpeech } from './conversation-audio.ts';
import { ConversationCancelled, createBrowserConversation } from './pwa-conversation.ts';
import type { PageConversation } from './pwa-conversation.ts';

export { clearDraftSpeech } from './draft-speech.ts';
export type { DictationTarget } from './dictation-insert.ts';

/** "Start conversation" is offered: this connection may transcribe and send, and this page can record (reactive). */
export function conversationAvailable(): boolean {
  return can('voice.transcribe') && can('messages.send') && can('files.upload') && can('chats.get') && !recordingProblem();
}

/** The loop's state (the microphone and every chat; error: why one ended) as the shell shows it. */
function showVoiceState(mic: VoiceSessionView | null, error: string | undefined, sessions: readonly VoiceSessionEntry[]): void {
  const before = voiceSessions.peek();
  voiceSessions.value = voiceChats(mic, sessions);
  if (error) toastError(new Error(error), endedTitle(before, voiceSessions.peek()));
}

/** "Conversation in Research ended" when one of several ended, else "Conversation ended". */
function endedTitle(before: readonly VoiceChat[], after: readonly VoiceChat[]): string {
  const gone = before.filter((chat) => !after.some((left) => left.conversationId === chat.conversationId));
  const chat = gone.length === 1 && after.length ? conversationMap.peek().get(gone[0].conversationId) : undefined;
  return chat ? `Conversation in ${chatTitle(chat)} ended` : 'Conversation ended'; // B-050 K2: a default 1:1 by its partner
}

let page: PageConversation | null = null;

/** The page conversation, made on first use; from then on opening a talking chat makes it the listening one. */
function conversation(): PageConversation {
  if (page) return page;
  const made = createBrowserConversation(showVoiceState);
  page = made;
  effect(() => {
    const open = activeConversationId.value;
    if (open) focusVoice(open);
  });
  return made;
}

/** Starts (or focuses) the conversation in `conversationId`; false when it could not start (shown as a toast). Call from the tap. */
export async function startVoice(conversationId: string): Promise<boolean> {
  primeSpeech();
  if (dictating.peek() || dictationStarting.peek()) await cancelDictation(); // one microphone at a time
  try {
    await conversation().start(conversationId);
    return true;
  } catch (error) {
    if (!(error instanceof ConversationCancelled)) toastError(error, 'Conversation could not start');
    return false;
  }
}

/** Makes the conversation running in `conversationId` the listening one (the status line's Talk; opening the chat does it too). */
export function focusVoice(conversationId: string): void {
  const chat = voiceSessions.peek().find((entry) => entry.conversationId === conversationId);
  if (page && chat && !chat.listening) void page.start(conversationId).catch((error: unknown) => toastError(error));
}

/** Ends the conversation in `conversationId` – by default the open chat's, else the listening one. */
export async function stopVoice(conversationId = voiceSession.peek()?.conversationId): Promise<void> {
  page?.stop(conversationId);
}

// ------------------------------------------------------------------ dictation

/** Conversation id whose composer is currently dictating (one microphone at a time). */
export const dictating = signal<string | null>(null);
/** D13: the chat whose dictation is starting (tap → microphone open): its mic button shows it at once; a second tap starts nothing. */
export const dictationStarting = signal<string | null>(null);
/** D13: where the caret goes after a take was inserted (the composer applies it, `seq` makes each one new). */
export const dictationCaret = signal<{ conversationId: string; caret: number; seq: number } | null>(null);
/** How the running take ends: transcribed, or kept as a recording (nothing can hear it right now). */
let take: 'take' | 'recording' | null = null;
/**
 * D13: per chat, the draft and the field's caret/selection when its take started (no target:
 * append) – per chat, so a take started elsewhere while one is still transcribing never takes its place.
 */
const targets = new Map<string, { before: string; at: DictationTarget | null }>();
let carets = 0;

/**
 * Starts dictation into `conversationId`'s draft. `at`: the field's caret/selection now (read in
 * the mic's pointer-down, before focus could move); without it the text is appended at Stop.
 */
export async function startDictation(conversationId: string, at?: DictationTarget): Promise<void> {
  // A take of this chat still being transcribed comes first: its text lands in the draft before a new one.
  if (dictating.value || dictationStarting.value || transcribing.value.has(conversationId)) return;
  dictationStarting.value = conversationId;
  try {
    page?.stopAll(); // one microphone at a time
    // Ended by another dictation (the feedback panel's hold-to-talk) – also one that ends while it still starts.
    let started = false;
    let endedEarly = false;
    const ended = () => {
      if (!started) { endedEarly = true; return; }
      if (dictating.peek() !== conversationId) return;
      dictating.value = null;
      take = null;
      targets.delete(conversationId);
    };
    const kind = dictationNote() ? 'recording' : 'take';
    targets.set(conversationId, { before: draftFor(conversationId).peek().text, at: at ?? null });
    await dictation.start(ended);
    started = true;
    if (endedEarly) { targets.delete(conversationId); return; }
    take = kind;
    dictating.value = conversationId;
  } catch (error) {
    if (dictating.peek() !== conversationId) targets.delete(conversationId);
    if (!(error instanceof DictationCancelled)) toastError(error, 'Microphone unavailable');
  } finally {
    if (dictationStarting.peek() === conversationId) dictationStarting.value = null;
  }
}

/** Puts a take's text into the draft at the take's target. */
function insertTake(conversationId: string, text: string): void {
  const draft = draftFor(conversationId).peek().text;
  const taken = targets.get(conversationId) ?? null;
  targets.delete(conversationId);
  const at = taken?.at ? shiftTarget(taken.before, draft, taken.at) : null;
  const inserted = insertDictation(draft, at, text);
  updateDraft(conversationId, { text: inserted.text });
  markDictated(conversationId);
  if (taken?.at?.focused) dictationCaret.value = { conversationId, caret: inserted.caret, seq: ++carets };
}

/** Chats whose stopped dictation is still being uploaded or transcribed (seconds on a phone). */
export const transcribing = signal<ReadonlySet<string>>(new Set());

function setTranscribing(conversationId: string, on: boolean): void {
  const next = new Set(transcribing.value);
  if (on) next.add(conversationId); else next.delete(conversationId);
  transcribing.value = next;
}

/** What a stopped take gave: its text, the recording as an attachment, or `failed` (a toast said why). */
export interface DictationOutcome { text?: string; attachment?: Attachment; failed?: boolean }

export interface StopDictationOptions {
  /** false: the field cannot take an attachment – a take without text is dropped with a note, never attached. */
  attach?: boolean;
}

/** Stops dictation: the transcript text, an uploaded audio attachment, or a failure; {} when nothing was heard. */
export async function stopDictation(options: StopDictationOptions = {}): Promise<DictationOutcome> {
  const attach = options.attach !== false;
  const conversationId = dictating.value;
  if (!conversationId) return {};
  // Something that can hear now (a model download finished meanwhile) still turns this take into text.
  const kind = take === 'recording' && !dictationNote() ? 'take' : take;
  dictating.value = null;
  take = null;
  setTranscribing(conversationId, true);
  try {
    if (kind === 'recording') return attach ? await recordingOnly() : dropRecording();
    const { text } = await dictation.finish(settings.value?.profile.language, { attachable: attach }); // the language: a hint
    return text ? { text } : {};
  } catch (error) {
    // A take worth keeping comes back as its recording when its transcription failed.
    const recording = error instanceof TakeNotTranscribed ? error.recording : undefined;
    if (recording && !attach) {
      pushToast({ title: 'Dictation not transcribed', body: (error as Error).message, tone: 'error' }, 10_000);
      return { failed: true };
    }
    if (recording) {
      pushToast({ title: 'Dictation not transcribed', body: `${(error as Error).message} The recording was attached instead.`, tone: 'error' }, 10_000);
      return { attachment: toAttachment(recording) };
    }
    toastError(error, 'Dictation failed');
    return { failed: true };
  } finally {
    setTranscribing(conversationId, false);
  }
}

/** Nothing can transcribe here: the take becomes an audio attachment, with the reason as a hint. */
async function recordingOnly(): Promise<{ attachment?: Attachment }> {
  const hint = dictationNote();
  const ref = await dictation.keep();
  if (!ref) return {};
  pushToast({ title: 'Dictation attached as a recording', ...(hint ? { body: hint } : {}) }, 10_000);
  return { attachment: toAttachment(ref) };
}

/** Nothing can transcribe here and the field cannot attach: the take is dropped, with the reason as a hint. */
function dropRecording(): DictationOutcome {
  const hint = dictationNote();
  dictation.cancel();
  pushToast({ title: 'Dictation not transcribed', ...(hint ? { body: hint } : {}), tone: 'error' }, 10_000);
  return { failed: true };
}

/**
 * Stops the composer's dictation into its chat's draft: the text at the take's target (D13: the
 * caret or selection when the mic was pressed, moved along edits; appended without one), a
 * recording attached. True when the draft now holds what was said (its text, or nothing was
 * heard); false when the take came back as a recording or failed – Send then leaves the draft for
 * the person to check.
 */
export async function dictateIntoDraft(): Promise<boolean> {
  const conversationId = dictating.value;
  if (!conversationId) return true;
  const result = await stopDictation();
  if (result.text) insertTake(conversationId, result.text);
  else targets.delete(conversationId);
  if (result.attachment) updateDraft(conversationId, { attachments: [...draftFor(conversationId).peek().attachments, result.attachment] });
  return !result.attachment && !result.failed;
}

/** Discards the running (or starting) take. */
export async function cancelDictation(): Promise<void> {
  const conversationId = dictating.value;
  if (!conversationId && !dictationStarting.value) return;
  if (conversationId) targets.delete(conversationId);
  dictating.value = null;
  take = null;
  dictation.cancel(); // a start still opening the microphone gives up, too
}
