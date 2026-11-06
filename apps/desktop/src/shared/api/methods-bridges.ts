// RPC contract part: chat bridges (a chat mirrored to Telegram) and the Telegram owner link.
// Handlers: runtime/rpc/handlers/bridges.ts.
// Merged into Methods by module augmentation (split from methods.ts by area, 23.10.).
// Owns: these method shapes. Never: behaviour.

import type { Bridge, ConnectTelegramInput, OwnerLinkCode } from '../model/bridges.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- chat bridges (added by R4 contracts)
    'bridges.list': { params: { conversationId?: string } | void; result: Bridge[] };
    /** Mirrors a chat to a Telegram chat. A `botToken` goes straight into the secret vault. Owner scope. */
    'bridges.connectTelegram': { params: ConnectTelegramInput; result: Bridge };
    'bridges.disconnect': { params: { id: string }; result: { ok: true } };

    // ----------------------------------------------------------------- Telegram owner link (added by C9; owner only)
    /** "Link my Telegram": a one-time code (8 characters, 10 minutes, memory only) for /link in the bridged chat; replaces an unused one. */
    'bridges.linkOwner': { params: { id: string }; result: OwnerLinkCode };
    /** The linked Telegram account posts as an external contact again; an unused code is withdrawn. */
    'bridges.unlinkOwner': { params: { id: string }; result: Bridge };
  }
}

export {};
