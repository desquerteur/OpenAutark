// The status line's data (shell/StatusLine.tsx draws it): anything that wants a line registers a provider –
// a plain function of signals returning its notice, a list (one per voice conversation, say) or null.
//   registerNotice(() => offline.value ? { id: 'connection', tone: 'error', text: 'Offline', priority: NOTICE_PRIORITY.connection } : null)
// Order: priority (higher first), then registration order; one notice per id; at most two actions each.
// Owns: the provider registry and the order. Never: renders, calls RPC itself or writes a notice's text.

import { computed, signal } from '@preact/signals';

export type NoticeTone = 'info' | 'warn' | 'error';

export interface NoticeAction {
  label: string;
  run: () => unknown;
  title?: string;
  /** The line's main answer: drawn as the filled button. */
  primary?: boolean;
}

export interface Notice {
  /** One line per id. */
  id: string;
  tone: NoticeTone;
  text: string;
  /** The text's tooltip. */
  detail?: string;
  actions?: readonly NoticeAction[];
  /** Higher first (NOTICE_PRIORITY). */
  priority: number;
  /** Offers Dismiss (the provider then stops returning it). */
  onDismiss?: () => void;
}

export type NoticeProvider = () => Notice | readonly Notice[] | null;

/** setup (no AI yet, a speech model loading) over toast: lasting to-do toasts never push those lines out of the three shown. */
export const NOTICE_PRIORITY = { connection: 100, workStop: 90, voice: 50, call: 45, computer: 40, setup: 35, toast: 30 } as const;

export const MAX_NOTICE_ACTIONS = 2;

const providers = signal<ReadonlyArray<{ provider: NoticeProvider }>>([]);

/** Adds a provider; returns the function that removes it again. */
export function registerNotice(provider: NoticeProvider): () => void {
  const entry = { provider };
  providers.value = [...providers.value, entry];
  return () => { providers.value = providers.value.filter((item) => item !== entry); };
}

/** The notices in order: priority, then the given order (the sort is stable); one per id, two actions at most. */
export function orderNotices(list: readonly Notice[]): Notice[] {
  const seen = new Set<string>();
  return [...list]
    .filter((notice) => notice.text)
    .sort((a, b) => b.priority - a.priority)
    .filter((notice) => !seen.has(notice.id) && Boolean(seen.add(notice.id)))
    .map((notice) => (notice.actions && notice.actions.length > MAX_NOTICE_ACTIONS ? { ...notice, actions: notice.actions.slice(0, MAX_NOTICE_ACTIONS) } : notice));
}

const isList = (result: Notice | readonly Notice[]): result is readonly Notice[] => Array.isArray(result);

/** Every provider's notices, ordered; a provider that throws is skipped. */
export const visibleNotices = computed<readonly Notice[]>(() => orderNotices(providers.value.flatMap(({ provider }) => {
  try {
    const result = provider();
    return !result ? [] : isList(result) ? result : [result];
  } catch (error) {
    console.error('A notice provider failed', error);
    return [];
  }
})));

/** The connection line: nothing while connected (and before the first load unless it failed). */
export function connectionNotice(state: { status: 'open' | 'connecting' | 'closed'; loaded: boolean; loadError: string | null }): Notice | null {
  if (state.status === 'open' && !state.loadError) return null;
  if (!state.loaded && state.status !== 'closed' && !state.loadError) return null;
  const text = state.status === 'open' ? state.loadError ?? '' : state.status === 'connecting' ? 'Reconnecting…' : 'Offline';
  return { id: 'connection', tone: state.status === 'connecting' ? 'warn' : 'error', text, priority: NOTICE_PRIORITY.connection };
}
