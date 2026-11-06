// Chat bridges model: a chat mirrored to an external messenger (Telegram first), so the
// person can talk to their agents from there.
// Owns: the plain-data shapes shared by runtime, UI, PWA and peers.
// Never: holds secret values (bot tokens stay in the secret vault; only the runtime knows the
// vault handle) or behaviour (beyond the pure fromBridgeOwner rule).

export type BridgeKind = 'telegram';

export type BridgeStatus = 'connecting' | 'connected' | 'error' | 'stopped';

export interface Bridge {
  id: string; // 'br_…'
  kind: BridgeKind;
  conversationId: string;
  externalChatId: string; // Telegram chat id (e.g. "123456789", "-100…") or "@channel"
  status: BridgeStatus;
  error?: string; // short, user-safe sentence (never a raw provider body or a token)
  createdAt: number;
  updatedAt: number;
}

/**
 * Input of bridges.connectTelegram: either a new `botToken` (stored in the vault by the
 * runtime, never echoed back) or the `secretId` of a token already in the vault.
 */
export interface ConnectTelegramInput {
  conversationId: string;
  botToken?: string;
  secretId?: string;
  externalChatId: string;
}

// ------------------------------------------------------------------ added by C9 (Telegram owner link)

/**
 * The owner's own Telegram account linked to a bridge in a group ("Link my Telegram"): its messages post as the
 * owner. In a private chat with the bot the chat's user is the owner without a link (runtime bridges/owner-link.ts).
 * Clients see the name only; the Telegram user id stays in the runtime.
 */
export interface BridgeOwner {
  name: string; // Telegram display name at link time (one line, ≤ 40 characters)
  linkedAt: number;
}

/** Bridge (above), extended by C9: set while the owner's Telegram account is linked. */
export interface Bridge {
  owner?: BridgeOwner;
}

/** How long a "Link my Telegram" code works (runtime bridges/owner-link.ts; the UI hides it then). */
export const OWNER_LINK_CODE_MS = 10 * 60_000;

/** Result of bridges.linkOwner: a one-time code for "/link <code>" in the bridged Telegram chat (memory only). */
export interface OwnerLinkCode {
  bridgeId: string;
  code: string; // 8 characters
  expiresAt: number;
}

/** A message the owner wrote in their messenger account: it posts as the human with meta.via 'bridge'. */
export function fromBridgeOwner(message: { authorKind: string; meta?: { via?: unknown } }): boolean {
  return message.authorKind === 'human' && message.meta?.via === 'bridge';
}

