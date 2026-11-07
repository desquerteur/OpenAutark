// AF-015: this device's call as the call view shows it (CallOverlay.tsx). The chat header's call cell (CallHeader.tsx)
// opens it when a call starts – full size, with the start signal – and the person may shrink it to a small floating
// window and back; it stays across navigation. Its phase follows the engine that carries the call: the chat's voice
// conversation (voiceSessions), realtime voice (realtimeChat, realtimeOpened, realtimeAnswering) or the mock engine
// (call-mock.ts, only when this device asks for it: localStorage 'wf.callEngine' = 'mock' – tests and demos, no keys).
// Mute closes the microphone gate for every capture of the call (call-levels.ts micGate). Live captions are the newest
// line said in the call (the chat's rows as they arrive). Hang up ends the engine and plays the end signal; a call that
// ended by itself (its engine gone for ENGINE_GONE_MS) closes the view the same way. The call's row – the card with
// its transcript in the chat – is the runtime's (runtime/calls/call-log.ts), written by the engine's calls.start/end.
// Owns: the view's state, mute, captions and the mock's lifetime. Never: audio capture or playback, the voice loop.

import { computed, signal } from '@preact/signals';
import { newId } from '../../../shared/ids.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { voiceSessions } from '../../lib/shell-state.ts';
import { rpc } from '../../lib/rpc.ts';
import { agentName } from '../../lib/store.ts';
import { stopVoice } from '../composer/voice.ts';
import { holdChatTopic } from '../composer/pwa-conversation.ts';
import { realtimeAnswering, realtimeChat, realtimeOpened, stopRealtime } from './realtime-call.ts';
import { callLevels, micGate, reportMicMeter, reportOutputLevel, resetLevels } from './call-levels.ts';
import { playTone } from './call-tones.ts';
import { MockCall } from './call-mock.ts';
import { captionOf, engineGone, realtimePhase, voicePhase } from './call-model.ts';
import type { CallCaption, CallPhase, CallViewMode } from './call-model.ts';

export interface CallUi {
  conversationId: string;
  /** The mock engine carries it (tests and demos), else the chat's live voice. */
  mock: boolean;
  view: CallViewMode;
  muted: boolean;
  captions: boolean;
  /** The tap that started it (captions take rows from here on). */
  startedAt: number;
  /** When it first left 'connecting' (the call's clock). */
  connectedAt?: number;
}

/** Engine starts in flight (the microphone prompt, realtime handing over to the voice loop): the call still runs meanwhile. */
let starting = 0;

/** This device's call in the view; null when no call view is open. */
export const callUi = signal<CallUi | null>(null);
/** The mock engine's phase. */
const mockPhase = signal<CallPhase>('connecting');
/** The newest line said in the call. */
export const callCaption = signal<CallCaption | null>(null);
/** The view's clock (ticks while a call is open). */
export const callNow = signal(Date.now());

const CAPTIONS_KEY = 'wf.callCaptions';
const ENGINE_KEY = 'wf.callEngine';

/** This device asked for the mock engine (localStorage 'wf.callEngine' = 'mock'): tests and demos only. */
export function mockRequested(): boolean {
  try { return localStorage.getItem(ENGINE_KEY) === 'mock'; } catch { return false; }
}

function captionsWanted(): boolean {
  try { return localStorage.getItem(CAPTIONS_KEY) !== 'off'; } catch { return true; }
}

/** The engine of the call still runs on this device. */
function engineRuns(ui: CallUi): boolean {
  if (ui.mock) return mock !== null;
  if (starting > 0) return true;
  return realtimeChat.value === ui.conversationId || voiceSessions.value.some((chat) => chat.conversationId === ui.conversationId);
}

/** What the call does now. */
export const callPhase = computed<CallPhase>(() => {
  const ui = callUi.value;
  if (!ui) return 'connecting';
  if (ui.mock) return mockPhase.value;
  if (realtimeChat.value === ui.conversationId) return realtimePhase({ opened: realtimeOpened.value, answering: realtimeAnswering.value });
  return voicePhase(voiceSessions.value.find((chat) => chat.conversationId === ui.conversationId)?.phase);
});

let mock: MockCall | null = null;
let releases: Array<() => void> = [];
let timer: ReturnType<typeof setInterval> | null = null;
let goneSince: number | null = null;

/**
 * Opens the call view for a call starting in `conversationId` (from the tap: the start signal plays now). The engine
 * starts right after (CallHeader.tsx); with the mock asked for, this starts the mock instead.
 */
export function openCall(conversationId: string, options: { mock?: boolean } = {}): void {
  if (callUi.peek()) closeView();
  resetLevels();
  micGate.muted = false;
  playTone('start');
  const now = Date.now();
  callUi.value = { conversationId, mock: options.mock === true, view: 'full', muted: false, captions: captionsWanted(), startedAt: now };
  callCaption.value = null;
  callNow.value = now;
  goneSince = null;
  const listener = (message: Message) => takeCaption(message);
  releases.push(rpc.on('message.created', listener), rpc.on('message.updated', listener));
  timer = setInterval(tick, 250);
  if (options.mock) startMock(conversationId);
}

/** The engine of the open call is starting (`start` settles when it runs or failed): the view waits for it. */
export function engineStarting<T>(start: Promise<T>): Promise<T> {
  starting += 1;
  return start.finally(() => { starting = Math.max(0, starting - 1); goneSince = null; });
}

/** The engine could not start: the view closes without the end signal (the toast says why). */
export function callFailed(conversationId: string): void {
  if (callUi.peek()?.conversationId === conversationId) closeView();
}

/** Hang up: the engine ends, the end signal plays, the view closes (the chat keeps the call's card). */
export function hangUp(): void {
  const ui = callUi.peek();
  if (!ui) return;
  if (ui.mock) { mock?.stop(); mock = null; } else {
    if (realtimeChat.peek() === ui.conversationId) stopRealtime();
    void stopVoice(ui.conversationId);
  }
  playTone('end');
  closeView();
}

/** The open view is this chat's call. */
export function callOpenIn(conversationId: string): boolean {
  return callUi.value?.conversationId === conversationId;
}

export function setMuted(muted: boolean): void {
  const ui = callUi.peek();
  if (!ui || ui.muted === muted) return;
  micGate.muted = muted;
  if (muted) callLevels.mic.reset();
  mock?.setMuted(muted);
  callUi.value = { ...ui, muted };
}

export function toggleMute(): void { setMuted(!callUi.peek()?.muted); }

export function toggleCaptions(): void {
  const ui = callUi.peek();
  if (!ui) return;
  const captions = !ui.captions;
  try { localStorage.setItem(CAPTIONS_KEY, captions ? 'on' : 'off'); } catch { /* storage may be blocked */ }
  callUi.value = { ...ui, captions };
}

export function setCallView(view: CallViewMode): void {
  const ui = callUi.peek();
  if (ui && ui.view !== view) callUi.value = { ...ui, view };
}

/** The card's "Open call": brings this device's running call in that chat back full size. */
export function showCall(conversationId: string): void {
  if (callUi.peek()?.conversationId === conversationId) setCallView('full');
}

// ------------------------------------------------------------------ internals

function tick(): void {
  const ui = callUi.peek();
  if (!ui) return;
  const now = Date.now();
  callNow.value = now;
  if (ui.connectedAt === undefined && callPhase.peek() !== 'connecting') callUi.value = { ...ui, connectedAt: now };
  const gone = engineGone(engineRuns(ui), goneSince, now);
  goneSince = gone.goneSince;
  if (gone.ended) { playTone('end'); closeView(); } // ended by itself (End in the status line, the connection, an error)
}

function takeCaption(message: Message): void {
  const ui = callUi.peek();
  if (!ui) return;
  const caption = captionOf(message, { conversationId: ui.conversationId, since: ui.startedAt - 1000, callId: mockCallId() }, (row) => agentName((row as Message).authorId));
  if (caption) callCaption.value = caption;
}

const mockCallId = () => mock?.id ?? undefined;

function startMock(conversationId: string): void {
  mockPhase.value = 'connecting';
  const call = new MockCall(conversationId, {
    call: rpc.call,
    on: (event, listener) => rpc.on(event, listener),
    after: (ms, fn) => { const handle = setTimeout(fn, ms); return () => clearTimeout(handle); },
    newId: () => newId('req'),
    mic: (level) => reportMicMeter(level),
    out: (level) => reportOutputLevel(level),
    phase: (phase) => { mockPhase.value = phase; },
  });
  mock = call;
  releases.push(holdChatTopic(`chat:${conversationId}`));
  void call.start().catch(() => { if (mock === call) { mock = null; } });
}

function closeView(): void {
  if (mock) { mock.stop(); mock = null; }
  for (const release of releases.splice(0)) { try { release(); } catch { /* already released */ } }
  if (timer) clearInterval(timer);
  timer = null;
  goneSince = null;
  micGate.muted = false;
  callUi.value = null;
  callCaption.value = null;
  resetLevels();
}
