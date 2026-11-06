// Security model: stored secrets (metadata only) and the spend journal's entries.
// Owns: the shapes the vault, the RPC and the UI share. Never: contains secret values.

export interface SpendEntry {
  id: string;
  agentId: string;
  amount: number;
  currency: string;
  kind: 'tokens' | 'purchase' | 'subscription' | 'ads' | 'other';
  ref?: string;
  createdAt: number;
}

export interface SecretInfo {
  id: string;
  /** Its purpose – what it is for, when to use it (B-044: the body of <data>/secrets/<id>.md); never the value, never a permission. */
  description?: string;
  /** Chat in which the human captured this secret. */
  conversationId?: string;
  label: string; // "Company Visa", "YouTube login"
  kind: 'api_key' | 'password' | 'card' | 'token' | 'note' | 'totp' | 'text'; // X05: totp = a 2FA setup key (fills the current code), text = a group's non-secret part
  hint?: string; // e.g. last 4 digits
  /** 29.10.2026: the site it was saved from ("Saved from example.com") – provenance only, never a restriction; X05: a group's field shows the GROUP's. */
  source?: string;
  /** Owner 29.10.2026 (a catalog like a skill): the route (area) whose file <data>/secrets/<route>.md lists it – always set by the vault (optional for simple fakes); X05: a group's field shows the GROUP's. */
  route?: string;
  /** Usage tags written by the AI or the person ("for the web at example.com") – information only, never a restriction; X05: the GROUP's. */
  tags?: string[];
  createdAt: number;
  lastUsedAt?: number;
  /** X05: the group this field belongs to (a login or card); absent for a single secret. */
  group?: SecretGroupRef;
  /** X05: the field's name in its group ("username", "password", "totp", "number" …). */
  field?: string;
  /** X05: the agent that created this secret (secrets.generate, browser.save_secret); absent for the person's. */
  createdBy?: string;
  /** B-075: the app itself works with it (an account's key, a bridge, a calendar – secrets/units.ts heldByApp); set by secrets.list. */
  usedByApp?: boolean;
}

// ------------------------------------------------------------------ X05: grouped secrets (logins, cards)

export type SecretGroupKind = 'login' | 'card' | 'other';

export interface SecretGroupRef { id: string; label: string; kind: SecretGroupKind }

/** A login or card in the vault: metadata only – its fields are SecretInfo rows with their own handles. */
export interface SecretGroup {
  id: string;
  label: string;
  kind: SecretGroupKind; // fixed after creation
  description?: string; // when agents should use it (never a secret)
  /** 29.10.2026: the site it was saved from – provenance only. */
  source?: string;
  /** The catalog route (area) of the group (owner 29.10.2026) – always set by the vault. */
  route?: string;
  /** Usage tags – information only. */
  tags?: string[];
  createdAt: number;
  lastUsedAt?: number;
  /** The agent that created it (secrets.generate, browser.save_totp); absent for the person's. Information only. */
  createdBy?: string;
  /** B-075: the app itself works with it (secrets/units.ts heldByApp); set by secrets.groups. */
  usedByApp?: boolean;
}

/** One field of secrets.saveGroup: `id` (or the same `field` name) edits a stored one; an empty value keeps it. */
export interface SecretGroupFieldInput { id?: string; field: string; kind: SecretInfo['kind']; value?: string }

export interface SecretGroupInput {
  id?: string;
  label?: string;
  kind?: SecretGroupKind;
  description?: string;
  /** 29.10.2026: the site it comes from (set by the app's tools only – the RPC never passes it); kept on edits. */
  source?: string;
  /** The catalog route; absent: kept, or chosen automatically for a new group (autoSecretRoute). */
  route?: string;
  /** Usage tags (replace the stored ones when given). */
  tags?: string[];
  fields?: SecretGroupFieldInput[];
  /** Field ids to delete (an edit on the PC). */
  remove?: string[];
}

export interface SecretGroupSaved { group: SecretGroup; fields: SecretInfo[] }

/** Field names: lower-case, unique per group. */
export const SECRET_FIELD_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
export const MAX_GROUP_FIELDS = 20;

// ------------------------------------------------------------------ owner 29.10.2026: the catalog (route files <data>/secrets/<route>.md)

/** The routes (areas) a new entry goes to automatically; the AI or the person may name another (SECRET_ROUTE). */
export const SECRET_ROUTES = ['logins', 'payment', 'keys', 'servers', 'notes'] as const;
/** A route name: lower-case letters, digits and "-" (it names its file). */
export const SECRET_ROUTE = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_SECRET_TAGS = 12;
export const MAX_SECRET_TAG = 120;
const SERVER_WORDS = /\b(ssh|sftp|ftp|server|vps|hosting|database|postgres(ql)?|mysql|mariadb|mongo(db)?|redis|rdp|vpn|imap|smtp|router|nas)\b/i;

/** The route an entry goes to when none is named: card data → payment, server words → servers, keys and tokens → keys, sign-ins → logins, the rest → notes. */
export function autoSecretRoute(kind: string, text = '', groupKind?: string): string {
  if (kind === 'card' || groupKind === 'card') return 'payment';
  if (SERVER_WORDS.test(text)) return 'servers';
  if (kind === 'api_key' || kind === 'token') return 'keys';
  if (kind === 'password' || kind === 'totp' || groupKind === 'login') return 'logins';
  return 'notes';
}

// ------------------------------------------------------------------ B-044: metadata files (since 29.10.2026 route files)

/** Why a route file is not used as it is (runtime/secrets/files.ts); 'read-only' = an edit of what only the app sets (id, kind, fields, source) was ignored. */
export type SecretFileProblem = 'read-only' | 'invalid' | 'too-large' | 'not-text' | 'unreadable';

/** A file's quiet notice (one short line, no path, no content). */
export interface SecretFileNotice { id: string; problem: SecretFileProblem; text: string; at: number }

/** A metadata file without a stored value ("value missing"): what the file says. */
export interface SecretFileEntry { id: string; name: string; purpose?: string; kind: SecretInfo['kind'] | SecretGroupKind; route: string; tags?: string[] }

export interface SecretFolder { missing: SecretFileEntry[]; notices: SecretFileNotice[] }

/** 29.10.2026: what a password import did (runtime/secrets/import.ts) – counts and names only, never a value. */
export interface SecretImportSummary {
  format: string;
  added: number;
  cards: number;
  /** 04.11.2026: single secrets of a .env or JSON file (format: shared/model/key-values.ts ENV_FORMAT, JSON_FORMAT). */
  keys: number;
  unchanged: number;
  differing: number;
  skipped: number;
  /** Not stored, or stored only in part (a login whose unreadable 2FA key was left out also counts in added). */
  failed: number;
  /** 04.11.2026: new entries that came with their own description (the app's export) – the review leaves them; absent when none. */
  described?: number;
  tag: string;
  reviewTaskId?: string;
  reviewer?: string;
}

/** Owner 04.11.2026: what an export wrote (runtime/secrets/export.ts) – the file and counts, never a value. */
export interface SecretExportSummary {
  file: string;
  /** Entries written. */
  count: number;
  /** Entries the format has no row for (a group of free fields) or whose value could not be read here. */
  skipped: number;
  /** Named ids that are no entry. */
  notFound?: string[];
}

/** The fields each kind starts with (`other` has free fields). */
export const SECRET_GROUP_TEMPLATES: Record<SecretGroupKind, ReadonlyArray<{ field: string; kind: SecretInfo['kind'] }>> = {
  login: [{ field: 'username', kind: 'text' }, { field: 'password', kind: 'password' }, { field: 'totp', kind: 'totp' }],
  card: [{ field: 'number', kind: 'card' }, { field: 'expiry', kind: 'card' }, { field: 'cvc', kind: 'card' }, { field: 'holder', kind: 'text' }],
  other: [],
};

declare module '../api/methods.ts' {
  interface Methods {
    /** Secure chat input: creates a general secret for this chat's current agents only. */
    'secrets.capture': { params: { conversationId: string; value: string; description?: string; clientId: string }; result: SecretInfo };
    /** X05: the stored groups (metadata only; their fields come with secrets.list). */
    'secrets.groups': { params: void; result: SecretGroup[] };
    /** X05: creates or edits a group and its fields at once; a device may only create (no group or field ids, no remove). */
    'secrets.saveGroup': { params: SecretGroupInput; result: SecretGroupSaved };
    /** X05, PC only: deletes a group with all its fields. */
    'secrets.deleteGroup': { params: { id: string }; result: { ok: true } };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** B-044: a secret, group or metadata file changed (saved, described, a file edited on disk, a notice came or went) – reload the list. Topic: system, owner. */
    'secrets.changed': { id?: string };
  }
}
