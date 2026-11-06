// Dependencies of the RPC surface that are not part of RuntimeServices (they serve clients,
// not agents): phone/browser access, the linked PCs, feedback, onboarding, system/restart, live
// screen preview, transcription, model policies, legacy import, the media library, agent
// portability/backup, chat bridges and connecting PCs.
// The composition root (compose/network.ts) fills one RpcExtras object.
// Owns: the interface shapes only. Never: implementations.

import type { ClientScope } from '../../shared/api/protocol.ts';
import type { LocalSpeechModels, SpokenAudio } from '../../shared/model/local-speech-models.ts';
import type { Device, PushConfig, PwaState } from '../../shared/model/devices.ts';
import type { ModelPolicy } from '../../shared/model/providers.ts';
import type { FeedbackKind, FeedbackReport, FeedbackVisibility, FileRef, ResourceState, Settings, SystemInfo } from '../../shared/model/system.ts';
import type { HeardSegment, HeardWord } from '../../shared/api/methods-app.ts';
import type { CatalogStatus } from '../models/catalog.ts';
import type { MediaFilter, MediaInfo, MediaPatch } from '../../shared/model/media.ts';
import type { Bridge, ConnectTelegramInput } from '../../shared/model/bridges.ts';
import type { FeedbackImageType, FeedbackInboxFetch, FeedbackInboxItem, FeedbackSetupResult, FeedbackStatus } from '../../shared/model/feedback-delivery.ts';

export interface PwaApi {
  state(): Promise<PwaState>;
  enable(input: { enabled: boolean; bind?: Settings['pwa']['bind'] }): Promise<PwaState>;
  /** The phone QR code: a one-time link (10 minutes) the phone camera opens, and its 6-digit `code` for an installed app – one pairing with either, until `expiresAt`; `route` (#/…) opens after pairing. */
  link(input: { name?: string; route?: string }): Promise<{ url: string; qrDataUrl: string; expiresAt: number; code: string }>;
  /** Trades a one-time pairing secret or its link's 6-digit code for a device token (unauthenticated `POST /rpc`). */
  exchange(secret: string, input: { name?: string; kind?: 'phone' | 'browser' }): { token: string; deviceId: string };
  /** Token → device scope (undefined when unknown/revoked). */
  authenticate(token: string): ClientScope | undefined;
  /** True for the token of a removed phone/browser (closed with 4403, not 4401). */
  revoked?(token: string): boolean;
  revoke(deviceId: string): Promise<void>;
  pushSubscribe(subscription: unknown, scope?: ClientScope): void;
  /** Push readiness, the VAPID key and whether the caller's subscription is stored. */
  pushConfig(scope: ClientScope | undefined, endpoint?: string): Promise<PushConfig>;
  /** Removes only the caller's own subscription(s); returns how many. */
  pushUnsubscribe(scope: ClientScope | undefined, endpoint?: string): number;
}

export interface MeshApi {
  rename(id: string, name: string): Device;
  revoke(id: string): void;
}

export interface FeedbackApi {
  create(input: { kind: FeedbackKind; text: string; screenshotFileId?: string; annotationFileId?: string; view?: string; conversationId?: string; author: string }): FeedbackReport;
  list(): FeedbackReport[];
  /**
   * B-055: seals the report for the team and drops it into the write-only mailbox after an explicit user action;
   * no browser or file manager opens. `reveal` and `visibility` are accepted only for older callers and ignored.
   */
  send(id: string, options?: { reveal?: boolean; visibility?: FeedbackVisibility }): Promise<FeedbackReport>;
  /** Hides a report that was not sent (e.g. an agent report the person does not want to send). */
  dismiss(id: string): FeedbackReport;
  /** Whether this build can send at all (a receiver is shipped) and whether this PC holds the team key; optional for simple fakes. */
  status?(): FeedbackStatus;
  /** B-055: the team inbox on the PC holding the team key (owner only; runtime/feedback/inbox.ts); optional for simple fakes. */
  inbox?: {
    list(): FeedbackInboxItem[];
    fetch(): Promise<FeedbackInboxFetch>;
    remove(id: string): { ok: true };
    screenshot(id: string): { mime: FeedbackImageType; dataBase64: string };
  };
  /** B-055: wf feedback setup (owner only; runtime/feedback/setup.ts). */
  setup?(input: { project: string; apiKey: string; serviceAccountPath: string; rotate?: boolean }): Promise<FeedbackSetupResult>;
}

export interface OnboardingApi {
  /** Owner, "Set up team again": onboarding is open again at step 'ai' – the first-run layer and the onboarding skill return. */
  reset(): void;
  /** B-044: the first-run cards are through – step 'done' and the app's start text as the person's line in the Manager's first chat. */
  start(): { conversationId: string };
}

export interface SystemApi {
  info(): SystemInfo;
  resources(): ResourceState;
  /** May the app restart for an update now without losing work? */
  restartReadiness(): { ready: boolean; reasons: string[] };
  /** Pause new wakes, checkpoint runs, flush WAL (cancel resumes). */
  prepareRestart(cancel?: boolean): Promise<void>;
}

export interface ComputerPreviewApi {
  preview(input: { deviceId?: string; display?: number }): Promise<{ dataUrl: string; width: number; height: number; at: number }>;
}

export interface VoiceApi {
  /** The text (a local model also gives segment and word times). */
  transcribe(input: { fileId: string; language?: string }): Promise<{ text: string; segments?: HeardSegment[]; words?: HeardWord[] }>;
  /** Local speech (voice/local/service.ts through the Transcriber). */
  localModels(): LocalSpeechModels;
  pullLocal(id: string): Promise<{ ok: true }>;
  speak(input: { text: string; voice?: string; language?: string }): Promise<SpokenAudio>;
}

export interface PolicyApi {
  /** Stored policy at a scope: agent, chat+agent (sticky composer choice) or global default. */
  get(scope: { agentId?: string; conversationId?: string }): ModelPolicy | null;
  set(scope: { agentId?: string; conversationId?: string }, policy: ModelPolicy): void;
}

// ------------------------------------------------------------------ added by R4 contracts

/** Media library (src/runtime/media/service.ts MediaService). */
export interface MediaApi {
  list(filter: MediaFilter): MediaInfo[];
  /** `by` = 'human' (RPC) or an agent id (tools). */
  describe(fileId: string, patch: MediaPatch, by: string): MediaInfo;
  get(fileId: string): MediaInfo | undefined;
}

/** Agent export, whole-installation backup/restore (src/runtime/portability). */
export interface PortabilityApi {
  exportAgent(id: string, opts: { includeKnowledge?: boolean }): Promise<FileRef>;
  backup(dir?: string): Promise<{ path: string; bytes: number }>;
  restore(path: string): Promise<{ ok: true; restartRequired: true }>;
}

/** Chat bridges to external messengers (src/runtime/bridges/service.ts Bridges). */
export interface BridgesApi {
  list(conversationId?: string): Bridge[];
  connectTelegram(input: ConnectTelegramInput): Promise<Bridge>;
  disconnect(id: string): void;
}

export interface RpcExtras {
  media: MediaApi;
  portability: PortabilityApi;
  bridges: BridgesApi;
  pwa: PwaApi;
  mesh: MeshApi;
  feedback: FeedbackApi;
  onboarding: OnboardingApi;
  system: SystemApi;
  computer: ComputerPreviewApi;
  voice: VoiceApi;
  policies: PolicyApi;
  importLegacy(path?: string): Promise<{ agents: number; chats: number; messages: number }>;
  catalogRefresh(): Promise<{ models: number; fetchedAt?: number }>;
  /** Catalog size, available models and the last full refresh. */
  catalogStatus(): CatalogStatus;
}

/** Connecting PCs (Settings › Devices): runtime/remote/service.ts. */
export interface RemoteApi {
  state(): import('../../shared/model/remote.ts').RemoteState;
  connect(input: { target: string; role?: import('../../shared/model/remote.ts').JoinRole }): Promise<import('../../shared/model/remote.ts').RemoteOutgoing>;
  cancel(): void;
  decide(id: string, accept: boolean, personId?: string): void;
  /** PCs on this network that accept requests; `refresh` asks the network again. */
  nearby(refresh: boolean): Promise<import('../../shared/model/remote.ts').NearbyPc[]>;
}

export interface RpcExtras {
  /** Remote (merged into RpcExtras above): absent until the composition root wires it – remote.* then answer 'unavailable'. */
  remote?: RemoteApi;
}

/** The meeting server (devices/rendezvous/service.ts): its state for Settings › Devices. */
export interface RelayApi {
  state(): import('../../shared/model/relay.ts').RelayState;
}

export interface RpcExtras {
  /** The meeting server (merged into RpcExtras above): absent until wired – remote.relay then answers 'unavailable'. */
  relay?: RelayApi;
}
