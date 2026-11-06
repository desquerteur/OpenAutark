// System model: settings, profile, files, feedback, updates, health, the data root.
// Owns: shapes of app-wide configuration and housekeeping data.
// Never: secrets (they live in the secret store and are referenced by id).

import type { ProviderEntry } from './provider-entries.ts';

export interface Profile {
  name: string; // the person (CEO)
  company: string; // legal/company name (optional master data)
  avatarFileId?: string;
  language: string; // UI/agent default language, e.g. 'de' or 'en' (B-078: starts as the PC's, the AI sets it when the person speaks another)
  timezone: string; // IANA, default OS zone
  /** B-078 (D17): the AI's own note on how the person wants to be spoken to (≤ 600 characters; the stable prompt's "My environment"). */
  notes?: string;
}

/** B-078 (D13): the public skill library (runtime/knowledge, track T3). */
export interface LibrarySettings {
  /** Skills worth sharing go to the public library as a pull request with the person's own GitHub sign-in (default on). */
  publish: boolean;
}

export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  sidebarOpen: boolean;
  sidebarWidth: number; // 200..420
  workspaceOpen: boolean; // global right pane
  workspaceWidth: number;
  enterSends: boolean;
  closeToTray: boolean; // window close keeps agents running (default true)
  openAtLogin: boolean;
  autoDownloadUpdates: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  quietHours?: { from: string; to: string };
  /** What may interrupt: human to-dos, blockers, important messages (always quiet otherwise). */
  pushFor: Array<'todo' | 'blocker' | 'important' | 'done' | 'reply'>;
}

/** Voice (skill app-settings explains every key). Hearing: this PC's model → a transcription service → the free listening model. */
export interface VoiceSettings {
  ttsVoice?: string;
  /** Names and terms the recognizer should know (≤ 1000, each ≤ 120 characters); old {term} objects read as their term. */
  vocabulary: string[];
  /** 'auto': a chat's voice mode uses Realtime voice when an OpenAI or Google key offers it; 'off': this PC's speech. Default 'off' (it bills per minute). */
  realtime: 'auto' | 'off';
  /** A call without a real-time model: the Decisions model answers at once while the agent works (runtime/calls/talker.ts). false: the agent answers every line. Default on. */
  talker?: boolean;
  /** The local speech-to-text model (shared/model/local-speech-models.ts id; '' or unset = none). */
  localStt?: string;
  /** The local text-to-speech voice model (same catalog; '' or unset = none – speechSynthesis reads). */
  localTts?: string;
}

/**
 * settings.json "Models": which model each use takes (shared/model/models-uses.ts – 'auto', a model id
 * '<provider>:<model>', for work also a plan's provider id, for the media uses also 'off'), how 'auto' picks and
 * whether pay-per-use keys may take over.
 */
export interface RoutingSettings {
  work: string;
  decision: string;
  voice: string;
  stt: string;
  tts: string;
  image: string;
  video: string;
  music: string;
  sound: string;
  embeddings: string;
  costMode: 'economy' | 'balanced' | 'best';
  allowPaidFallback: boolean; // may spill over to pay-per-use API keys
}

/**
 * The first run (ui/onboarding): the tour, the AI card, then About you; 'done' once it is through. A stored 'team'
 * or 'voice' (older cards) reads as 'about'. "Set up team again" starts at 'ai'.
 */
export type OnboardingStep = 'tour' | 'ai' | 'about' | 'done';
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['tour', 'ai', 'about', 'done'];

export interface Settings {
  profile: Profile;
  preferences: Preferences;
  notifications: NotificationSettings;
  voice: VoiceSettings;
  routing: RoutingSettings;
  /**
   * `step`: the first-run layer's card – 'done' once it is through (installs finished before it existed read
   * 'done', migration 69); `completed`: the Manager finished the setup interview.
   */
  onboarding: { completed: boolean; step: OnboardingStep };
  /**
   * Where reports go is the team's receiver shipped with the build (resources/feedback/receiver.json, B-055), never a
   * setting: the old repo/privateRepo/endpoint values were removed (migration 55, 23.10.2026).
   */
  feedback: { includeDiagnostics: boolean };
  pwa: { enabled: boolean; bind: 'localhost' | 'lan' | 'tailscale' };
  devices: DeviceSettings;
  /** B-078: the public skill library; absent in settings read before it existed (then publish counts as on). */
  library?: LibrarySettings;
  /** The API connections, by id (shared/model/provider-entries.ts); absent while there are none. */
  providers?: Record<string, ProviderEntry>;
}

/** Linked PCs: the dedicated peer listener other PCs reach this PC on (runtime/http/peer-server.ts). */
export interface DeviceSettings {
  /** 'lan' every interface, 'tailscale' only this PC's tailnet addresses, 'off' never opens. */
  peer: 'lan' | 'tailscale' | 'off';
  /** Port of the peer listener (another free port when it is taken). */
  peerPort: number;
  /**
   * Remote: other PCs find this PC by its Remote ID or name and may ask to connect (the person
   * accepts each request); keeps the peer listener open. Absent = on (older settings files).
   */
  findable?: boolean;
  /**
   * The meeting server (wss://…, shared/model/relay.ts relayAddress) linked PCs in other networks find
   * each other at. Absent = Autark's own (DEFAULT_RELAY); empty = off.
   */
  relay?: string;
}

/** Partial deep update accepted by settings.update. */
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

export interface FileRef {
  id: string; // sha256
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  textPreview?: string; // extracted text head (pdf/text)
  width?: number;
  height?: number;
  durationMs?: number;
}

export type FeedbackKind = 'bug' | 'idea' | 'change' | 'praise';
export type FeedbackVisibility = 'public' | 'private';

export interface FeedbackReport {
  id: string;
  kind: FeedbackKind;
  text: string;
  author: string; // 'human' or agent id (agent reports are untrusted)
  screenshotFileId?: string;
  annotationFileId?: string;
  /** `runId`: agent reports only – the run that filed the report. */
  context: { view?: string; conversationId?: string; version: string; os: string; runId?: string };
  /**
   * B-055: 'sent' = the sealed report is in the team's mailbox (only the team can open it). Older states stay
   * readable: queued = an older browser draft, received = an older receiver's receipt with GitHub pending.
   */
  status: 'draft' | 'queued' | 'sent' | 'received' | 'local' | 'dismissed';
  url?: string; // older reports only: a created GitHub issue / prefilled url
  createdAt: number;
  sentAt?: number;
  /** The mailbox document id of the sealed report (older reports: the receiver's receipt). */
  receiptId?: string;
  /** B-055: every report is sent 'private' (sealed for the team); 'public' only on older GitHub reports. */
  visibility?: FeedbackVisibility;
  /** The report arrived, but without something it had (B-055: "The screenshot was too large and was not sent."). */
  deliveryWarning?: string;
  /** Agent reports: how often the same text was reported within 24 h (absent = once). */
  count?: number;
}

export interface UpdateState {
  status: 'development' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'current' | 'error';
  version: string;
  availableVersion?: string;
  percent: number;
  restartAt?: number;
  message?: string;
  /** Failed update step; background check failures need no global retry control. */
  failure?: 'check' | 'download' | 'open' | 'restart';
  automaticInstall: boolean;
  downloadURL?: string;
}

export interface SystemInfo {
  version: string;
  platform: string;
  arch: string;
  dataDir: string;
  deviceId: string;
  deviceName: string;
  packaged: boolean;
  startedAt: number;
  /** Whether linked PCs can reach this PC right now (Settings › Devices shows it). */
  peer?: PeerListenerState;
  /** RC1: what this start did after an update or a crash ("Updated to X · N tasks continued"), shown once. */
  notice?: { id: string; text: string; at: number };
}

/** The dedicated peer listener: open while a pairing is in flight or a PC is linked. */
export interface PeerListenerState {
  /** 'closed' until a PC is linked or a pairing is open; 'error' when it could not listen. */
  status: 'open' | 'closed' | 'off' | 'error';
  mode: DeviceSettings['peer'];
  /** Port it listens on (while open). */
  port?: number;
  /** Base URLs other PCs dial (http://<ip>:<port>), tailnet first; empty unless open. */
  addresses: string[];
  /** Why it could not listen: a socket error code (EADDRINUSE, EACCES …) or NO_TAILNET. */
  error?: string;
}

export interface ResourceState {
  freeMemoryMb: number;
  totalMemoryMb: number;
  cpuCount: number;
  heavySlots: number; // admitted heavy agent processes right now
  heavyInUse: number;
  queued: number; // wakes waiting for capacity
  processes: Array<{ kind: string; pid: number; accountId?: string; idleMs: number }>;
  /** Added by MM9: the runtime process itself. */
  runtime?: RuntimeUsage;
}

/** Added by MM9: memory and CPU of the runtime process, and its resident knowledge vector index. */
export interface RuntimeUsage {
  pid: number;
  rssMb: number;
  heapUsedMb: number;
  /** CPU time (user + system) since the process started. */
  cpuMs: number;
  uptimeMs: number;
  /** CPU share of one core since the previous system.resources read (or since start), in percent. */
  cpuPercent: number;
  /** Resident vector index worker threads (0 after 10 idle minutes) and their vector memory. */
  vectorWorkers: number;
  vectorIndexMb: number;
}

/** B-044 open file system: the one documented data route `<data>` (Electron userData or WORKFORCE_TEST_DATA). */
export interface RootInfo {
  /** Absolute path of `<data>`. */
  path: string;
  /** Absolute path of the workspace (projects, shared skills). */
  workspace: string;
  /** Absolute path of the generated map `<data>/README.md` (every folder, who writes it, what it does). */
  readme: string;
  /** Quiet notices of the folder's files right now (e.g. a section of settings.json that was not used); absent = none. */
  notices?: string[];
}

declare module '../api/methods.ts' {
  interface Methods {
    /** B-044 (OPEN-FS), owner: where `<data>` and its map are (Settings › About "Autark folder"). */
    'system.root': { params: void; result: RootInfo };
  }
}
