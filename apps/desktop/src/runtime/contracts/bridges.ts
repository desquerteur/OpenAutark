// Runtime service contract: the owner's own Telegram account on a chat bridge (C9, "Link my
// Telegram"). Implemented by bridges/service.ts Bridges (logic in bridges/owner-link.ts) and
// reached over RPC through RpcExtras.bridges (rpc/handlers/bridges.ts).
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { Bridge, OwnerLinkCode } from '../../shared/model/bridges.ts';

export interface OwnerLinkApi {
  /**
   * A fresh one-time code (8 characters, valid 10 minutes, memory only) for "/link <code>" in the
   * bridged Telegram chat; replaces an unused one. 'not_found' for an unknown bridge,
   * 'bad_request' for a channel (its posts have no person to link).
   */
  linkOwner(id: string): OwnerLinkCode;
  /** The linked account posts as an external contact again; an unused code is withdrawn. */
  unlinkOwner(id: string): Bridge;
}
