// Owns: what a client may know about feedback delivery – whether this build can send (`feedback.status`), the team
// inbox on the one PC that holds the team's private key (B-055 Q1–Q3) and `wf feedback setup`'s answer.
// Never: keys, the service account, the sealed bytes or any read API of the mailbox (it is write-only).
import type { FeedbackKind } from './system.ts';

/** The largest sealed envelope sent to the mailbox (its Firestore rule allows < 1,000,000 bytes). */
export const FEEDBACK_SEALED_LIMIT = 950_000;
/** A report's `deliveryWarning` when the sealed report with its screenshot was too large. */
export const SCREENSHOT_DROPPED = 'The screenshot was too large and was not sent.';
/** Screenshot types a report may carry (never SVG or anything a browser would run). */
export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type FeedbackImageType = typeof FEEDBACK_IMAGE_TYPES[number];

/**
 * `feedback.status`: `sending` – this build has a receiver (resources/feedback/receiver.json: the team's public key
 * and the mailbox); without one a report is only saved on this PC and the UI says so. `receiving` – this PC holds the
 * team's private key (the vault), so Settings › Feedback shows the team inbox; always false for anyone but the owner.
 */
export interface FeedbackStatus {
  sending: boolean;
  receiving: boolean;
}

/** One report from the team inbox (<data>/feedback-inbox/<id>.json), opened on this PC. Untrusted text. */
export interface FeedbackInboxItem {
  id: string;
  /** When this PC fetched it. */
  receivedAt: number;
  /** When the sender wrote it (the sender's clock). */
  createdAt: number;
  kind?: FeedbackKind;
  text: string;
  appVersion: string;
  os: string;
  view?: string;
  /** Filed by one of the sender's agents (unverified), not by the person. */
  fromAgent?: boolean;
  diagnostics?: string;
  screenshot?: { mime: FeedbackImageType; size: number };
}

/** What one fetch did: `added` new reports, `unreadable` letters this PC's key cannot open (left in the mailbox). */
export interface FeedbackInboxFetch {
  added: number;
  unreadable: number;
  /** More letters wait than one fetch takes (fetch again). */
  more: boolean;
  /** Reports in this PC's inbox after the fetch. */
  total: number;
}

/** `feedback.setup` (wf feedback setup): what was stored and what the owner does next. */
export interface FeedbackSetupResult {
  publicKey: string;
  project: string;
  /** A new key pair was made (first setup or --rotate); false: the vault's key was kept. */
  createdKey: boolean;
  /** Where receiver.json was written; absent when the app runs from a package (write it into the source tree). */
  receiverFile?: string;
  /** receiver.json's content (public: the team's public key, the project and its web API key). */
  receiver: { publicKey: string; project: string; apiKey: string };
  /** The Firestore rules to paste (resources/feedback/firestore.rules). */
  rules: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** 'chat' devices too (they may create and send reports): whether sending is set up in this build. */
    'feedback.status': { params: void; result: FeedbackStatus };
    // B-055, owner only: the team inbox on the PC holding the team's private key.
    'feedback.inboxList': { params: void; result: FeedbackInboxItem[] };
    /** Fetches the mailbox now (opened, stored on this PC, then deleted in the mailbox). */
    'feedback.inboxFetch': { params: void; result: FeedbackInboxFetch };
    'feedback.inboxRemove': { params: { id: string }; result: { ok: true } };
    'feedback.inboxScreenshot': { params: { id: string }; result: { mime: FeedbackImageType; dataBase64: string } };
    /** wf feedback setup: keys into the vault, receiver.json, the rules to paste. */
    'feedback.setup': { params: { project: string; apiKey: string; serviceAccountPath: string; rotate?: boolean }; result: FeedbackSetupResult };
  }
}
