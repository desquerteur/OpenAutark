// Pure helpers for "Link my Telegram" on a chat details Telegram row (BridgeOwner.tsx, C9):
// whether a link can be offered, the texts, and when a shown code stops being usable – at its expiry (the runtime's rule: gone from
// expiresAt on) or once the bridge was linked after the code was made (a code works once).
// Owns: these rules. Never: timers, RPC or the DOM (the component schedules its one re-render).

import { OWNER_LINK_CODE_MS } from '../../../shared/model/bridges.ts';
import type { Bridge, OwnerLinkCode } from '../../../shared/model/bridges.ts';

/** Channels post without a person behind them, and a stopped bridge reads nothing. */
export function canLinkOwner(bridge: Bridge): boolean {
  return !bridge.externalChatId.startsWith('@') && bridge.status !== 'stopped';
}

/** What the person types in Telegram. */
export function linkCommandText(code: OwnerLinkCode): string {
  return `/link ${code.code}`;
}

export function ownerText(bridge: Bridge): string | undefined {
  if (!bridge.owner) return undefined;
  return `Linked to ${bridge.owner.name} on Telegram: messages from that account post as you.`;
}

/** Anyone else who sends the code only cancels it, so: as yourself, and a typo is sent again (an edit of the message counts too). */
export function codeHint(code: OwnerLinkCode, until: string): string {
  return `Send ${linkCommandText(code)} in this Telegram chat from your own account by ${until}, as yourself (not as an anonymous admin). If you mistype it, send it again as a new message. The code works once.`;
}

/** Expired from expiresAt on, as the runtime counts it. */
export function codeExpired(code: Pick<OwnerLinkCode, 'expiresAt'>, now: number): boolean {
  return code.expiresAt <= now;
}

/** The bridge was linked after this code was made (both times come from the runtime's clock). */
export function codeUsed(code: OwnerLinkCode, bridge: Bridge): boolean {
  return bridge.id === code.bridgeId && bridge.owner !== undefined && bridge.owner.linkedAt >= code.expiresAt - OWNER_LINK_CODE_MS;
}
