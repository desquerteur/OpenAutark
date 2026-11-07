// AF-013: the window's view of access – the approval requests waiting for the person (access.requested/resolved, all
// of them loaded again on every connect) and the access in effect per agent and chat (access.get, read again on
// access.changed). Only the person on the PC answers requests and changes modes; elsewhere the lists stay empty.
// Owns: these signals and the calls that change access. Never: renders.

import { signal, type Signal } from '@preact/signals';
import type { AccessAnswer, AccessMode, AccessRequest, AccessRules, EffectiveAccess } from '../../shared/model/access.ts';
import { ACCESS_MODES } from '../../shared/model/access.ts';
import '../../shared/api/methods-access.ts';
import { rpc } from './rpc.ts';
import { isOwner } from './session.ts';

export const accessRequests = signal<AccessRequest[]>([]);
const known = new Map<string, Signal<EffectiveAccess | null>>();

const keyOf = (agentId: string, conversationId?: string) => `${agentId}|${conversationId ?? ''}`;

async function load(key: string, slot: Signal<EffectiveAccess | null>): Promise<void> {
  const [agentId, conversationId] = key.split('|');
  try {
    slot.value = await rpc.call('access.get', { agentId: agentId!, ...(conversationId ? { conversationId } : {}) });
  } catch { /* an older runtime or no right to read it: no cell */ }
}

async function loadPending(): Promise<void> {
  if (!isOwner()) { accessRequests.value = []; return; }
  try { accessRequests.value = await rpc.call('access.pending'); } catch { accessRequests.value = []; }
}

let wired = false;
/** Wires the events once (the dialog host and the mode cell call it). */
export function wireAccess(): void {
  if (wired) return;
  wired = true;
  rpc.on('access.requested', (request) => {
    if (!accessRequests.peek().some((entry) => entry.id === request.id)) accessRequests.value = [...accessRequests.peek(), request];
  });
  rpc.on('access.resolved', ({ id }) => { accessRequests.value = accessRequests.peek().filter((entry) => entry.id !== id); });
  rpc.on('access.changed', () => { for (const [key, slot] of known) void load(key, slot); });
  rpc.onOpen(() => {
    void loadPending();
    for (const [key, slot] of known) void load(key, slot);
  });
  if (rpc.status.peek() === 'open') void loadPending();
}

/** The access in effect for the agent's turns (in this chat when given); null until it is known. */
export function accessFor(agentId: string, conversationId?: string): Signal<EffectiveAccess | null> {
  wireAccess();
  const key = keyOf(agentId, conversationId);
  let slot = known.get(key);
  if (!slot) {
    slot = signal<EffectiveAccess | null>(null);
    known.set(key, slot);
    void load(key, slot);
  }
  return slot;
}

/** The mode after `mode` in the composer's cycle. */
export function nextMode(mode: AccessMode): AccessMode {
  return ACCESS_MODES[(ACCESS_MODES.indexOf(mode) + 1) % ACCESS_MODES.length]!;
}

export async function setChatMode(conversationId: string, mode: AccessMode | null): Promise<void> {
  await rpc.call('access.setChatMode', { conversationId, mode });
}

export async function setAgentAccess(agentId: string, patch: { mode?: AccessMode; rules?: AccessRules }): Promise<EffectiveAccess> {
  return rpc.call('access.set', { agentId, ...patch });
}

export async function answerRequest(id: string, answer: AccessAnswer): Promise<void> {
  accessRequests.value = accessRequests.peek().filter((entry) => entry.id !== id);
  await rpc.call('access.answer', { id, answer });
}
