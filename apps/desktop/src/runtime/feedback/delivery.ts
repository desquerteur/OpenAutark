// Sending one report (B-055 Q1/Q2): its facts and the (marked) screenshot become one JSON payload, sealed on this PC
// for the team's public key (seal.ts) and dropped into the write-only mailbox (drop.ts). Everything is private now:
// the old public GitHub path is gone and `visibility` is ignored.
// The outbox (kv `feedback-submissions`) holds only the sealed envelope, its request id and where it goes – never the
// text or the screenshot – and is written before any network I/O, so a retry after a lost answer sends the identical
// letter under the same id. After delivery only the receipt stays (the envelope is dropped).
// Owns: the complete payload, its size check, the outbox and the report's delivered state.
// Never: drops an attached screenshot, sends plaintext, resends an older (GitHub or receiver) submission,
// or claims delivery before the mailbox answered.

import { randomUUID } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import type { FeedbackKind, FeedbackReport } from '../../shared/model/system.ts';
import { FEEDBACK_IMAGE_TYPES, FEEDBACK_SEALED_LIMIT, SCREENSHOT_DROPPED, type FeedbackImageType } from '../../shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { redactText } from './redact.ts';
import { sealReport } from './seal.ts';
import { dropSealed, NOT_SET_UP } from './drop.ts';
import type { ReceiverConfig } from './receiver.ts';

export const OUTBOX = 'feedback-submissions';

/** What the team opens (inbox.ts checks it again – a letter is untrusted input). */
export interface FeedbackPayload {
  v: 1;
  id: string;
  createdAt: number;
  kind?: FeedbackKind;
  text: string;
  appVersion: string;
  os: string;
  view?: string;
  /** Filed by an agent of the sender (unverified). */
  fromAgent?: true;
  screenshot?: { mime: FeedbackImageType; base64: string };
  diagnostics?: string;
}

/** One outbox entry: ciphertext and routing only. `sealed` is gone once `deliveredAt` is set. */
export interface OutboxEntry {
  v: 1;
  requestId: string;
  project: string;
  recipient: string;
  sealed?: string;
  warning?: string;
  deliveredAt?: number;
}

const OLDER = 'This older submission cannot be sent again. Its original delivery stands.';
const SCREENSHOT_TOO_LARGE = 'The screenshot is too large to send. Your complete report is saved on this PC; use a smaller screenshot.';

async function screenshotOf(s: RuntimeServices, report: FeedbackReport): Promise<FeedbackPayload['screenshot'] | undefined> {
  const imageId = report.annotationFileId ?? report.screenshotFileId;
  if (!imageId) return undefined;
  const file = s.files.get(imageId);
  if (!file || !(FEEDBACK_IMAGE_TYPES as readonly string[]).includes(file.mime)) throw new WorkforceError('bad_request', 'Choose a PNG, JPEG or WebP screenshot.');
  if (file.size > FEEDBACK_SEALED_LIMIT) throw new WorkforceError('bad_request', SCREENSHOT_TOO_LARGE); // not even read
  const bytes = await s.files.read(imageId);
  return { mime: file.mime as FeedbackImageType, base64: Buffer.from(bytes).toString('base64') };
}

/** The complete payload sealed for the receiver; an oversized attachment keeps the report local. */
async function sealFor(s: RuntimeServices, report: FeedbackReport, requestId: string, diagnostics: string | undefined, config: ReceiverConfig): Promise<Buffer> {
  const clean = (value: string) => redactText(s.secrets.redact(value)); // the vault may know more values than at create
  const payload: FeedbackPayload = {
    v: 1, id: requestId, createdAt: report.createdAt, kind: report.kind, text: clean(report.text),
    appVersion: clean(report.context.version).slice(0, 120), os: clean(report.context.os).slice(0, 120),
    ...(report.context.view ? { view: clean(report.context.view).slice(0, 120) } : {}),
    ...(report.author !== 'human' ? { fromAgent: true as const } : {}),
    ...(diagnostics ? { diagnostics: clean(diagnostics).slice(0, 12_000) } : {}),
  };
  const shot = await screenshotOf(s, report);
  if (shot) payload.screenshot = shot;
  const bytes = sealReport(config.publicKey, Buffer.from(JSON.stringify(payload), 'utf8'));
  if (bytes.length > FEEDBACK_SEALED_LIMIT) throw new WorkforceError('bad_request', shot ? SCREENSHOT_TOO_LARGE : 'This report is too large to send.');
  return bytes;
}

/** Refuses older submissions (B-034 receiver, B-035 GitHub, B-036 plaintext outbox); strips an old plaintext payload. */
function refuseOlder(s: RuntimeServices, kv: KvRepo, report: FeedbackReport): OutboxEntry | undefined {
  if (kv.get('feedback-delivery', report.id) || kv.get('feedback-github', report.id)) throw new WorkforceError('conflict', OLDER);
  const stored = kv.get<OutboxEntry | { payload?: unknown; receipt?: { state?: string } }>(OUTBOX, report.id);
  if (stored && (stored as OutboxEntry).v !== 1) {
    const state = (stored as { receipt?: { state?: string } }).receipt?.state;
    kv.set(OUTBOX, report.id, { v: 0, older: true, ...(state ? { state } : {}) }, s.clock.now()); // no plaintext stays behind
    throw new WorkforceError('conflict', OLDER);
  }
  if (!stored && report.receiptId) throw new WorkforceError('conflict', OLDER);
  return stored as OutboxEntry | undefined;
}

/** Seals (once) and drops report `report`; returns it as sent. */
export async function deliver(s: RuntimeServices, report: FeedbackReport, diagnostics: string | undefined, config: ReceiverConfig | undefined,
  run?: typeof fetch): Promise<FeedbackReport> {
  const kv = new KvRepo(s.db);
  let entry = refuseOlder(s, kv, report);
  if (!config) throw new WorkforceError('unavailable', NOT_SET_UP);
  if (!entry?.deliveredAt) {
    // An older build may already have uploaded its text-only envelope before losing the answer. A new id is
    // needed to include the screenshot; do not turn that earlier attempt into a successful complete delivery.
    if (entry?.warning === SCREENSHOT_DROPPED) throw new WorkforceError('conflict', 'This earlier submission omitted its screenshot. Create a new report to send the screenshot.');
    // A new receiver (another project or a rotated key) gets a new letter under the same id; an identical retry resends the same bytes.
    if (!entry?.sealed || entry.project !== config.project || entry.recipient !== config.publicKey) {
      const requestId = entry?.requestId ?? randomUUID();
      const sealed = await sealFor(s, report, requestId, diagnostics, config);
      entry = { v: 1, requestId, project: config.project, recipient: config.publicKey, sealed: sealed.toString('base64') };
      kv.set(OUTBOX, report.id, entry, s.clock.now()); // before external I/O
    }
    await dropSealed(config, entry.requestId, Buffer.from(entry.sealed!, 'base64'), run);
    const receipt: OutboxEntry = { ...entry, deliveredAt: s.clock.now() };
    delete receipt.sealed; // delivered: only the receipt stays
    entry = receipt;
    kv.set(OUTBOX, report.id, entry, s.clock.now());
  }
  const sent: FeedbackReport = { ...report, status: 'sent', receiptId: entry.requestId, visibility: 'private', sentAt: entry.deliveredAt };
  delete sent.url;
  if (entry.warning) sent.deliveryWarning = entry.warning; else delete sent.deliveryWarning;
  return sent;
}
