// RPC contract part: money (spend journal) and secrets. Handlers: runtime/rpc/handlers/security.ts.
// Merged into Methods by module augmentation. Owns: these method shapes. Never: behaviour.

import type { SecretExportSummary, SecretFolder, SecretImportSummary, SecretInfo, SpendEntry } from '../model/security.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- money, secrets
    'spend.list': { params: { agentId?: string; since?: number } | void; result: SpendEntry[] };
    'secrets.list': { params: void; result: SecretInfo[] };
    /** `description` = its purpose (B-044); a new `id` (PC only) stores the value of a metadata file that has none yet. */
    'secrets.save': { params: { id?: string; label: string; kind: SecretInfo['kind']; value?: string; hint?: string; route?: string; tags?: string[]; description?: string }; result: SecretInfo };
    /** PC only: deletes a secret – or the file of a metadata entry without a value – and its file <data>/secrets/<id>.md. */
    'secrets.delete': { params: { id: string }; result: { ok: true } };
    /** 29.10.2026: imports a password export (browser or password-manager CSV, Bitwarden JSON) or the secrets of a .env or flat JSON file (plain settings skipped) into the catalog; the top Manager gets a task to describe them. Never returns a value. */
    'secrets.import': { params: { text: string; fileName?: string }; result: SecretImportSummary };
    /** Owner 04.11.2026, PC only: writes the entries `ids` names (a single secret, a login or card; all when absent) with their values into one CSV (~/Downloads/autark-secrets-<date>.csv, mode 0600) that secrets.import reads back. Returns the path and counts, never a value. */
    'secrets.export': { params: { ids?: string[] } | void; result: SecretExportSummary };
    /** B-044, 'permissions': the metadata files without a stored value ("value missing") and the files' quiet notices. */
    'secrets.folder': { params: void; result: SecretFolder };
    /** B-044, PC only: opens <data>/secrets in the system's file manager (created when missing). */
    'secrets.openFolder': { params: void; result: { ok: true } };
  }
}

export {};
