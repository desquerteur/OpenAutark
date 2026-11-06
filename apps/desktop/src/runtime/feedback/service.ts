// Owns: local human/agent reports, redaction, deduplication, whether this build can send (`status`: a receiver
// shipped in resources/feedback/receiver.json) and explicit delivery (delivery.ts: sealed for the team, B-055), plus
// the team side on the PC holding the team's key (inbox.ts, setup.ts).
// Never: opens an issue form, publishes anything (every report is sealed for the team; `visibility` is ignored) or
// claims delivery before the mailbox answered. Older browser drafts ('queued', with their stored url) stay readable.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { FeedbackApi } from '../rpc/extras.ts';
import { type FeedbackKind, type FeedbackReport, type FeedbackVisibility } from '../../shared/model/system.ts';
import type { FeedbackSetupResult, FeedbackStatus } from '../../shared/model/feedback-delivery.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { FeedbackRepo } from '../store/feedback.ts';
import { redactText } from './redact.ts';
import { deliver } from './delivery.ts';
import { FeedbackInbox } from './inbox.ts';
import { readReceiver, type ReceiverConfig } from './receiver.ts';
import { setupReceiver, type SetupInput } from './setup.ts';

const KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];
const MAX_TEXT = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** New reports one agent may file per 24 h (repeats of the same text only raise `count`). */
export const AGENT_REPORTS_PER_DAY = 5;

export interface FeedbackInput {
  kind: FeedbackKind;
  text: string;
  screenshotFileId?: string;
  annotationFileId?: string;
  view?: string;
  conversationId?: string;
  /** The agent run that filed the report (agent reports only). */
  runId?: string;
  author: string;
}

export interface SendOptions {
  /** Accepted for older clients and ignored: every report is sealed for the team (B-055). */
  visibility?: FeedbackVisibility;
  /** Accepted for older clients; images are transferred with the report. */
  reveal?: boolean;
}

/** Delay of the one inbox fetch after start (receiving PCs only), so it never competes with the start itself. */
export const START_FETCH_DELAY_MS = 15_000;

export interface FeedbackDeps {
  services: () => RuntimeServices;
  repo?: FeedbackRepo;
  /** OS label for reports (tests); default "<platform> <release> <arch>". */
  os?: string;
  /** The receiver (tests); default resources/feedback/receiver.json. `null`: sending is not set up. */
  receiver?: ReceiverConfig | null;
  fetch?: typeof globalThis.fetch;
  /** Google's endpoints for the team inbox (tests). */
  firestore?: string;
  tokenUrl?: string;
}

/** Comparison key for "the same report": case and whitespace do not matter. */
function sameTextKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export class FeedbackService implements FeedbackApi {
  private readonly deps: FeedbackDeps;
  private repoInstance: FeedbackRepo | undefined;
  private readonly sending = new Map<string, Promise<FeedbackReport>>();
  /** The team inbox (owner only, RPC feedback.inbox*); empty on every PC without the team's key. */
  readonly inbox: FeedbackInbox;

  constructor(deps: FeedbackDeps) {
    this.deps = deps;
    this.repoInstance = deps.repo;
    this.inbox = new FeedbackInbox({ services: deps.services, fetch: deps.fetch, firestore: deps.firestore, tokenUrl: deps.tokenUrl });
  }

  /** Once at app start: on the team's PC one inbox fetch shortly after (no timer after it). */
  start(): void {
    const timer = setTimeout(() => {
      if (!this.inbox.receiving()) return;
      this.inbox.fetch().catch((error: unknown) => this.deps.services().log.warn('feedback inbox fetch failed', { error: error instanceof Error ? error.message : String(error) }));
    }, START_FETCH_DELAY_MS);
    timer.unref?.();
  }

  /** wf feedback setup (owner only). */
  setup(input: SetupInput): Promise<FeedbackSetupResult> {
    return setupReceiver(this.deps.services(), input);
  }

  create(input: FeedbackInput): FeedbackReport {
    const s = this.deps.services();
    if (!KINDS.includes(input.kind)) throw new WorkforceError('bad_request', 'Choose bug, idea, change or praise.');
    const textValue = typeof input.text === 'string' ? input.text.trim() : '';
    if (!textValue) throw new WorkforceError('bad_request', 'Describe the problem or idea.');
    if (textValue.length > MAX_TEXT) throw new WorkforceError('bad_request', `Keep the report under ${MAX_TEXT} characters.`);
    for (const id of [input.screenshotFileId, input.annotationFileId]) {
      if (id && !s.files.get(id)) throw new WorkforceError('not_found', 'The attached screenshot was not found.');
    }
    const now = s.clock.now();
    const author = input.author || HUMAN_ID;
    const text = this.redact(s, textValue);
    if (author !== HUMAN_ID) {
      const repeated = this.agentRepeat(s, author, text, now);
      if (repeated) return repeated;
    }
    const report: FeedbackReport = {
      id: newId('fb', now),
      kind: input.kind,
      text,
      author,
      context: {
        view: input.view?.slice(0, 120) || undefined,
        conversationId: input.conversationId,
        runId: author !== HUMAN_ID ? input.runId : undefined,
        version: s.host.app.version,
        os: this.deps.os ?? `${process.platform} ${os.release()} ${process.arch}`,
      },
      status: 'local',
      createdAt: now,
    };
    if (input.screenshotFileId) report.screenshotFileId = input.screenshotFileId;
    if (input.annotationFileId) report.annotationFileId = input.annotationFileId;
    if (!report.context.view) delete report.context.view;
    if (!report.context.conversationId) delete report.context.conversationId;
    if (!report.context.runId) delete report.context.runId;
    this.repo(s).save(report);
    s.bus.emit('feedback.upserted', report);
    return report;
  }

  list(): FeedbackReport[] {
    return this.repo(this.deps.services()).list(200);
  }

  /** Whether Send can deliver in this build (a receiver is shipped) and whether this PC holds the team's key; never a network call. */
  status(): FeedbackStatus {
    return { sending: Boolean(this.receiver(this.deps.services())), receiving: this.inbox.receiving() };
  }

  /**
   * Explicit user action: seal the report for the team and drop it into the mailbox. Concurrent clicks share one
   * request; `visibility` is ignored (nothing is public any more).
   */
  async send(id: string, options: SendOptions = {}): Promise<FeedbackReport> {
    const s = this.deps.services();
    const repo = this.repo(s);
    const report = repo.get(id);
    if (!report) throw new WorkforceError('not_found', 'This report no longer exists.');
    if (options.visibility !== undefined && options.visibility !== 'public' && options.visibility !== 'private') throw new WorkforceError('bad_request', 'Unknown feedback audience.');
    if (report.status === 'sent') return report;
    let active = this.sending.get(id);
    if (!active) {
      // B-078 (D17): every report carries the redacted log tail; feedback.includeDiagnostics is no longer read.
      active = deliver(s, report, this.diagnostics(s), this.receiver(s), this.deps.fetch)
        .then((sent) => { repo.save(sent); s.bus.emit('feedback.upserted', sent); return sent; })
        .finally(() => { this.sending.delete(id); });
      this.sending.set(id, active);
    }
    return active;
  }

  dismiss(id: string): FeedbackReport {
    const s = this.deps.services();
    const repo = this.repo(s);
    const report = repo.get(id);
    if (!report) throw new WorkforceError('not_found', 'This report no longer exists.');
    if (report.status === 'sent') throw new WorkforceError('conflict', 'This report was already sent.');
    if (report.status === 'dismissed') return report;
    const dismissed: FeedbackReport = { ...report, status: 'dismissed' };
    repo.save(dismissed);
    s.bus.emit('feedback.upserted', dismissed);
    return dismissed;
  }

  // ------------------------------------------------------------------ internals

  /** The team's receiver this build sends to (undefined = sending is not set up). */
  private receiver(s: RuntimeServices): ReceiverConfig | undefined {
    return this.deps.receiver === undefined ? readReceiver(s) : this.deps.receiver ?? undefined;
  }

  private repo(s: RuntimeServices): FeedbackRepo {
    this.repoInstance ??= new FeedbackRepo(s.db);
    return this.repoInstance;
  }

  /**
   * Agent reports: the same text from the same agent within 24 h raises the earlier report's
   * `count` (returned); a 6th new report within 24 h is refused with a short text the agent sees.
   */
  private agentRepeat(s: RuntimeServices, author: string, text: string, now: number): FeedbackReport | undefined {
    const repo = this.repo(s);
    const recent = repo.byAuthorSince(author, now - DAY_MS);
    const key = sameTextKey(text);
    const same = recent.find((entry) => sameTextKey(entry.text) === key);
    if (same) {
      const counted: FeedbackReport = { ...same, count: (same.count ?? 1) + 1 };
      repo.save(counted);
      s.bus.emit('feedback.upserted', counted);
      return counted;
    }
    if (recent.length >= AGENT_REPORTS_PER_DAY) {
      throw new WorkforceError('conflict', `You already filed ${AGENT_REPORTS_PER_DAY} feedback reports in the last 24 hours. Do not file more today; mention the problem in your reply instead.`, { details: { limit: AGENT_REPORTS_PER_DAY } });
    }
    return undefined;
  }

  private redact(s: RuntimeServices, value: string): string {
    let out = value;
    try { out = s.secrets.redact(out); } catch { /* pattern redaction still runs */ }
    return redactText(out);
  }

  /** Last warnings/errors of the runtime log (message + error text only), redacted. */
  private diagnostics(s: RuntimeServices): string | undefined {
    const file = path.join(s.paths.logs, 'runtime.log');
    let tail: string;
    try {
      const size = statSync(file).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = openSync(file, 'r');
      try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
      tail = buffer.toString('utf8');
    } catch {
      return undefined;
    }
    const lines: string[] = [];
    for (const line of tail.split('\n')) {
      let entry: { t?: string; level?: string; msg?: string; data?: { error?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.level !== 'warn' && entry.level !== 'error') continue;
      const error = typeof entry.data?.error === 'string' ? `: ${entry.data.error.slice(0, 160)}` : '';
      lines.push(`${entry.t ?? ''} ${entry.level} ${String(entry.msg ?? '').slice(0, 120)}${error}`);
    }
    if (!lines.length) return undefined;
    return this.redact(s, lines.slice(-15).join('\n')).slice(0, 2000);
  }
}
