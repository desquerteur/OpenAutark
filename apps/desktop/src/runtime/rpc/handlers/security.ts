// RPC handlers: the spend journal and stored secrets.
// Owns: param checks and scope rules. Phones reach secrets metadata and spend only with the opt-in
// 'permissions' capability on a secure transport; from a phone a secret can only be created, never
// overwritten or deleted. X05: grouped secrets (logins, cards) – secrets.groups and secrets.saveGroup on
// the same tier (a phone only creates: no group or field ids, no removal), secrets.deleteGroup on the PC
// only. Every secret is for every agent (no access lists); secrets.save carries the purpose (`description`);
// secrets.folder (same tier) names the metadata files without a value and their quiet notices;
// secrets.openFolder opens <data>/secrets on the PC (secrets/files.ts). Owner 04.11.2026: secrets.export (PC only, like
// secrets.delete) writes the chosen entries with their values into one CSV file (secrets/export.ts) – only its path and
// counts come back. B-078 (D20): secrets.fillChoices lists the catalog's logins for a page (its registrable domain
// first, a suggestion only) and secrets.fillLogin hands one login's username and password to the owner's own desktop
// browser (main/workspace-fill.ts types them into the page) – main's own link only (fromMain), never logged.
// Never: returns or logs secret values (only SecretInfo metadata leaves the runtime – the one exception is the
// owner's own fill answer).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../../shared/errors.ts';
import type { SecretInfo, SpendEntry } from '../../../shared/model/security.ts';
import type { SecretGroup, SecretGroupFieldInput, SecretGroupKind } from '../../../shared/model/security.ts'; // X05
import { bad, id, ids, input, oneOf, onlyKeys, optId, optIds, optNum, optOneOf, optStrings, optText, text, type Obj } from '../params.ts';
import type { HandlerTable } from '../table.ts';
import { importSecrets, startReview, type SecretImportResult } from '../../secrets/import.ts';
import { MAX_IMPORT_CHARS, MAX_IMPORT_ROWS } from '../../secrets/import-parse.ts';
import { exportSecrets } from '../../secrets/export.ts';
import { heldByApp } from '../../secrets/units.ts';
import { registerChatCapture } from '../../secrets/chat-capture.ts';
import { ROOT_SECRETS } from '../../root/layout.ts';
import '../../contracts/secret-files.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { LoginChoice, LoginFill } from '../../../shared/model/login-fill.ts';
import type { ClientScope } from '../../../shared/api/protocol.ts';
import { registrableDomain } from '../../secrets/service.ts';

const PERMISSIONS = { capability: 'permissions', secure: true } as const;
const SECRET_KINDS: readonly SecretInfo['kind'][] = ['api_key', 'password', 'card', 'token', 'note', 'totp', 'text'];
const GROUP_KINDS: readonly SecretGroupKind[] = ['login', 'card', 'other'];
const SPEND_LIMIT = 1000;

const isPlain = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Projection that can never carry a value or cipher, whatever the service returns. */
function publicSecret(info: SecretInfo, held?: ReadonlySet<string>): SecretInfo {
  const out: SecretInfo = { id: info.id, label: info.label, kind: info.kind, createdAt: info.createdAt };
  if (held?.has(info.id)) out.usedByApp = true; // B-075: Settings starts it unselected, so a bulk Delete leaves the app's own
  if (info.hint !== undefined) out.hint = info.hint;
  if (info.source !== undefined) out.source = info.source; // 29.10.2026: where it was saved from (provenance)
  if (info.route !== undefined) out.route = info.route; // owner 29.10.2026: its catalog route
  if (info.tags?.length) out.tags = [...info.tags];
  if (info.lastUsedAt !== undefined) out.lastUsedAt = info.lastUsedAt;
  if (info.group) out.group = { id: info.group.id, label: info.group.label, kind: info.group.kind };
  if (info.field !== undefined) out.field = info.field;
  if (info.description !== undefined) out.description = info.description;
  if (info.conversationId !== undefined) out.conversationId = info.conversationId;
  // who made it (an agent id, or SYSTEM_ID for the app's own – a calendar link's address, which Settings › Secrets leaves out)
  if (info.createdBy !== undefined) out.createdBy = info.createdBy;
  return out;
}

/** X05: a group's metadata only, whatever the service returns. */
function publicGroup(group: SecretGroup, held?: ReadonlySet<string>): SecretGroup {
  const out: SecretGroup = { id: group.id, label: group.label, kind: group.kind, createdAt: group.createdAt };
  if (held?.has(group.id)) out.usedByApp = true;
  if (group.route !== undefined) out.route = group.route;
  if (group.description !== undefined) out.description = group.description;
  if (group.tags?.length) out.tags = [...group.tags];
  if (group.source !== undefined) out.source = group.source;
  if (group.lastUsedAt !== undefined) out.lastUsedAt = group.lastUsedAt;
  return out;
}

/** X05: the fields of secrets.saveGroup (shape checks; names, kinds and keys are the vault's job). */
function groupFields(o: Obj): SecretGroupFieldInput[] | undefined {
  if (o.fields === undefined || o.fields === null) return undefined;
  if (!Array.isArray(o.fields) || o.fields.length > 20 || !o.fields.every(isPlain)) bad('fields', 'a list of at most 20 fields');
  return (o.fields as Obj[]).map((field) => {
    onlyKeys(field, ['id', 'field', 'kind', 'value'], 'fields[]');
    return {
      id: optId(field, 'id'), field: text(field, 'field', { max: 40 }), kind: oneOf(field, 'kind', SECRET_KINDS),
      value: field.value === undefined || field.value === null ? undefined : text(field, 'value', { max: 4096, multiline: true, allowEmpty: true }),
    };
  });
}

interface SpendRow { id: string; agent_id: string; amount: number; currency: string; kind: SpendEntry['kind']; ref: string | null; created_at: number }

export function register(table: HandlerTable): void {
  registerChatCapture(table);
  // ---------------------------------------------------------------- money
  table.add('spend.list', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'since']);
    const agentId = optId(o, 'agentId');
    const since = optNum(o, 'since', { min: 0 });
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (agentId) { where.push('agent_id = ?'); args.push(agentId); }
    if (since !== undefined) { where.push('created_at >= ?'); args.push(since); }
    const rows = ctx.services.db.all<SpendRow>(
      `SELECT id, agent_id, amount, currency, kind, ref, created_at FROM spend${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${SPEND_LIMIT}`,
      args,
    );
    return rows.map((row): SpendEntry => {
      const entry: SpendEntry = { id: row.id, agentId: row.agent_id, amount: Number(row.amount), currency: row.currency, kind: row.kind, createdAt: Number(row.created_at) };
      if (row.ref !== null) entry.ref = row.ref;
      return entry;
    });
  }, PERMISSIONS);

  // ---------------------------------------------------------------- secrets (metadata only)
  table.add('secrets.list', (_params, ctx) => { const held = heldByApp(ctx.services); return ctx.services.secrets.list().map((info) => publicSecret(info, held)); }, PERMISSIONS);
  table.add('secrets.save', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'label', 'kind', 'value', 'hint', 'route', 'tags', 'description']); // nobody restricts a secret to sites or agents
    if (ctx.scope.kind === 'device' && o.id !== undefined && o.id !== null) {
      throw new WorkforceError('forbidden', 'Stored secrets can only be changed on the PC.', { details: { param: 'id' } });
    }
    const saved = await ctx.services.secrets.save({
      id: optId(o, 'id'),
      label: text(o, 'label', { max: 120 }),
      kind: oneOf(o, 'kind', SECRET_KINDS),
      value: o.value === undefined || o.value === null ? undefined : text(o, 'value', { max: 16_384, multiline: true }),
      hint: optText(o, 'hint', { max: 40, allowEmpty: true }),
      route: optText(o, 'route', { max: 40 }), tags: optStrings(o, 'tags', { maxItems: 12, max: 120 }),
      description: optText(o, 'description', { max: 4000, multiline: true, allowEmpty: true }),
    });
    return publicSecret(saved);
  }, PERMISSIONS);
  // 29.10.2026: a browser's or password manager's export, read and stored in the runtime; the Manager gets the review task.
  table.add('secrets.import', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'fileName']);
    const content = text(o, 'text', { max: MAX_IMPORT_CHARS, multiline: true });
    const fileName = optText(o, 'fileName', { max: 260 });
    let result: SecretImportResult;
    try {
      result = await importSecrets(ctx.services.secrets, content, { ...(fileName ? { fileName } : {}), now: ctx.services.clock.now() });
    } catch (error) {
      if (error instanceof WorkforceError) throw error;
      throw new WorkforceError('bad_request', (error as Error).message);
    }
    return startReview(ctx.services, result);
  }, PERMISSIONS);
  // B-044: the metadata files without a value ("value missing") and the files' quiet notices.
  table.add('secrets.folder', (_params, ctx) => ({ missing: ctx.services.secretFiles?.missing() ?? [], notices: ctx.services.secretFiles?.notices() ?? [] }), PERMISSIONS);
  table.add('secrets.openFolder', async (_params, ctx) => {
    const folder = ctx.services.secretFiles?.folder ?? path.join(ctx.services.paths.data, ROOT_SECRETS);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    await ctx.services.host.openPath(folder, false);
    return { ok: true as const };
  });
  table.add('secrets.delete', (params, ctx) => {
    ctx.services.secrets.remove(id(input(params)));
    return { ok: true };
  });
  table.add('secrets.export', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['ids']);
    const chosen = optIds(o, 'ids', MAX_IMPORT_ROWS);
    return exportSecrets(ctx.services, chosen ? { ids: chosen } : {});
  });

  // ---------------------------------------------------------------- X05: grouped secrets (metadata only)
  table.add('secrets.groups', (_params, ctx) => { const held = heldByApp(ctx.services); return ctx.services.secrets.groups().map((group) => publicGroup(group, held)); }, PERMISSIONS);
  table.add('secrets.saveGroup', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'label', 'kind', 'description', 'route', 'tags', 'fields', 'remove']);
    const fields = groupFields(o);
    if (ctx.scope.kind === 'device' && (o.id !== undefined && o.id !== null || o.remove !== undefined || fields?.some((field) => field.id !== undefined))) {
      throw new WorkforceError('forbidden', 'Stored secrets can only be changed on the PC.', { details: { param: o.id !== undefined ? 'id' : o.remove !== undefined ? 'remove' : 'fields' } });
    }
    const saved = await ctx.services.secrets.saveGroup({
      id: optId(o, 'id'), label: optText(o, 'label', { max: 120 }), kind: optOneOf(o, 'kind', GROUP_KINDS),
      description: optText(o, 'description', { max: 500, multiline: true, allowEmpty: true }),
      route: optText(o, 'route', { max: 40 }), tags: optStrings(o, 'tags', { maxItems: 12, max: 120 }), fields,
      remove: o.remove === undefined || o.remove === null ? undefined : ids(o, 'remove', 20),
    });
    return { group: publicGroup(saved.group), fields: saved.fields.map((info) => publicSecret(info)) };
  }, PERMISSIONS);
  table.add('secrets.deleteGroup', (params, ctx) => {
    ctx.services.secrets.removeGroup(id(input(params)));
    return { ok: true };
  });

  // ---------------------------------------------------------------- B-078 (D20): Fill login in the person's browser
  table.add('secrets.fillChoices', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['url']);
    const site = registrableDomain(pageUrl(o));
    const choices: LoginChoice[] = ctx.services.secrets.groups().filter((group) => group.kind === 'login').map((group) => {
      const suggested = Boolean(site && group.source && registrableDomain(group.source) === site);
      return { id: group.id, label: group.label, ...(group.source ? { site: group.source } : {}), ...(suggested ? { suggested: true as const } : {}) };
    });
    return choices.sort((a, b) => Number(Boolean(b.suggested)) - Number(Boolean(a.suggested)) || a.label.localeCompare(b.label)).slice(0, 500);
  });
  table.add('secrets.fillLogin', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'url']);
    // The values go to main's own link only (it types them into the page) – never to the window, the CLI or a loopback client.
    if (!fromMain(ctx.scope)) throw new WorkforceError('forbidden', 'Logins are filled in the PC\'s own browser.');
    const groupId = id(o);
    const domain = registrableDomain(pageUrl(o));
    const fields = ctx.services.secrets.list().filter((info) => info.group?.id === groupId && info.group.kind === 'login');
    if (!fields.length) throw new WorkforceError('not_found', 'Login not found.', { details: { id: groupId } });
    const out: LoginFill = {};
    for (const name of ['username', 'password'] as const) {
      const field = fields.find((info) => info.field === name);
      if (field) out[name] = await ctx.services.secrets.use(field.id, HUMAN_ID, domain); // the vault logs the domain, never the value
    }
    return out;
  });
}

/**
 * Main's own RPC link (Electron main, which drives the integrated browser): an owner scope marked `main: true`, set only
 * where the runtime entry serves the port main asked for as 'main' (entry-electron.ts). Every other owner client
 * (the window, the CLI, loopback HTTP with the launch token) has no mark.
 */
export function fromMain(scope: ClientScope): boolean {
  return scope.kind === 'owner' && scope.main === true; // set by entry-electron for main's own port only
}

/** The page's http(s) address (for its registrable domain only). */
function pageUrl(o: Obj): string {
  const value = text(o, 'url', { max: 4000 }).trim();
  try { if (/^https?:$/.test(new URL(value).protocol)) return value; } catch { /* below */ }
  return bad('url', 'the page\'s http(s) address');
}
