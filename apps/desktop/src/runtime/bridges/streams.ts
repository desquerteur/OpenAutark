// Update streams of chat bridges: one TelegramPoller per bot, shared by every bridge that uses
// the same bot (Telegram allows one getUpdates reader per bot), with its connection state.
// Owns: creating, restarting (new token for the same bot) and stopping those pollers, and which
// bridges belong to which stream. Never: touches chats, rows or events (the service does), or
// keeps a stream running without bridges.

import type { BridgeStatus } from '../../shared/model/bridges.ts';
import type { RuntimeServices } from '../contracts.ts';
import { TelegramPoller } from './poller.ts';
import type { PollerState, Sleep } from './poller.ts';
import type { TelegramApi, TgUpdate } from './telegram-api.ts';

export interface Stream {
  botId: string;
  token: string;
  bridges: Set<string>;
  state: { status: BridgeStatus; error?: string };
  poller?: TelegramPoller;
}

export interface StreamsOptions {
  api: TelegramApi;
  sleep: Sleep;
  services: () => RuntimeServices;
  onUpdates(stream: Stream, updates: TgUpdate[]): void;
  onOffset(stream: Stream, offset: number): void;
  onState(stream: Stream): void;
}

export class Streams {
  private readonly o: StreamsOptions;
  private readonly byBot = new Map<string, Stream>();

  constructor(options: StreamsOptions) {
    this.o = options;
  }

  get(botId: string): Stream | undefined {
    return this.byBot.get(botId);
  }

  /** The stream of a bot; created and started on first use, restarted when the token changed. */
  ensure(botId: string, token: string, offset: number | undefined): Stream {
    let stream = this.byBot.get(botId);
    if (stream && stream.token === token) return stream;
    if (stream) { // a new token for the same bot (the old one was revoked): continue at the same offset
      offset = stream.poller?.offset;
      stream.poller?.stop();
      stream.token = token;
    } else {
      stream = { botId, token, bridges: new Set(), state: { status: 'connecting' } };
      this.byBot.set(botId, stream);
    }
    this.startPoller(stream, offset);
    return stream;
  }

  /** Removes a bridge; the last one ends the bot's long poll. */
  leave(botId: string, bridgeId: string): void {
    const stream = this.byBot.get(botId);
    if (!stream) return;
    stream.bridges.delete(bridgeId);
    if (stream.bridges.size) return;
    stream.poller?.stop();
    this.byBot.delete(botId);
  }

  stopAll(): void {
    for (const stream of this.byBot.values()) stream.poller?.stop();
    this.byBot.clear();
  }

  private startPoller(stream: Stream, offset: number | undefined): void {
    const s = this.o.services();
    // Callbacks of a replaced poller (token change) are ignored.
    const poller: TelegramPoller = new TelegramPoller({
      api: this.o.api, token: stream.token, offset, clock: s.clock, log: s.log, sleep: this.o.sleep,
      onUpdates: (updates) => { if (stream.poller === poller) this.o.onUpdates(stream, updates); },
      onOffset: (next) => { if (stream.poller === poller) this.o.onOffset(stream, next); },
      onState: (state: PollerState) => {
        if (stream.poller !== poller) return;
        stream.state = state.error ? { status: state.status, error: state.error } : { status: state.status };
        this.o.onState(stream);
      },
    });
    stream.poller = poller;
    poller.start();
  }
}
