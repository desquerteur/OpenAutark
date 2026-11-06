// Secret tools for agents (owner 29.10.2026: the secrets store is a catalog like a skill, with zero restrictions).
// secrets.list reads like a skill index – every entry with its id, name, description, kind, route, tags, the site or
// tool it was saved from and its handle (a login or card: one handle per field) – the same entries as the route files
// <data>/secrets/<route>.md (secrets/files.ts), where a name, description or tags are changed by editing the file.
// secrets.save adds an entry: a description and a value that goes straight into the vault (route chosen and id
// generated; the agent may name either). secrets.generate creates a random password (crypto.randomInt in the vault)
// as a single secret, a new login (username) or into a stored login (group). secrets.import reads a password export or
// the secrets of a .env or flat JSON file on this PC by its path into the vault (no value reaches the agent) and
// deletes a known browser's or manager's export after a complete import (owner 04.11.2026: every entry stored whole,
// none skipped), never a .env, JSON or other CSV file. Agents use a secret only by its handle `secret://<id>` – in a
// browser field, a command's env, a web.fetch header, a connector – on any site and for any host; the value is decrypted
// at that moment inside the runtime and never appears in a prompt, output or journal (secrets.save's value is a hidden
// argument). Owner 04.11.2026 (the AI should simply do it): secrets.export writes chosen entries with their values into one
// CSV file on this PC (secrets/export.ts) – for secrets.import in another company or on another PC; secrets.delete removes
// entries by id, route or all at once (the CEO's linked PCs follow through the device sync); "all" and a route leave the
// app's own working credentials unless named (secrets/units.ts catalogUnits). Both return names, a path and counts only.
// Owns: the agent's view of the catalog. Never: returns or logs a value.

import { readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SecretGroup, SecretInfo } from '../../../shared/model/security.ts';
import { SECRET_ROUTES } from '../../../shared/model/security.ts';
import { isKeyValueFormat } from '../../../shared/model/key-values.ts';
import { registrableDomain } from '../../secrets/service.ts';
import { newEntryId } from '../../secrets/entry-id.ts';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { clip, defineTool, internal, iso } from './util.ts';
import { secretMetadata } from '../../secrets/metadata.ts';
import { ROOT_SECRETS } from '../../root/layout.ts';
import { importSecrets, reviewBrief, reviewCount, storedCount } from '../../secrets/import.ts';
import { GENERIC_EXPORT, MAX_IMPORT_CHARS, MAX_IMPORT_ROWS } from '../../secrets/import-parse.ts';
import { exportSecrets } from '../../secrets/export.ts';
import { catalogUnits } from '../../secrets/units.ts';

export const NOTE = 'Values stay hidden. I use a secret by its handle "secret://<id>": in a browser field (browser.act value), in shell.exec or secrets.run env, in a web.fetch header or a connector file. Every secret works everywhere – any site, any command, any host, cards included; savedFrom only says where it came from, tags are notes. A login or card has one handle per field; a 2FA field fills the current one-time code. What a command or request returns has the values it received masked. Whenever I get a secret, I save it here at once (secrets.save, browser.save_secret) and use its id – values stay out of my notes, memory, rules, files and messages. Each route is a file <route>.md in the folder named here – I edit a name, description or tags there.';

const TAGS = { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 12, description: 'usage tags, e.g. "for the web at example.com", "CI deploys" – information, not a restriction' } as const;
const ROUTE = { type: 'string', maxLength: 40, description: `the catalog route: ${SECRET_ROUTES.join(', ')} or my own (lower-case, "-"); default: chosen from the kind and description` } as const;

function single(info: SecretInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: info.id, name: info.label, description: info.description || undefined, kind: info.kind, route: info.route, tags: info.tags,
    savedFrom: info.source, handle: `secret://${info.id}`, hint: info.hint, lastUsed: iso(info.lastUsedAt),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/** A field of a group: its handle and kind; a 2FA field says what it fills (never a value). */
function fieldView(info: SecretInfo): Record<string, unknown> {
  const digits = /^(\d) digits/.exec(info.hint ?? '')?.[1] ?? '6';
  const hint = info.kind === 'totp' ? `fills the current ${digits}-digit code` : info.hint;
  return { field: info.field, handle: `secret://${info.id}`, kind: info.kind, ...(hint ? { hint } : {}) };
}

function groupView(group: SecretGroup, fields: SecretInfo[]): Record<string, unknown> {
  return {
    id: group.id, name: group.label, ...(group.description ? { description: group.description } : {}), kind: group.kind, route: group.route,
    ...(group.tags?.length ? { tags: group.tags } : {}), ...(group.source ? { savedFrom: group.source } : {}), fields: fields.map(fieldView),
  };
}

const list = defineTool<{ text?: string; route?: string }>({
  name: 'secrets.list',
  description: `The secrets catalog, like a skill index: id, name, description, kind, route, tags and handle (logins and cards: one handle per field). Search by text or route. ${NOTE}`,
  inputSchema: { type: 'object', properties: {
    text: { type: 'string', maxLength: 100, description: 'Search name, id, description, tags or the site it was saved from' }, route: { type: 'string', maxLength: 40 },
  }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List the secrets catalog'),
  async run(args, ctx) {
    const needle = args.text?.trim().toLowerCase();
    const route = args.route?.trim().toLowerCase();
    const matches = (entry: { route?: string }, text: string) => (!route || entry.route === route) && (!needle || text.toLowerCase().includes(needle));
    const all = ctx.services.secrets.list();
    const singles = all.filter((info) => !info.group && matches(info, `${secretMetadata(info)} ${info.id}`)).map((info) => ({ name: info.label, view: single(info) }));
    const groups = ctx.services.secrets.groups()
      .filter((group) => matches(group, `${secretMetadata(group)} ${group.id}`))
      .map((group) => ({ name: group.label, view: groupView(group, all.filter((info) => info.group?.id === group.id)) }));
    const secrets = [...singles, ...groups].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.view);
    const data = ctx.services.paths?.data;
    return json({ note: NOTE, ...(data ? { folder: path.join(data, ROOT_SECRETS) } : {}), count: secrets.length, secrets });
  },
});

interface SaveArgs { name: string; description: string; value: string; kind?: 'api_key' | 'token' | 'password' | 'card' | 'note' | 'totp'; username?: string; route?: string; id?: string; tags?: string[]; source?: string }

const save = defineTool<SaveArgs>({
  name: 'secrets.save',
  description: 'Add a secret to the catalog the moment I get one (a key or token a tool or page returned, a password or note I was given): give a name, a description (what it opens, when to use it) and the value – it goes straight into the encrypted store and only its handle comes back. The route is chosen and the id generated for me (I can name a route or suggest an id). Every agent can use it. I keep the value here, nowhere else. A value already stored returns that handle.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', minLength: 1, maxLength: 4000 },
      value: { type: 'string', minLength: 1, maxLength: 16_384 },
      kind: { type: 'string', enum: ['api_key', 'token', 'password', 'card', 'note', 'totp'], description: 'default api_key; totp = a 2FA setup key (its handle fills the current code)' },
      username: { type: 'string', minLength: 1, maxLength: 320, description: 'with a password: saves a login (username + password), e.g. a server or database login' },
      route: ROUTE,
      id: { type: 'string', maxLength: 60, description: 'a suggested id (lower-case words with "-"), e.g. "github-ci-token"' },
      tags: TAGS,
      source: { type: 'string', maxLength: 200, description: 'where the value came from, e.g. "api.example.com" or "the deploy CLI"' },
    },
    required: ['name', 'description', 'value'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`Save the secret "${clip(args.name.replace(/["\s]+/g, ' '), 60)}" in the catalog${args.route ? ` (route ${clip(args.route, 40)})` : ''}`),
  async run(args, ctx) {
    const secrets = ctx.services.secrets;
    const value = args.value;
    // The value reaches this tool as given (registry VAULT_ARGS: the leak guard leaves it alone).
    if (/^secret:\/\/[A-Za-z0-9_-]+$/.test(value.trim())) return failure('Give the value itself, not a handle (that one is already stored).');
    const known = secrets.holding ? (await secrets.holding(value, ctx.agent.id))[0] : undefined;
    const stored = known ? secrets.list().find((info) => info.id === known) : undefined;
    if (stored) return json({ ok: true, id: stored.id, handle: `secret://${stored.id}`, name: stored.group ? `${stored.field ?? 'field'} of ${stored.group.label}` : stored.label, note: 'That value is already stored; nothing new was saved. Use this handle.' });
    const id = newEntryId(secrets.list(), secrets.groups(), args.name, args.id);
    if (args.username !== undefined) { // review intent #9: a server or database login as one entry with two handles
      const login = await secrets.saveGroup({
        id, label: args.name, kind: 'login', description: args.description, ...(args.route ? { route: args.route } : {}), ...(args.tags ? { tags: args.tags } : {}),
        ...(args.source?.trim() ? { source: args.source.trim() } : {}),
        fields: [{ field: 'username', kind: 'text', value: args.username.trim() }, { field: 'password', kind: 'password', value }],
      }, { createdBy: ctx.agent.id });
      const handles = Object.fromEntries(login.fields.map((field) => [field.field, `secret://${field.id}`]));
      return json({ ok: true, id: login.group.id, name: login.group.label, route: login.group.route, handles, note: 'Stored in the catalog as a login. I use each field by its handle everywhere, without typing it out or copying it.' });
    }
    const saved = await secrets.save({
      id, label: args.name, kind: args.kind ?? 'api_key', value, description: args.description,
      createdBy: ctx.agent.id, ...(args.route ? { route: args.route } : {}), ...(args.tags ? { tags: args.tags } : {}),
      ...(args.source?.trim() ? { source: args.source.trim() } : {}),
    });
    return json({ ok: true, id: saved.id, handle: `secret://${saved.id}`, name: saved.label, route: saved.route, note: 'Stored in the catalog. I use it by its handle everywhere, without typing it out or copying it.' });
  },
});

interface GenerateArgs { site?: string; label?: string; purpose?: string; length?: number; symbols?: boolean; username?: string; group?: string; replace?: boolean }

const generate = defineTool<GenerateArgs>({
  name: 'secrets.generate',
  description: 'Create a strong random password – for a sign-up on a site, a server, a database or an app – and store it in the catalog (usable everywhere; a site is only noted as its source). Returns just its handle – use it in browser.act (value "secret://<id>") for the password and confirmation fields. With username it creates a login (username + password handles); with group it puts the password into a stored login (replace:true to change a stored password or username).',
  inputSchema: {
    type: 'object',
    properties: {
      site: { type: 'string', minLength: 3, maxLength: 300, description: 'optional: the site or system it is for, e.g. "accounts.example.com" or "build server postgres"' },
      label: { type: 'string', minLength: 1, maxLength: 120, description: 'e.g. "Example – support account"' },
      purpose: { type: 'string', minLength: 1, maxLength: 4000, description: 'its description: what it opens and when to use it, e.g. "Sign-in of the support account on example.com"' },
      length: { type: 'integer', minimum: 12, maximum: 64 },
      symbols: { type: 'boolean', description: 'false when the site refuses symbols' },
      username: { type: 'string', minLength: 1, maxLength: 320, description: 'the login name or email: creates a login (username + password)' },
      group: { type: 'string', maxLength: 64, description: 'a stored login (secrets.list) to put the password into' },
      replace: { type: 'boolean', description: 'true to replace the password (and the username, when given) already in that login' },
    },
    additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`Create a password for ${args.site ? clip(registrableDomain(args.site) ?? args.site, 80) : 'a new secret'}${args.username !== undefined || args.group ? ' (login)' : ''}`),
  async run(args, ctx: ToolContext) {
    const site = args.site?.trim() || undefined;
    const label = args.label?.trim() || `${ctx.agent.name} · ${(site ? registrableDomain(site) : undefined) ?? site ?? 'password'}`;
    const info = await ctx.services.secrets.generate({
      label, agentId: ctx.agent.id, ...(site ? { site } : {}), length: args.length, symbols: args.symbols, username: args.username, groupId: args.group, replace: args.replace,
    });
    const purpose = args.purpose?.trim();
    // A new login takes the description; an existing login keeps its own.
    if (purpose && info.group && args.group === undefined) await ctx.services.secrets.saveGroup({ id: info.group.id, label: info.group.label, description: purpose });
    else if (purpose && !info.group) await ctx.services.secrets.save({ id: info.id, kind: info.kind, label: info.label, description: purpose });
    if (!info.group) return json({ ok: true, handle: `secret://${info.id}`, label: info.label, savedFrom: info.source, note: 'Stored in the catalog. I fill it with the handle instead of typing it out.' });
    const fields = ctx.services.secrets.list().filter((entry) => entry.group?.id === info.group!.id);
    const handles = Object.fromEntries(fields.map((field) => [field.field, `secret://${field.id}`]));
    return json({
      ok: true, group: info.group.id, label: info.group.label, handle: `secret://${info.id}`, handles, savedFrom: info.source,
      note: 'My login in the catalog. I fill each field with its handle instead of typing the password out.',
    });
  },
});

/**
 * What happened to the imported file, in one line: a known browser's or password manager's export is deleted once every
 * entry is in the catalog whole; a .env or JSON file, any other CSV and an incomplete import stay.
 */
function settleFile(file: string, result: { format: string; failed: number; skipped: number }): string {
  const plain = `the export stays at ${file} – it holds every password in plain text.`;
  const entries = (count: number) => `${count} ${count === 1 ? 'entry was' : 'entries were'}`;
  if (isKeyValueFormat(result.format)) return 'Kept: a .env or JSON file is a working file of its own.';
  if (result.format === GENERIC_EXPORT) return `Kept: not a known password manager's export, so ${plain}`;
  if (result.failed) return `Kept: ${entries(result.failed)} not stored completely (e.g. a 2FA key the vault could not read), so ${plain}`;
  if (result.skipped) return `Kept: ${entries(result.skipped)} not imported (e.g. a note or a row without a password), so ${plain}`;
  try { rmSync(file, { force: true }); } catch { return `Kept: the export could not be deleted, so ${plain}`; }
  return 'Deleted: every value is in the catalog now, and the export held them in plain text.';
}

const importFile = defineTool<{ path: string }>({
  name: 'secrets.import',
  description: 'Import a password export or a key/value file on this PC into the catalog: the CSV of Chrome, Edge, Brave, Firefox, Safari, Bitwarden, 1Password, KeePass, LastPass, Dashlane, Proton Pass or NordPass, a file secrets.export wrote (names, descriptions and routes come with it), Bitwarden JSON, a .env file or a flat JSON of names and values (its secrets go in; a plain setting such as NODE_ENV or PORT, or a value under 8 characters, counts as skipped). Give its path – the app reads it, so no value reaches me (opening it with Read or cat would bring every value into my context). I get the counts, one line about the file (the export of a browser or password manager is deleted once every entry is stored whole; a .env, JSON or other CSV file stays) and then I name, describe and check the new entries.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1000, description: 'the file, e.g. "C:/Users/me/Downloads/Chrome Passwords.csv" or "C:/code/shop/.env"' } }, required: ['path'], additionalProperties: false },
  category: 'write_local',
  describe: (args) => internal(`Import the secrets of ${clip(path.basename(args.path), 80)} into the secrets catalog`),
  async run(args, ctx) {
    const file = path.resolve(args.path);
    let content: string;
    try {
      if (statSync(file).size > MAX_IMPORT_CHARS) return failure('The file is larger than 5 MB.');
      content = readFileSync(file, 'utf8');
    } catch { return failure('The file could not be read.'); }
    try {
      // The person's secrets: stored as theirs, not the agent's.
      const result = await importSecrets(ctx.services.secrets, content, { fileName: path.basename(file), now: ctx.services.clock.now() });
      const next = reviewCount(result) ? reviewBrief(result) : storedCount(result) ? 'Every new entry came with its own name and description.' : 'Nothing new was stored.';
      return json({ ok: true, ...result, file: settleFile(file, result), next });
    } catch (error) { return failure((error as Error).message); }
  },
});

const IDS = { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: MAX_IMPORT_ROWS } as const;

const exportFile = defineTool<{ path?: string; ids?: string[]; route?: string }>({
  name: 'secrets.export',
  description: 'Write catalog entries with their values into one CSV file on this PC – to move them into another company or onto another PC, where secrets.import reads it back with names, descriptions, tags and routes (browsers and password managers read its logins too). All entries (but the app\'s own working credentials – an account\'s API key, a bridge\'s token, an app\'s sign-in – unless I name them), those of a route, or the ids I name (a login or card by its id). I get the path and the counts, no value; the file holds every value in plain text (opening it with Read or cat would bring every value into my context) – I hand its path to secrets.import, which deletes it after a complete import; else I delete it when done.',
  inputSchema: {
    type: 'object', properties: {
      path: { type: 'string', minLength: 1, maxLength: 1000, description: 'file or folder; default ~/Downloads/autark-secrets-<date>.csv' },
      ids: IDS, route: { type: 'string', maxLength: 40, description: 'only the entries of this route' },
    }, additionalProperties: false,
  },
  category: 'secret',
  describe: (args) => internal(`Export ${args.ids?.length ? `${args.ids.length} ${args.ids.length === 1 ? 'entry' : 'entries'}` : args.route ? `the route ${clip(args.route, 40)}` : 'the secrets catalog'} to a file`),
  async run(args, ctx) {
    try {
      const result = await exportSecrets(ctx.services, { ...(args.ids?.length ? { ids: args.ids } : {}), ...(args.route ? { route: args.route } : {}), ...(args.path ? { file: args.path } : {}) });
      const note = [
        'Hand the file to secrets.import in the other company or on the other PC.',
        result.skipped ? `${result.skipped} skipped: a group of free fields has no row in this file, or a value could not be read here.` : '',
        result.notFound ? `${result.notFound.length} of the ids I named are no entry (notFound) – secrets.list shows the ids.` : '',
      ].filter(Boolean).join(' ');
      return json({ ok: true, ...result, note });
    } catch (error) { return failure(`The file could not be written: ${(error as Error).message}`); }
  },
});

const removeEntries = defineTool<{ ids?: string[]; route?: string; all?: boolean }>({
  name: 'secrets.delete',
  description: 'Delete catalog entries: the ids I name (a login or card by its id with all its fields, a single field by its handle\'s id), every entry of a route, or all: true for the whole catalog (a route or all leaves the app\'s own working credentials – an account\'s API key, a bridge\'s token, an app\'s sign-in – unless I name them by id). I get the names removed; the CEO\'s linked PCs remove them too.',
  inputSchema: {
    type: 'object', properties: {
      ids: IDS, route: { type: 'string', maxLength: 40, description: 'every entry of this route' }, all: { type: 'boolean', enum: [true], description: 'every entry of the catalog' },
    }, additionalProperties: false,
  },
  category: 'delete',
  describe: (args) => ({ ...internal(`Delete ${args.ids?.length ? `${args.ids.length} ${args.ids.length === 1 ? 'secret' : 'secrets'}` : args.route ? `the secrets of route ${clip(args.route, 40)}` : 'every secret'} from the catalog`), reversible: false }),
  async run(args, ctx) {
    const vault = ctx.services.secrets;
    if (!args.ids?.length && !args.route && args.all !== true) return failure('Name the entries: ids, a route, or all: true.');
    const removed: string[] = [];
    const notFound: string[] = [];
    if (args.ids?.length) {
      const fields = vault.list();
      const groups = vault.groups();
      for (const id of new Set(args.ids)) {
        const group = groups.find((entry) => entry.id === id);
        const info = fields.find((entry) => entry.id === id);
        if (group) { vault.removeGroup(id); removed.push(group.label); } else if (info) { vault.remove(id); removed.push(info.group ? `${info.field ?? 'field'} of ${info.group.label}` : info.label); } else notFound.push(id);
      }
    } else {
      for (const unit of catalogUnits(ctx.services, args.route)) {
        if (unit.group) vault.removeGroup(unit.id); else vault.remove(unit.id);
        removed.push(unit.name);
      }
    }
    return json({
      ok: true, count: removed.length, removed, ...(notFound.length ? { notFound } : {}),
      note: removed.length ? 'The CEO\'s linked PCs remove them too (device sync).' : 'Nothing was removed.',
    });
  },
});

export const secretTools: ToolDef[] = [list, save, generate, importFile, exportFile, removeEntries];
