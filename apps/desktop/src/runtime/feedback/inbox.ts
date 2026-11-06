// The team inbox (B-055 Q2/Q3) on the one PC whose vault holds the team's private key: a fetch lists the mailbox,
// opens each letter (seal.ts), stores it as <data>/feedback-inbox/<id>.json (+ <id>.png|jpg|webp) and only then
// deletes the letter in the mailbox – feedback ends up only with the team. No new table: plain files.
// A fetch runs once at app start (receiving PCs only), when the inbox opens (Settings › Feedback › Inbox) and on Refresh / wf feedback
// receive – never on a timer. A letter this key cannot open (an earlier key, damaged) is kept as it came under
// unreadable/ and counted, so it never blocks the mailbox; ids no sender of ours makes are left alone.
// Owns: the fetch order (open → write → delete), checking each opened letter (untrusted input), the local files.
// Never: deletes a letter before its file is written, logs a key, a token or a letter's text, or polls.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { FeedbackKind } from '../../shared/model/system.ts';
import { FEEDBACK_IMAGE_TYPES, type FeedbackImageType, type FeedbackInboxFetch, type FeedbackInboxItem } from '../../shared/model/feedback-delivery.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { DOCUMENT_ID } from './drop.ts';
import { Mailbox, parseServiceAccount } from './google.ts';
import { readReceiver } from './receiver.ts';
import { openReport } from './seal.ts';
import { TOKEN_URL } from './transport.ts';

export const RECEIVER_KEY_ID = 'feedback-receiver-key';
export const SERVICE_ACCOUNT_ID = 'feedback-service-account';
export const INBOX_DIR = 'feedback-inbox';
/** Letters this PC's key cannot open, kept as they came (<data>/feedback-inbox/unreadable/<id>.wfb). */
export const UNREADABLE_DIR = 'unreadable';
/** kv feedback/receiver: { project, publicKey, apiKey } of the last `wf feedback setup` (public values only). */
export const SETUP_KEY = { ns: 'feedback', key: 'receiver' } as const;
/** Letters one fetch takes at most (the mailbox is writable by anyone with the build: a flood must not stall the PC). */
export const MAX_PER_FETCH = 200;
const LIST_MAX = 500;
const KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];
const EXT: Record<FeedbackImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface InboxDeps {
  services: () => RuntimeServices;
  fetch?: typeof fetch;
  /** Tests: Google's endpoints. Default: the receiver's loopback `endpoint` (tests) or Google. */
  firestore?: string;
  tokenUrl?: string;
}

/** The image really is what its type says (a letter is untrusted). */
function imageMatches(mime: FeedbackImageType, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

const str = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined);

/** An opened letter as an inbox item, its screenshot apart; undefined when it is no v1 report. */
export function itemOf(id: string, value: unknown, receivedAt: number): { item: FeedbackInboxItem; image?: Buffer } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const text = str(o.text, 20_000);
  if (o.v !== 1 || !text) return undefined;
  const item: FeedbackInboxItem = {
    id, receivedAt, text,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : receivedAt,
    appVersion: str(o.appVersion, 120) ?? '', os: str(o.os, 120) ?? '',
  };
  if (KINDS.includes(o.kind as FeedbackKind)) item.kind = o.kind as FeedbackKind;
  const view = str(o.view, 120);
  if (view) item.view = view;
  if (o.fromAgent === true) item.fromAgent = true;
  const diagnostics = str(o.diagnostics, 12_000);
  if (diagnostics) item.diagnostics = diagnostics;
  const shot = o.screenshot as { mime?: unknown; base64?: unknown } | undefined;
  if (shot && (FEEDBACK_IMAGE_TYPES as readonly unknown[]).includes(shot.mime) && typeof shot.base64 === 'string') {
    const image = Buffer.from(shot.base64, 'base64');
    if (image.length && imageMatches(shot.mime as FeedbackImageType, image)) {
      item.screenshot = { mime: shot.mime as FeedbackImageType, size: image.length };
      return { item, image };
    }
  }
  return { item };
}

function writeAtomic(file: string, data: string | Buffer): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, file);
}

function checkId(id: string): string {
  if (!DOCUMENT_ID.test(id)) throw new WorkforceError('bad_request', 'Invalid report id.');
  return id;
}

export class FeedbackInbox {
  private readonly deps: InboxDeps;
  private running: Promise<FeedbackInboxFetch> | undefined;

  constructor(deps: InboxDeps) {
    this.deps = deps;
  }

  /** This PC holds the team's private key (the vault's entry; its value is not read here). */
  receiving(): boolean {
    try { return this.deps.services().secrets.list().some((entry) => entry.id === RECEIVER_KEY_ID); } catch { return false; }
  }

  dir(): string {
    return path.join(this.deps.services().paths.data, INBOX_DIR);
  }

  /** The stored reports, newest first. */
  list(): FeedbackInboxItem[] {
    let names: string[];
    try { names = readdirSync(this.dir()); } catch { return []; }
    const items: FeedbackInboxItem[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!DOCUMENT_ID.test(id)) continue;
      const item = this.read(id);
      if (item) items.push(item);
    }
    return items.sort((a, b) => b.receivedAt - a.receivedAt || b.createdAt - a.createdAt).slice(0, LIST_MAX);
  }

  private read(id: string): FeedbackInboxItem | undefined {
    try {
      const item = JSON.parse(readFileSync(path.join(this.dir(), `${id}.json`), 'utf8')) as FeedbackInboxItem;
      return item && item.id === id && typeof item.text === 'string' ? item : undefined;
    } catch {
      return undefined;
    }
  }

  screenshot(id: string): { mime: FeedbackImageType; dataBase64: string } {
    const item = this.read(checkId(id));
    if (!item?.screenshot) throw new WorkforceError('not_found', 'This report has no screenshot.');
    try {
      return { mime: item.screenshot.mime, dataBase64: readFileSync(path.join(this.dir(), `${id}.${EXT[item.screenshot.mime]}`)).toString('base64') };
    } catch {
      throw new WorkforceError('not_found', 'This report has no screenshot.');
    }
  }

  /** Deletes a stored report and its screenshot on this PC. */
  remove(id: string): { ok: true } {
    checkId(id);
    for (const ext of ['json', ...Object.values(EXT)]) rmSync(path.join(this.dir(), `${id}.${ext}`), { force: true });
    return { ok: true };
  }

  /** Fetches now; a second call while one runs shares it. */
  fetch(): Promise<FeedbackInboxFetch> {
    this.running ??= this.fetchOnce().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async mailbox(s: RuntimeServices): Promise<{ mailbox: Mailbox; privateKey: string }> {
    if (!this.receiving()) throw new WorkforceError('not_found', 'This PC has no team key for feedback. Run wf feedback setup first.');
    const privateKey = await s.secrets.use(RECEIVER_KEY_ID, SYSTEM_ID);
    let accountText: string;
    try { accountText = await s.secrets.use(SERVICE_ACCOUNT_ID, SYSTEM_ID); } catch {
      throw new WorkforceError('not_found', 'The feedback service account is missing. Run wf feedback setup again.');
    }
    const account = parseServiceAccount(accountText);
    const receiver = readReceiver(s);
    const project = new KvRepo(s.db).get<{ project?: string }>(SETUP_KEY.ns, SETUP_KEY.key)?.project ?? receiver?.project ?? account.project_id;
    if (!project) throw new WorkforceError('not_found', 'The feedback project is unknown. Run wf feedback setup again.');
    const firestore = this.deps.firestore ?? receiver?.endpoint;
    const tokenUrl = this.deps.tokenUrl ?? (receiver?.endpoint ? `${receiver.endpoint}/token` : TOKEN_URL);
    return { mailbox: new Mailbox(account, { project, firestore, tokenUrl, fetch: this.deps.fetch ?? fetch, now: () => s.clock.now() }), privateKey };
  }

  private async fetchOnce(): Promise<FeedbackInboxFetch> {
    const s = this.deps.services();
    const { mailbox, privateKey } = await this.mailbox(s);
    const dir = this.dir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let added = 0;
    let unreadable = 0;
    let taken = 0;
    let more = false;
    let pageToken: string | undefined;
    do {
      const page = await mailbox.page(pageToken);
      for (const id of page.ids) {
        if (!DOCUMENT_ID.test(id)) { unreadable += 1; continue; } // never one of ours (senders use UUIDs): left alone
        if (taken >= MAX_PER_FETCH) { more = true; break; }
        taken += 1;
        if (existsSync(path.join(dir, `${id}.json`))) { await mailbox.remove(id); continue; } // stored before, the delete did not finish
        const sealed = await mailbox.sealed(id);
        if (!sealed) { unreadable += 1; continue; }
        let opened: ReturnType<typeof itemOf>;
        try { opened = itemOf(id, JSON.parse(openReport(privateKey, sealed).toString('utf8')), s.clock.now()); } catch { opened = undefined; }
        if (!opened) {
          // Sealed for another (an earlier) key or damaged: kept on this PC as it came, so it never blocks the mailbox.
          mkdirSync(path.join(dir, UNREADABLE_DIR), { recursive: true, mode: 0o700 });
          writeAtomic(path.join(dir, UNREADABLE_DIR, `${id}.wfb`), sealed);
          await mailbox.remove(id);
          unreadable += 1;
          continue;
        }
        if (opened.image && opened.item.screenshot) writeAtomic(path.join(dir, `${id}.${EXT[opened.item.screenshot.mime]}`), opened.image);
        writeAtomic(path.join(dir, `${id}.json`), `${JSON.stringify(opened.item, null, 2)}\n`);
        await mailbox.remove(id); // only now: the report is on this PC
        added += 1;
      }
      pageToken = more ? undefined : page.next;
    } while (pageToken);
    const total = this.list().length;
    s.log.info('feedback inbox fetched', { added, unreadable, more }); // counts only
    return { added, unreadable, more, total };
  }
}
