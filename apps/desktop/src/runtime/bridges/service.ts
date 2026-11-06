// Chat bridges: mirrors chats to Telegram bots. Incoming messages become messages of external members
// (route.ts → inbound.ts) – except the owner's account, which posts as the person (owner-link.ts); final agent
// answers and the owner's messages in a linked chat are sent back as plain text (outbound.ts). Agents connect a
// chat themselves with telegram.connect (tools.ts, skill telegram-setup).
// Owns: the `bridges` rows (repo.ts), one long-poll loop per bot (streams.ts/poller.ts; at most
// one request in flight per bot, no timers polling), a serial outbound queue per bridge, bridge
// status/error and bridge.upserted events (disconnect = 'stopped', the row and its link go).
// Never: stores or logs bot tokens outside the secret vault (rows keep the vault handle; a token
// lives in memory only while its loop runs), returns secret values to clients, sends a token
// anywhere but api.telegram.org, echoes messages that came from Telegram, or turns a bridge
// message into an answer or approval (the linked owner's, too, are plain text messages).

import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Bridge, BridgeStatus, ConnectTelegramInput, OwnerLinkCode } from '../../shared/model/bridges.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { OwnerLinkApi } from '../contracts/bridges.ts';
import type { BridgesApi } from '../rpc/extras.ts';
import type { ToolDef } from '../tools/types.ts';
import { OwnerLinks } from './owner-link.ts';
import { SerialQueues, outboundChunks, sendChunks, sendErrorText, shouldForward } from './outbound.ts';
import { sleep as timerSleep } from './poller.ts';
import type { Sleep } from './poller.ts';
import { BridgeRepo, maxCursor, publicBridge } from './repo.ts';
import type { BridgeRecord } from './repo.ts';
import { routeUpdate } from './route.ts';
import type { RouteHost } from './route.ts';
import { Streams } from './streams.ts';
import type { Stream } from './streams.ts';
import { TelegramApi, TelegramError, botIdOf, scrub } from './telegram-api.ts';
import type { TgUpdate } from './telegram-api.ts';
import { storeToken, tokenFrom, verifyToken } from './tokens.ts';
import { telegramTools } from './tools.ts';

export interface BridgesDeps {
  services: () => RuntimeServices;
  /** Injectable for tests; default the global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests (backoff and retry_after waits); default a timer that stop() cancels. */
  sleep?: Sleep;
}

export class Bridges implements BridgesApi, OwnerLinkApi {
  private readonly deps: BridgesDeps;
  private readonly api: TelegramApi;
  private readonly sleep: Sleep;
  private readonly streams: Streams;
  private readonly live = new Map<string, { bridge: Bridge; botId: string; ownerUserId?: string }>(); // running bridges
  private readonly sendErrors = new Map<string, string>(); // bridge id → last outbound failure
  private readonly queues: SerialQueues;
  private readonly owners: OwnerLinks;
  private readonly shutdown = new AbortController();
  private offs: Array<() => void> = [];
  private store?: BridgeRepo;
  private resumed?: Promise<void>;

  constructor(deps: BridgesDeps) {
    this.deps = deps;
    this.api = new TelegramApi(deps.fetch);
    this.sleep = deps.sleep ?? timerSleep;
    this.queues = new SerialQueues((id, error) => this.s().log.error('telegram outbound queue failed', { bridgeId: id, error: String(error) }));
    this.streams = new Streams({
      api: this.api, sleep: this.sleep, services: deps.services,
      onUpdates: (stream, updates) => this.onUpdates(stream, updates),
      onOffset: (stream, offset) => this.repo().setCursor([...stream.bridges], String(offset)),
      onState: (stream) => { for (const id of stream.bridges) this.refresh(id); },
    });
    this.owners = new OwnerLinks({
      services: deps.services, repo: () => this.repo(), emit: (record) => this.emit(record),
      reply: (id, text) => this.queues.push(id, () => this.deliver(id, [text])),
    });
  }

  /** Resumes stored bridges (called once the HTTP server listens). */
  start(): void {
    if (this.shutdown.signal.aborted || this.resumed) return;
    this.listen();
    const rows = this.repo().list();
    this.resumed = rows.length ? this.resume(rows) : Promise.resolve();
  }

  /** Aborts in-flight requests (called on shutdown, before the database closes). Rows keep their status. */
  stop(): void {
    this.shutdown.abort();
    for (const off of this.offs) off();
    this.offs = [];
    this.streams.stopAll();
    this.live.clear();
    this.owners.clear();
  }

  list(conversationId?: string): Bridge[] {
    return this.repo().list(conversationId).map(publicBridge);
  }

  async connectTelegram(input: ConnectTelegramInput): Promise<Bridge> {
    const s = this.s();
    if (!s.chats.get(input.conversationId)) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId: input.conversationId } });
    const externalChatId = input.externalChatId.trim();
    this.assertNew(input.conversationId, externalChatId);
    const token = input.botToken ?? await tokenFrom(s, input.secretId ?? '');
    const bot = await verifyToken(s, this.api, token, this.shutdown.signal);
    const secretId = input.botToken !== undefined ? await storeToken(s, token, bot) : input.secretId!;
    this.assertNew(input.conversationId, externalChatId); // a parallel connect may have won meanwhile
    const now = s.clock.now();
    const record: BridgeRecord = {
      id: newId('br', now), kind: 'telegram', conversationId: input.conversationId, externalChatId, status: 'connecting',
      createdAt: now, updatedAt: now, secretId,
    };
    this.repo().insert(record);
    this.listen();
    this.emit(record);
    this.track(this.streams.ensure(botIdOf(token), token, undefined), record);
    return publicBridge(this.repo().get(record.id) ?? record);
  }

  disconnect(id: string): void {
    const record = this.repo().get(id);
    if (!record) throw new WorkforceError('not_found', 'Bridge not found.', { details: { id } });
    this.untrack(id);
    this.repo().remove(id); // the owner link goes with the row
    this.stopped(publicBridge(record));
  }

  /** "Link my Telegram" in a group: a one-time code for /link in the bridged chat (10 minutes, memory only). */
  linkOwner(id: string): OwnerLinkCode { return this.owners.issue(id); }
  /** The linked Telegram account posts as an external contact again; an unused code is withdrawn. */
  unlinkOwner(id: string): Bridge { return this.owners.unlink(id); }

  /** Agent tools of this module (registered by the composition root): telegram.connect. */
  tools(): ToolDef[] { return telegramTools({ api: this.api, connect: (input) => this.connectTelegram(input) }); }

  /** Resolves once resuming and every queued outbound message are done (tests, diagnostics). */
  async settled(): Promise<void> {
    await this.resumed;
    await this.queues.idle();
  }

  // ------------------------------------------------------------- streams

  private async resume(rows: BridgeRecord[]): Promise<void> {
    const bySecret = new Map<string, BridgeRecord[]>();
    for (const row of rows) bySecret.set(row.secretId, [...(bySecret.get(row.secretId) ?? []), row]);
    const byBot = new Map<string, { token: string; rows: BridgeRecord[] }>();
    for (const [secretId, list] of bySecret) {
      let token: string;
      try {
        token = await tokenFrom(this.s(), secretId);
      } catch {
        for (const row of list) this.setStatus(row.id, 'error', 'The bot token is missing in the vault. Connect again.');
        continue;
      }
      if (this.shutdown.signal.aborted) return;
      const entry = byBot.get(botIdOf(token)) ?? { token, rows: [] };
      entry.rows.push(...list);
      byBot.set(botIdOf(token), entry);
    }
    for (const [botId, entry] of byBot) {
      const stream = this.streams.ensure(botId, entry.token, maxCursor(entry.rows));
      for (const row of entry.rows) {
        const fresh = this.repo().get(row.id); // disconnected while the vault answered?
        if (fresh) this.track(stream, fresh);
      }
    }
  }

  private track(stream: Stream, record: BridgeRecord): void {
    stream.bridges.add(record.id);
    this.live.set(record.id, { bridge: publicBridge(record), botId: stream.botId, ownerUserId: record.ownerUserId });
    const offset = stream.poller?.offset;
    if (offset !== undefined) this.repo().setCursor([record.id], String(offset));
    this.refresh(record.id);
  }

  private untrack(id: string): void {
    const live = this.live.get(id);
    this.live.delete(id);
    this.sendErrors.delete(id);
    this.owners.forget(id);
    if (live) this.streams.leave(live.botId, id);
  }

  private onUpdates(stream: Stream, updates: TgUpdate[]): void {
    const host: RouteHost = {
      services: () => this.s(), owners: this.owners, migrate: (id, chatId) => this.migrate(id, chatId),
      target: (id) => { const live = this.live.get(id); return live && { id, ...live }; },
    };
    for (const update of updates) routeUpdate(host, stream, update);
  }

  /** Telegram turned the group into a supergroup with a new chat id. */
  private migrate(id: string, externalChatId: string): void {
    const live = this.live.get(id);
    if (!live || live.bridge.externalChatId === externalChatId) return;
    this.repo().setExternalChatId(id, externalChatId, this.s().clock.now());
    const record = this.repo().get(id);
    if (record) this.emit(record);
  }

  // ------------------------------------------------------------- outbound

  private onMessage(message: Message, updated: boolean): void {
    if (!this.live.size || !shouldForward(message, updated)) return;
    let chunks: string[] | undefined;
    for (const [id, live] of this.live) {
      if (live.bridge.conversationId !== message.conversationId) continue;
      chunks ??= outboundChunks(this.s(), message);
      const text = chunks;
      this.queues.push(id, () => this.deliver(id, text));
    }
  }

  private async deliver(id: string, chunks: string[], migrated = false): Promise<void> {
    const live = this.live.get(id);
    const stream = live ? this.streams.get(live.botId) : undefined;
    if (!live || !stream || this.shutdown.signal.aborted) return; // disconnected or shutting down
    try {
      await sendChunks(this.api, { token: stream.token, chatId: live.bridge.externalChatId }, chunks, { sleep: this.sleep, signal: this.shutdown.signal });
      if (this.sendErrors.delete(id)) this.refresh(id);
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      const failure = error instanceof TelegramError ? error : undefined;
      if (failure?.migrateTo && !migrated) {
        this.migrate(id, failure.migrateTo);
        return this.deliver(id, chunks, true);
      }
      this.s().log.warn('telegram send failed', { bridgeId: id, kind: failure?.kind ?? 'internal', detail: failure?.detail ?? scrub(String(error), stream.token) });
      this.sendErrors.set(id, sendErrorText(error));
      this.refresh(id);
    }
  }

  // ------------------------------------------------------------- helpers

  /** Status = the stream's state, or 'error' with the last send failure while the stream is fine. */
  private refresh(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    const state = this.streams.get(live.botId)?.state ?? { status: 'error' as const, error: 'Not running.' };
    const sendError = this.sendErrors.get(id);
    if (state.status === 'connected' && sendError) this.setStatus(id, 'error', sendError);
    else this.setStatus(id, state.status, state.error);
  }

  private setStatus(id: string, status: BridgeStatus, error: string | undefined): void {
    const updated = this.repo().setStatus(id, status, error, this.s().clock.now());
    if (updated) this.emit(updated);
  }

  private emit(record: BridgeRecord): void {
    const bridge = publicBridge(record);
    const live = this.live.get(record.id);
    if (live) { live.bridge = bridge; live.ownerUserId = record.ownerUserId; }
    this.s().bus.emit('bridge.upserted', bridge);
  }

  /** There is no bridge.removed event: a gone bridge is reported once as 'stopped' (no error, no owner link). */
  private stopped(bridge: Bridge): void {
    const { error: _error, owner: _owner, ...rest } = bridge;
    this.s().bus.emit('bridge.upserted', { ...rest, status: 'stopped', updatedAt: this.s().clock.now() });
  }

  private listen(): void {
    if (this.offs.length) return;
    const bus = this.s().bus;
    this.offs.push(
      bus.on('message.created', (message) => this.onMessage(message, false)),
      bus.on('message.updated', (message) => this.onMessage(message, true)),
      bus.on('conversation.removed', ({ id }) => this.onChatRemoved(id)),
    );
  }

  /** Rows went with the chat (FK cascade); stop their streams and tell clients. */
  private onChatRemoved(conversationId: string): void {
    for (const [id, live] of [...this.live]) {
      if (live.bridge.conversationId !== conversationId) continue;
      this.untrack(id);
      this.stopped(live.bridge);
    }
  }

  private assertNew(conversationId: string, externalChatId: string): void {
    if (this.shutdown.signal.aborted) throw new WorkforceError('unavailable', 'Chat bridges are shutting down.');
    if (this.repo().find(conversationId, 'telegram', externalChatId)) throw new WorkforceError('conflict', 'This chat is already linked to that Telegram chat.');
  }

  private s(): RuntimeServices {
    return this.deps.services();
  }

  private repo(): BridgeRepo {
    this.store ??= new BridgeRepo(this.s().db);
    return this.store;
  }
}
