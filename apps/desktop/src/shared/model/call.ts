// Calls: a chat's voice mode on the device the person uses (shared/voice/conversation.ts) – or, with a realtime key, a
// realtime voice session the runtime keeps (runtime/calls/realtime). Every call is one value in its chat: one quiet row
// whose meta.call is the call (CallRecord – written only by the PC of the device, runtime/calls/call-log.ts) with every
// line said in it; each line itself carries meta.call (CallLineMeta) with the call's id. This file holds those shapes, the
// calls.* methods and how a line said by voice is marked (SpeechMeta.live, SpeechMeta.call on the way in).
// Owns: the shapes shared by runtime and clients (augmenting Methods like model/remote.ts). Never: carries audio beyond the
// realtime chunks or provider keys; a call's lines are copies of its chat rows (text capped at CALL_LINE_TEXT), written and
// kept in step with those rows only by the PC that wrote the call row.

import type { Message } from './chat.ts';

/** The device a call runs on: its key ('pc' for this PC's window, else the paired device id) and its label. */
export interface CallDevice { key: string; name: string }

/** How a line was said in a call (meta.call, set by the runtime – never by a client). */
export interface CallLineMeta {
  /** The call's id (its row in the chat, CallRecord). */
  id: string;
  /** Who said it: 'device:<key>' (the person on that device) or 'agent:<agentId>' (its realtime voice, its talker or its turn). */
  participant: string;
  /** Its label at that time. */
  name: string;
  /** An agent line the realtime voice already spoke: no voice loop reads it aloud again. */
  spoken?: true;
  /** The agent's live voice said it, a realtime session or the talker (runtime/calls/talker.ts), not the agent's full turn. */
  voice?: 'realtime' | 'talker';
}

/** One line of a call's transcript (CallRecord.lines): who said what when, and the chat row it is. */
export interface CallLine {
  at: number;
  /** 'device:<key>' – the person; 'agent:<agentId>'; another member as '<kind>:<id>'. */
  from: string;
  name: string;
  text: string;
  messageId?: string;
}

/**
 * The call's own row (kind 'status', quiet): meta.call with the device as participant 'device:<key>' and its name, the PC
 * that writes it, when it started and ended, and its lines – both sides, the newest CALL_LINES. Every device renders it as
 * one bubble.
 */
export interface CallRecord extends CallLineMeta {
  /** The PC that writes this row (its device id; absent where the PC has no device record): its lines follow edits and deletions there. */
  pc?: string;
  startedAt: number;
  endedAt?: number;
  lines: CallLine[];
}

/** Lines a call row keeps (the newest) and characters of one line's text. */
export const CALL_LINES = 120;
export const CALL_LINE_TEXT = 1000;

/** The call a row is the record of (its meta.call with lines), else undefined. */
export function callRecord(message: Pick<Message, 'kind' | 'meta'>): CallRecord | undefined {
  const call = message.meta.call;
  return message.kind === 'status' && call && Array.isArray((call as Partial<CallRecord>).lines) ? call as CallRecord : undefined;
}

/** "4:42", "1:02:05": how long a call ran. */
export function callLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const two = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
}

/** Audio and turn events of a realtime session for its device (calls.realtimePull). */
export type RealtimeOut =
  | { seq: number; type: 'audio'; data: string } // base64 PCM16 LE mono 24 kHz
  | { seq: number; type: 'speaking' } // the model started an answer
  | { seq: number; type: 'done' } // the answer ended
  | { seq: number; type: 'interrupted' } // the person talked over it: stop playback now
  | { seq: number; type: 'error'; message: string };

export interface RealtimePull { events: RealtimeOut[]; next: number; closed?: string }

/** Sample rate of realtime audio in both directions (PCM16 LE mono). */
export const REALTIME_RATE = 24_000;
/** One calls.realtimeSend chunk: at most this many base64 characters (≈ 0.5 s of audio). */
export const REALTIME_MAX_CHUNK = 32_768;

declare module './chat.ts' {
  interface MessageMeta {
    /** A line said in a call (CallLineMeta), or – on the call's own quiet row – the call itself (CallRecord). */
    call?: CallLineMeta | CallRecord;
  }
  interface SpeechMeta {
    /** Said in a live conversation (not dictated into the composer): never folded into a running turn. */
    live?: true;
    /** On the way in only (messages.send): the call the live line belongs to (calls.start); stored as meta.call. */
    call?: string;
  }
}

declare module '../api/methods.ts' {
  interface Methods {
    /** Opens this device's call in a chat – its quiet row – or returns the one already open there; it ends with calls.end or the connection. */
    'calls.start': { params: { conversationId: string }; result: { callId: string } };
    /** Ends this device's call: its row gets endedAt. */
    'calls.end': { params: { callId: string }; result: { ok: true } };
    /** Opens a realtime voice session for this device in a chat (only with a connected realtime model). */
    'calls.realtimeOpen': { params: { conversationId: string }; result: { sessionId: string; model: string; agentId: string } };
    /** Microphone audio: base64 PCM16 LE mono 24 kHz. */
    'calls.realtimeSend': { params: { sessionId: string; audio: string }; result: { ok: true } };
    /** Waits (≤ 25 s) for the session's next audio/turn events after `after`. */
    'calls.realtimePull': { params: { sessionId: string; after?: number }; result: RealtimePull };
    /** The person talked over the answer on this device: the model stops it. */
    'calls.realtimeInterrupt': { params: { sessionId: string; playedMs?: number }; result: { ok: true } };
    'calls.realtimeClose': { params: { sessionId: string }; result: { ok: true } };
  }
}
