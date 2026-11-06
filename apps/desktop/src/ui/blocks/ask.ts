// Answering ask blocks from anywhere (chat, "For you" list, Home, PWA): where the answer goes,
// whether a block is already answered, and the one-line receipt text. An 'approve' answer is a plain
// answer like any other ({approved, note?}) – nothing is binding. B-076: a click is the person's own line
// (shared/blocks/answer-text.ts); an answered block in the chat shows what it asked, their line below what they picked.
// Owns: AskTarget, submitAnswer(), submitSnooze(), useAnswered(), receipt summaries and the asked text.

import { useEffect, useState } from 'preact/hooks';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { answerText, oneLine } from '../../shared/blocks/answer-text.ts';
import { blockKey } from '../../shared/blocks/parse.ts';
import { newId } from '../../shared/ids.ts';
import { rpc } from '../lib/rpc.ts';

export type AskTarget =
  | { kind: 'block'; messageId: string; blockIndex: number }
  | { kind: 'task'; taskId: string; messageId?: string; blockIndex?: number };

export function targetKey(target: AskTarget): string {
  if (target.kind === 'block') return blockKey(target.messageId, target.blockIndex);
  return target.messageId !== undefined && target.blockIndex !== undefined ? blockKey(target.messageId, target.blockIndex) : `task_${target.taskId}`;
}

/** Sends the human's answer. Idempotent per click via clientId (double-tap guard). */
export async function submitAnswer(target: AskTarget, answer: unknown): Promise<void> {
  const clientId = newId('up');
  if (target.kind === 'task') {
    await rpc.call('tasks.complete', { id: target.taskId, answer, clientId });
    return;
  }
  await rpc.call('blocks.answer', { messageId: target.messageId, blockIndex: target.blockIndex, answer, clientId });
}

/** Snoozes the to-do behind a widget until `until` (F03). */
export async function submitSnooze(target: AskTarget, until: number): Promise<void> {
  if (target.kind === 'task') await rpc.call('todos.snooze', { id: target.taskId, until });
  else await rpc.call('todos.snooze', { messageId: target.messageId, blockIndex: target.blockIndex, until });
}

/** Answered state shared by every mounted widget of the same block (chat + list at once). */
const answered = new Map<string, string>();
const listeners = new Set<() => void>();
let listening = false;

function markAnswered(key: string, summary: string): void {
  answered.set(key, summary);
  for (const fn of [...listeners]) fn();
}

function listen(): void {
  if (listening) return;
  listening = true;
  // A receipt message (kind 'answer') names the block it answers.
  rpc.on('message.created', message => {
    const meta = message.meta?.answer;
    if (message.kind === 'answer' && meta?.blockKey) markAnswered(meta.blockKey, meta.summary);
  });
}

/** Local optimistic receipt after a successful submit. */
export function noteAnswered(target: AskTarget, summary: string): void {
  markAnswered(targetKey(target), summary);
}

/**
 * Receipt text if the block is answered (undefined while open). Block targets ask the runtime
 * once (`blocks.state`); task targets are open by definition (answered tasks leave the list).
 */
export function useAnswered(target: AskTarget): string | undefined {
  const key = targetKey(target);
  const [, force] = useState(0);
  useEffect(() => {
    listen();
    const fn = () => force(n => n + 1);
    listeners.add(fn);
    if (target.kind === 'block' && !answered.has(key)) {
      rpc.call('blocks.state', { messageId: target.messageId, blockIndex: target.blockIndex }).then(({ state }) => {
        const value = state as { answered?: boolean; answer?: unknown; summary?: string } | null | undefined;
        if (value && (value.answered || value.answer !== undefined)) markAnswered(key, value.summary ?? 'Answered');
      }).catch(() => undefined);
    }
    return () => { listeners.delete(fn); };
  }, [key]);
  return answered.get(key);
}

/**
 * One-line receipt: the person's own line on one line – "Approved", "Recorded 0:48", the picked option's text
 * (shared/blocks/answer-text.ts, the same words the chat shows as their line).
 */
export function receiptFor(block: UiBlock, answer: unknown): string {
  return oneLine(answerText(block, answer), 160);
}

/**
 * What an answered block asked (its title, question, action, label or first instruction line) – shown in its place in
 * the chat, where the person's own line below says what they picked (B-076: the click appears once). Undefined: none.
 */
export function askedText(block: UiBlock): string | undefined {
  for (const value of [block.title, block.question, block.action, block.label, block.instructions]) {
    const line = typeof value === 'string' ? value.split('\n')[0].replace(/[*_`#>]/g, '').trim() : '';
    if (line) return line.length > 120 ? `${line.slice(0, 119)}…` : line;
  }
  return undefined;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}
