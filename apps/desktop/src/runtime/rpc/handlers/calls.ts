// RPC handlers: calls (runtime/calls). Every chat-capable client – this PC's window and main ('owner'), paired phones
// and browsers with 'chat' – starts and ends its call in a chat (calls.start/end: the call's row, call-log.ts), opens a
// realtime voice session there, streams audio into it, pulls its answers and closes it. The device is the connection's
// (key 'pc' for the owner, else the paired device id, named from the devices list), never a client parameter; its
// connection closing ends its call and session. Also registers the people's speech variants (F-52, people/rpc-voice.ts:
// their dictation and voice conversation).
// Owns: param checks and the device identity. Never: provider protocol or audio.

import { WorkforceError } from '../../../shared/errors.ts';
import type { CallDevice } from '../../../shared/model/call.ts';
import { callLogOf, realtimeOf } from '../../calls/wiring.ts';
import { registerPersonVoice } from '../../people/rpc-voice.ts';
import { callerDeviceName } from '../device-name.ts';
import { id, input, onlyKeys, optNum, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;

/** The calling device: this PC ('pc') or the paired phone/browser. */
export function callDevice(ctx: Pick<HandlerContext, 'scope' | 'services'>): CallDevice {
  if (ctx.scope.kind === 'device') return { key: ctx.scope.deviceId, name: callerDeviceName(ctx) ?? 'a phone' };
  if (ctx.scope.kind !== 'owner') throw new WorkforceError('forbidden', 'Realtime voice is not open to this connection.');
  let name = '';
  try { name = ctx.services.devices.self().name?.trim() ?? ''; } catch { name = ''; }
  return { key: 'pc', name: name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 60) || 'This PC' };
}

function callLog(ctx: Pick<HandlerContext, 'services'>) {
  const log = callLogOf(ctx.services);
  if (!log) throw new WorkforceError('unavailable', 'Calls are not available in this runtime.');
  return log;
}

export function register(table: HandlerTable): void {
  table.add('calls.start', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId']);
    return { callId: callLog(ctx).start(id(o, 'conversationId'), callDevice(ctx), ctx.signal) };
  }, CHAT);
  table.add('calls.end', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['callId']);
    callLog(ctx).end(text(o, 'callId', { max: 64 }), callDevice(ctx).key);
    return { ok: true };
  }, CHAT);
  table.add('calls.realtimeOpen', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId']);
    return realtimeOf(ctx.services).open(id(o, 'conversationId'), callDevice(ctx), ctx.signal);
  }, CHAT);
  table.add('calls.realtimeSend', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId', 'audio']);
    realtimeOf(ctx.services).send(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key, text(o, 'audio', { max: 40_000, allowEmpty: true }));
    return { ok: true };
  }, CHAT);
  table.add('calls.realtimePull', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId', 'after']);
    return realtimeOf(ctx.services).pull(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key, optNum(o, 'after', { min: 0 }) ?? 0, ctx.signal);
  }, CHAT);
  table.add('calls.realtimeInterrupt', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId', 'playedMs']);
    realtimeOf(ctx.services).interrupt(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key, optNum(o, 'playedMs', { min: 0, max: 3_600_000 }));
    return { ok: true };
  }, CHAT);
  table.add('calls.realtimeClose', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId']);
    realtimeOf(ctx.services).close(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key);
    return { ok: true };
  }, CHAT);
  registerPersonVoice(table); // F-52: people's utterance upload and transcription
}
