// Text of attached files for the agent's input (≤ 8000 chars per file): text/PDF content, Word,
// Excel and PowerPoint documents (wave 2, extracted like PDFs) and transcripts of recordings
// (audio/video, addition MM1).
// Owns: a small in-memory cache, the synchronous lookup used by delta() (cached text in the
// files row, else a bounded sync read for text files – one whose bytes are not here goes the async way) and the async
// prepare() that brings the bytes of a file uploaded on another of the person's PCs here (devices/sync/blobs.ts
// needBlob: images and recordings too), extracts PDFs and transcribes recordings ahead of a turn. A PDF that was never extracted (or a
// recording never transcribed) starts in the background (delta() then keeps that message
// unseen so its text arrives with the next turn); a failure is remembered ("nothing readable",
// or the reason a recording has no transcript) so it never retries in a loop – except a busy decoder
// (conflict: several recordings at once), tried again by a turn after BUSY_RETRY_MS. Recordings are
// transcribed only while speech to text is set up and not turned off, and (B-058 T2) when the app
// can hear them – hear-any.ts hearable(): any format the desktop app decodes (voice messages,
// mp3, m4a, ogg, a video's sound), judged by its length, never its container's bytes – or, on a
// host that decodes nothing, when a transcription service takes the file as it is (≤ 25 MB).
// B-078: a person's recording that media/dictation.ts transcribed into the message body is read as that text – the
// attachment only says so, and no turn transcribes it again (decided by the row's meta.dictation, so on every linked PC).
// Never: parses PDFs synchronously, reads more than 64 KB of a file here, transcribes itself
// (RuntimeServices.stt does, one at a time, and caches the redacted text) or caches unbounded.

import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import type { RuntimeServices, SpeechToText } from '../contracts.ts';
import { needBlob } from '../devices/sync/blobs.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { FileRepo } from '../store/files.ts';
import { isTextMime } from '../files/mime.ts';
import { officeKind } from '../files/office.ts';
import { audioExtension, MAX_AUDIO_BYTES } from '../voice/transcribe.ts';
import { hearable, hostDecodes } from '../media/hear-any.ts';
import { MediaRepo } from '../media/repo.ts';
import { dictated } from '../media/dictation.ts';

/** B-078: a dictation's recording – its transcript is the message's own text. */
export const DICTATED = 'dictation – its words are the message text';

export const FILE_TEXT_CHARS = 8000;
const SYNC_READ_BYTES = 64 * 1024;
const CACHE_ENTRIES = 48;
const TRANSCRIPT_MORE = 'media.transcribe returns the whole transcript';
/** B-058 review fix: a transcription refused only because the decoder was busy (conflict) is tried again after this. */
export const BUSY_RETRY_MS = 60_000;

export const NO_TRANSCRIPT = {
  missing: 'no transcript – speech to text is not set up',
  off: 'no transcript – speech to text is turned off',
  large: 'no transcript – the recording is over 25 MB, too long to transcribe; ask for a shorter take',
} as const;

/** What delta() can show for one attachment now. */
export interface AttachmentText {
  text?: string;
  /** Extraction or transcription is running; the message stays unseen until it is done. */
  pending: boolean;
  /** A recording without transcript: why (shown to the agent instead of the text). */
  note?: string;
}

function clip(text: string, more?: string): string {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  return clean.length > FILE_TEXT_CHARS ? `${clean.slice(0, FILE_TEXT_CHARS)}… (truncated${more ? `; ${more}` : ''})` : clean;
}

function extractable(mime: string): boolean {
  return isTextMime(mime) || mime === 'application/pdf' || officeKind(mime) !== undefined; // wave 2: .docx/.xlsx/.pptx like PDFs (files/office.ts)
}

/** Audio and video attachments: transcribed instead of extracted. */
export function isRecording(mime: string): boolean {
  const type = mime.split(';')[0].trim().toLowerCase();
  return type.startsWith('audio/') || type.startsWith('video/');
}

const now = (s: RuntimeServices) => (typeof s.clock?.now === 'function' ? s.clock.now() : Date.now()); // test fakes may have no clock

/** The user-safe reason of a failed transcription, as one short clause. */
function reasonOf(error: unknown): string {
  const message = error instanceof WorkforceError ? error.message.trim().replace(/\.$/, '') : '';
  return message ? `no transcript – ${message.charAt(0).toLowerCase()}${message.slice(1)}` : 'no transcript – the transcription failed';
}

export class AttachmentTexts {
  private readonly services: () => RuntimeServices;
  private readonly cache = new Map<string, string>(); // fileId → clipped text ('' = nothing readable)
  private readonly inflight = new Set<string>();
  private readonly hearing = new Map<string, Promise<void>>(); // fileId → running transcription
  private readonly failed = new Map<string, string>(); // fileId → why there is no transcript
  private readonly busyUntil = new Map<string, number>(); // fileId → when a failure for a busy decoder ends (then: transcribed again)

  constructor(services: () => RuntimeServices) {
    this.services = services;
  }

  /** Text for a file now, or `pending` while a background extraction/transcription runs. */
  text(file: Attachment): AttachmentText {
    if (isRecording(file.mime)) {
      const known = this.recording(file);
      if (known !== 'transcribe') return known;
      void this.hear(file.fileId);
      return { pending: true };
    }
    if (!extractable(file.mime)) return { pending: false };
    const known = this.cache.get(file.fileId);
    if (known !== undefined) return { text: known || undefined, pending: false };
    const s = this.services();
    let cached: string | undefined;
    try { cached = new FileRepo(s.db).cachedText(file.fileId); } catch { cached = undefined; }
    if (cached !== undefined) return { text: this.remember(file.fileId, cached) || undefined, pending: false };
    if (isTextMime(file.mime)) {
      const read = this.readSync(file.fileId);
      if (read !== undefined) return { text: this.remember(file.fileId, read) || undefined, pending: false };
    }
    this.extractInBackground(file.fileId);
    return { pending: true };
  }

  /** Brings the bytes of the given attachments here, extracts their text (PDFs included) and transcribes recordings so text() finds it. */
  async prepare(files: Attachment[]): Promise<void> {
    const s = this.services();
    for (const file of files) {
      const recording = isRecording(file.mime);
      if (recording && dictated(s.db, file.fileId)) continue; // its words are the message's body (synced with the row): no bytes needed
      try { if (!existsSync(s.files.path(file.fileId))) await needBlob(s, file.fileId); } catch { /* the read below finds what is missing */ }
      if (recording) {
        // A transcription another turn's delta started is awaited too, so this turn gets the text.
        if (this.hearing.has(file.fileId) || this.recording(file) === 'transcribe') await this.hear(file.fileId);
        continue;
      }
      if (!extractable(file.mime) || this.cache.has(file.fileId)) continue;
      try {
        const text = await s.files.text(file.fileId, FILE_TEXT_CHARS + 1);
        this.remember(file.fileId, text ?? '');
      } catch (error) {
        this.remember(file.fileId, ''); // failed = nothing readable (no PDF re-parse every turn)
        s.log.debug('attachment text extraction failed', { fileId: file.fileId, error: String(error) });
      }
    }
  }

  /** A recording's transcript or the reason it has none, or 'transcribe' when one should run now. */
  private recording(file: Attachment): AttachmentText | 'transcribe' {
    const s = this.services();
    if (dictated(s.db, file.fileId)) return { pending: false, note: DICTATED }; // B-078: its words are the message's own text
    const known = this.cache.get(file.fileId);
    if (known) return { text: known, pending: false };
    let cached: string | undefined;
    try { cached = new FileRepo(s.db).cachedText(file.fileId) || undefined; } catch { cached = undefined; }
    // Also a transcript media.transcribe made after an earlier failure here.
    if (cached) return { text: this.remember(file.fileId, cached, TRANSCRIPT_MORE), pending: false };
    if (this.hearing.has(file.fileId)) return { pending: true };
    const failed = this.failed.get(file.fileId);
    const busy = this.busyUntil.get(file.fileId);
    if (failed && !(busy !== undefined && now(s) >= busy)) return { pending: false, note: failed };
    if (failed) { this.failed.delete(file.fileId); this.busyUntil.delete(file.fileId); } // the decoder was busy: once more
    const unheard = this.unheard(file, s);
    if (unheard) return { pending: false, note: unheard };
    const stt: SpeechToText | undefined = s.stt; // test fakes may have none
    const state = stt ? stt.state() : 'missing';
    if (state !== 'ready') return { pending: false, note: NO_TRANSCRIPT[state] };
    return 'transcribe';
  }

  /**
   * Why a recording cannot be transcribed, or undefined: B-058 hearable() by the attachment's or the media
   * library's measured length (a long one is heard in part) – else, where the host decodes nothing, a format
   * a transcription service takes as it is, up to 25 MB.
   */
  private unheard(file: Attachment, s: RuntimeServices): string | undefined {
    let probed: number | undefined;
    try { probed = new MediaRepo(s.db).get(file.fileId)?.durationMs; } catch { probed = undefined; }
    const gate = hearable({ mime: file.mime, name: file.name, durationMs: file.durationMs ?? probed }, hostDecodes(s));
    if (gate.ok) return undefined;
    const asIs = audioExtension(file.mime, file.name) !== undefined;
    if (asIs && file.size <= MAX_AUDIO_BYTES) return undefined;
    if (asIs) return NO_TRANSCRIPT.large;
    const reason = gate.reason.trim().replace(/\.$/, '');
    return `no transcript – ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
  }

  /** Transcribes once through RuntimeServices.stt; a failure is remembered with its reason. */
  private hear(fileId: string): Promise<void> {
    const running = this.hearing.get(fileId);
    if (running) return running;
    const s = this.services();
    const job = Promise.resolve()
      .then(() => s.stt.transcript(fileId))
      .then((text) => { this.remember(fileId, text, TRANSCRIPT_MORE); })
      .catch((error: unknown) => {
        this.boundedSet(this.failed, fileId, reasonOf(error)); // never "pending" again for this file …
        // … unless only the decoder was busy (several recordings at once): a later turn tries again.
        if (error instanceof WorkforceError && error.code === 'conflict') this.busyUntil.set(fileId, now(s) + BUSY_RETRY_MS);
        else this.busyUntil.delete(fileId);
        s.log.debug('attachment transcription failed', { fileId, error: String(error) });
      })
      .finally(() => this.hearing.delete(fileId));
    this.hearing.set(fileId, job);
    return job;
  }

  /** Caches a file's text as the file has it. */
  private remember(fileId: string, text: string, more?: string): string {
    const value = clip(text, more);
    this.boundedSet(this.cache, fileId, value);
    return value;
  }

  /** Bounded insert: the oldest entry goes first. */
  private boundedSet(map: Map<string, string>, key: string, value: string): void {
    if (map.size >= CACHE_ENTRIES && !map.has(key)) map.delete(map.keys().next().value as string);
    map.set(key, value);
  }

  private readSync(fileId: string): string | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(this.services().files.path(fileId), 'r');
      const buffer = Buffer.alloc(SYNC_READ_BYTES);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      return new TextDecoder('utf-8').decode(buffer.subarray(0, bytes)).replace(/�+$/u, '');
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    }
  }

  private extractInBackground(fileId: string): void {
    if (this.inflight.has(fileId)) return;
    this.inflight.add(fileId);
    const s = this.services();
    void s.files.text(fileId, FILE_TEXT_CHARS + 1)
      .then((text) => { this.remember(fileId, text ?? ''); })
      .catch((error) => {
        this.remember(fileId, ''); // failed = nothing readable: never "pending" again
        s.log.debug('attachment text extraction failed', { fileId, error: String(error) });
      })
      .finally(() => this.inflight.delete(fileId));
  }
}
