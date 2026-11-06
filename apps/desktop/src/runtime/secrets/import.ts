// Password import (owner 29.10.2026, passwords from the browser): the person
// imports their browser's or password manager's export once (import-parse.ts reads it); every login becomes a login of the
// catalog (username · password · 2FA key · notes – each its own handle), a Bitwarden card a card, all for every agent like
// every new entry. Then the top Manager gets one task: name and describe the new entries (so the embedding and decision
// models find them), sort out differing duplicates and check the logins the team will use.
// Duplicates: a login of the same site (registrable domain) and username already stored with the same password is
// skipped; with another password the import is added next to it, tagged, and the task names it (an agent may have
// changed it since; the export may be older). Nothing stored is overwritten. Same login twice in the file: once.
// The comparison uses the vault's keyed prints (SecretVault.loginPrints, one decrypt pass) – no value leaves the vault.
// A login whose 2FA key the vault cannot read is stored without it and also counts as failed: the import is not
// complete, so the export (the only copy of that key) stays.
// Owner 04.11.2026: a secret of a .env or JSON file becomes one single secret named after it, its kind from the name
// (shared/model/key-values.ts; plain settings and short values are skipped in import-parse.ts); a value the vault
// already holds (or an earlier line of the file gave) counts as unchanged.
// Owner 04.11.2026 ("Import 1, Import 2 … nochmal machen für eine andere Firma"): what the app's own export brings – name,
// description, tags, route and a single secret's kind – is kept, so a re-import into another company needs no renaming;
// the review task covers only the entries that came without a description (an earlier import's "not described yet"
// counts as none), and its brief names several logins of one service by their account ("OpenAI - max@firma.de").
// Owns: turning parsed items into catalog entries, the summary and the review task. Never: logs, returns or keeps a
// value; writes a value anywhere but the vault; ties an entry to a site (the site is only its source).

import type { RuntimeServices } from '../contracts.ts';
import type { SecretGroupFieldInput, SecretGroupInput, SecretImportSummary } from '../../shared/model/security.ts';
import { MAX_SECRET_TAG, MAX_SECRET_TAGS } from '../../shared/model/security.ts';
import { kindForName } from '../../shared/model/key-values.ts';
import { managerAgent } from '../../shared/text/manager-chat.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { newEntryId } from './entry-id.ts';
import { MAX_FIELD_VALUE } from './groups.ts';
import { parseExport, type ImportedCard, type ImportedLogin, type ImportedMeta } from './import-parse.ts';
import { hostOf, registrableDomain } from './service.ts';

/** What one import did (shared/model/security.ts SecretImportSummary): counts and names only – never a value. */
export type SecretImportResult = SecretImportSummary;

export const DIFFERS_TAG = 'imported – differs from a stored login';

type Vault = RuntimeServices['secrets'];
/** The vault's prints; `values`: the print of every stored value that is not a 2FA key (SecretVault.loginPrints). */
type Prints = Awaited<ReturnType<NonNullable<Vault['loginPrints']>>> & { values?: ReadonlySet<string> };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const tag = (text: string) => clip(text.replace(/\s+/g, ' ').trim(), MAX_SECRET_TAG);

/** The site key of a login: its registrable domain, an app id as it is, else ''. */
function siteOf(url: string | undefined): string {
  if (!url) return '';
  return url.startsWith('android app ') ? url : registrableDomain(url) ?? '';
}

/** The fields of a login; `withTotp: false` leaves out a 2FA key the vault could not read. */
function loginFields(item: ImportedLogin, withTotp: boolean): SecretGroupFieldInput[] {
  return [
    ...(item.username ? [{ field: 'username', kind: 'text' as const, value: item.username }] : []),
    { field: 'password', kind: 'password', value: item.password },
    ...(withTotp && item.totp ? [{ field: 'totp', kind: 'totp' as const, value: item.totp }] : []),
    ...(item.notes ? [{ field: 'notes', kind: 'note' as const, value: item.notes.slice(0, MAX_FIELD_VALUE) }] : []),
  ];
}

function cardFields(item: ImportedCard): SecretGroupFieldInput[] {
  return [
    { field: 'number', kind: 'card', value: item.number },
    ...(item.expiry ? [{ field: 'expiry', kind: 'card' as const, value: item.expiry }] : []),
    ...(item.cvc ? [{ field: 'cvc', kind: 'card' as const, value: item.cvc }] : []),
    ...(item.holder ? [{ field: 'holder', kind: 'text' as const, value: item.holder }] : []),
    ...(item.notes ? [{ field: 'notes', kind: 'note' as const, value: item.notes.slice(0, MAX_FIELD_VALUE) }] : []),
  ];
}

/** An entry's tags: its own (the app's export), the import's tag (the review lists the entries by it), the folder, the duplicate note. */
function tagsOf(item: ImportedMeta & { folder?: string }, importTag: string, twin?: string): string[] {
  return [...(item.tags ?? []).slice(0, MAX_SECRET_TAGS - 3), importTag, ...(item.folder ? [`folder ${item.folder}`] : []), ...(twin ? [DIFFERS_TAG] : [])].map(tag);
}

/** What an import writes for an entry that came without a description ("… not described yet."). */
const UNDESCRIBED = /\bnot described (?:or checked )?yet\b/i;

/** The description an item came with – none when it is an earlier import's placeholder (exported before the review). */
const givenDescription = (item: ImportedMeta): string | undefined => (item.description && !UNDESCRIBED.test(item.description) ? item.description : undefined);

/** One entry's group input (metadata: name, description, tags, route, source). `twin`: a stored login it differs from. */
function entryOf(item: ImportedLogin | ImportedCard, format: string, date: string, twin?: string): Omit<SecretGroupInput, 'id'> {
  const importTag = `imported from ${format} ${date}`;
  const route = item.route ? { route: item.route } : {};
  if (item.type === 'card') {
    const last = item.number.replace(/\D/g, '').slice(-4);
    const description = givenDescription(item) ?? `Payment card imported from ${format} on ${date}; not described yet.`;
    return { label: clip(item.name ?? `Card •••• ${last}`, 120), kind: 'card', ...route, tags: tagsOf(item, importTag), description: clip(description, 500), fields: cardFields(item) };
  }
  const site = siteOf(item.url);
  const where = item.url && item.url !== `https://${site}` ? `${site || 'a site'} (${clip(item.url, 200)})` : site || 'an unknown site';
  const description = [
    givenDescription(item) ?? `Sign-in for ${where}. Imported from ${format} on ${date}; not described or checked yet.`,
    twin ? `The same site and username are stored as ${twin} with another password – one of the two is outdated.` : '',
  ].filter(Boolean).join(' ');
  return {
    label: clip(item.name ?? (site || 'Imported login'), 120), kind: 'login', ...(site ? { source: site } : {}), ...route,
    tags: tagsOf(item, importTag, twin), description: clip(description, 500), fields: loginFields(item, true),
  };
}

/** Stores the items of an export (see the header); `createdBy`: the agent importing (absent: the person). */
export async function importSecrets(vault: Vault, text: string, options: { fileName?: string; now: number; createdBy?: string }): Promise<SecretImportResult> {
  const parsed = parseExport(text, options.fileName);
  const date = new Date(options.now).toISOString().slice(0, 10);
  const result: SecretImportResult = { format: parsed.format, added: 0, cards: 0, keys: 0, unchanged: 0, differing: 0, skipped: parsed.skipped, failed: 0, tag: `imported from ${parsed.format} ${date}` };
  const prints: Prints = vault.loginPrints ? await vault.loginPrints() : { print: (value: string) => value, logins: [] };
  const values = new Set(prints.values); // what the vault holds, plus each value stored below
  const known = prints.logins.map((login) => ({ ...login, site: siteOf(login.source ? (login.source.includes('://') ? login.source : `https://${login.source}`) : undefined) || (login.source ?? '') }));
  const seen = new Set<string>();
  const taken: Array<{ id: string }> = [...vault.list(), ...vault.groups()]; // the ids in use, kept here (no list per entry)
  for (const item of parsed.items) {
    if (item.type === 'value') {
      const print = prints.print(item.value);
      if (values.has(print)) { result.unchanged++; continue; }
      const id = newEntryId(taken, [], item.name);
      taken.push({ id });
      const source = hostOf(item.url);
      try {
        await vault.save({
          id, label: item.name, kind: item.kind ?? kindForName(item.name), value: item.value, tags: tagsOf(item, result.tag),
          description: clip(givenDescription(item) ?? `Imported from ${options.fileName ?? parsed.format} on ${date}; not described yet.`, 4000),
          ...(item.route ? { route: item.route } : {}), ...(source ? { source } : {}), ...(options.createdBy ? { createdBy: options.createdBy } : {}),
        });
        values.add(print);
        result.keys++;
        if (givenDescription(item)) result.described = (result.described ?? 0) + 1;
      } catch { result.failed++; }
      continue;
    }
    let twin: string | undefined;
    if (item.type === 'login') {
      const site = siteOf(item.url);
      const user = item.username ? prints.print(item.username) : undefined;
      const pass = prints.print(item.password);
      const key = `${site}\n${user ?? ''}\n${pass}`;
      if (seen.has(key)) { result.unchanged++; continue; }
      seen.add(key);
      const same = known.filter((login) => site && login.site === site && login.username === user);
      if (same.some((login) => login.password === pass)) { result.unchanged++; continue; }
      twin = same[0]?.id;
    }
    const entry = entryOf(item, parsed.format, date, twin);
    const id = newEntryId(taken, [], entry.label ?? 'imported');
    taken.push({ id });
    try {
      if (await saveEntry(vault, { ...entry, id }, item, options.createdBy)) result.failed++; // stored without its 2FA key
    } catch {
      result.failed++;
      continue;
    }
    if (item.type === 'card') result.cards++;
    else { result.added++; if (twin) result.differing++; }
    if (givenDescription(item)) result.described = (result.described ?? 0) + 1;
  }
  return result;
}

/** Saves one entry; a login whose 2FA key the vault cannot read is saved without it – then true (not stored completely). */
async function saveEntry(vault: Vault, input: SecretGroupInput, item: ImportedLogin | ImportedCard, createdBy?: string): Promise<boolean> {
  const options = createdBy ? { createdBy } : {};
  try {
    await vault.saveGroup(input, options);
    return false;
  } catch (error) {
    if (item.type !== 'login' || !item.totp) throw error;
    await vault.saveGroup({ ...input, fields: loginFields(item, false) }, options);
    return true;
  }
}

/** How many new entries an import stored (logins, cards and single values). */
export const storedCount = (result: SecretImportResult): number => result.added + result.cards + result.keys;

/** How many of them came without a description – what the review names and describes. */
export const reviewCount = (result: SecretImportResult): number => storedCount(result) - (result.described ?? 0);

/** What the reviewer is asked to do (also the agent tool's follow-up). */
export function reviewBrief(result: SecretImportResult): string {
  const total = storedCount(result);
  const described = result.described ?? 0;
  return [
    `The person imported ${total} ${total === 1 ? 'entry' : 'entries'} from ${result.format} into the secrets catalog. secrets.list with text "${result.tag}" lists them (I work in batches). I never see a value; I use each field by its handle.`,
    ...(described ? [`${described} came with their own name and description and stay as they are; the ${total - described} others say "not described" in their description.`] : []),
    `1. I give every ${described ? 'entry without a description' : 'entry'} a clear name (the service, e.g. "GitHub" instead of "github.com"), a description – what the account or key is, what it is for, when to use it, the sign-in page – and tags for the kind of service (e.g. "email", "shopping", "development"): each entry is a section of its route file <route>.md in the folder secrets.list names (the ## heading is its name), so I edit it there. Several logins of one service are told apart by their account – "OpenAI - max@firma.de"; the username field's hint in secrets.list shows it. I look up a site I do not know. Good names and descriptions are how every agent finds the right entry later.`,
    result.differing ? `2. ${result.differing} ${result.differing === 1 ? 'login is' : 'logins are'} tagged "${DIFFERS_TAG}": the same site and username are stored with another password. I find out which one works, describe both and say which one is current.` : '2. No duplicates with a differing password.',
    result.added
      ? '3. I check which logins work: one sign-in per site in my browser with the handles tells me (one site after the other), then I sign out. A second try after a failure can lock an account, and a password reset or an action inside the account is no part of this check. A site that asks for a code sent to the person counts as "works, needs 2FA" – the code itself is not needed for that. I add the tag "checked <date>: works", "checked <date>: works, needs 2FA" or "checked <date>: sign-in failed".'
      : '3. No logins to check.',
    '4. I finish with a short report: how many I described, which logins failed or are outdated.',
  ].join('\n');
}

/** The review task for the top Manager, woken at once (none when every new entry came described, or there is no Manager). */
export function startReview(services: RuntimeServices, result: SecretImportResult): SecretImportResult {
  const total = reviewCount(result);
  if (!total) return result;
  const manager = managerAgent(services.org.list());
  if (!manager) return result;
  const origin = { source: 'secrets-import', label: `Import from ${result.format}` };
  const task = services.tasks.create({
    title: `Sort the ${total} imported ${total === 1 ? 'entry' : 'entries'}`, notes: reviewBrief(result), origin,
    steps: ['Name and describe every imported entry', 'Sort out differing duplicates', 'Check the logins the team will use', 'Report the result'],
    assigneeKind: 'agent', assigneeId: manager.id, createdBy: SYSTEM_ID,
  });
  services.wakes.wake({ agentId: manager.id, reason: 'task', taskId: task.id, coalesceKey: `task:${task.id}`, origin });
  return { ...result, reviewTaskId: task.id, reviewer: manager.name };
}
