// B-053 track D: one mailbox over IMAP as the mail tools use it – a lazily (re)opened, logged-in connection; folders
// with their special use (RFC 6154 attributes, else well-known names in several languages); stable message ids
// '<folder>/<uidvalidity>/<uid>'; search, fetch, append, move (MOVE, else COPY + \Deleted + UID EXPUNGE), flags,
// create, delete (to Trash; in Trash for good). A refusal the agent can act on is a MailError (a tool error).
// Owns: that mailbox state. Never: keeps the password (asks target.login() per connection), logs a message.

import type { MailTarget } from '../types.ts';
import { ImapClient, ImapCommandError, type ImapOptions, type ImapResult } from './imap.ts';
import { astring, decodeMailboxName, fetchMap, flagsOf, mailboxArg, str, type ImapArg, type ImapValue } from './imap-parse.ts';
import type { MailSockets } from './socket.ts';

export type SpecialUse = 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';
export interface Folder { name: string; wire: string; delimiter?: string; use?: SpecialUse; selectable: boolean }

/** A refusal or a mistake the agent can correct (shown as the tool's error text). */
export class MailError extends Error { constructor(message: string) { super(message); this.name = 'MailError'; } }

const ATTR_USE: Record<string, SpecialUse> = { '\\DRAFTS': 'drafts', '\\SENT': 'sent', '\\TRASH': 'trash', '\\JUNK': 'junk', '\\ARCHIVE': 'archive', '\\ALL': 'all', '\\FLAGGED': 'flagged' };
const NAME_USE: Array<[SpecialUse, RegExp]> = [
  ['drafts', /^(drafts?|entw(ü|ue)rfe|brouillons|borradores|bozze|concepten)$/i],
  ['sent', /^(sent|sent items|sent messages|sent mail|gesendet|gesendete (objekte|elemente|nachrichten)|envoy(é|e)s|enviados|inviata|verzonden)$/i],
  ['trash', /^(trash|deleted|deleted items|deleted messages|bin|papierkorb|gel(ö|oe)scht|gel(ö|oe)schte (objekte|elemente)|corbeille|papelera|cestino|prullenbak)$/i],
  ['junk', /^(junk|junk e-?mail|spam|bulk mail|spamverdacht|unerw(ü|ue)nscht|courrier ind(é|e)sirable)$/i],
  ['archive', /^(archive|archives|archiv|archivo|archivio|archief)$/i],
];
const ALIASES: Record<string, SpecialUse> = { inbox: 'inbox', drafts: 'drafts', draft: 'drafts', sent: 'sent', trash: 'trash', bin: 'trash', deleted: 'trash', junk: 'junk', spam: 'junk', archive: 'archive', 'all mail': 'all' };

export interface MessageRef { folder: Folder; uidValidity: number; uid: number }
export const messageId = (folder: string, uidValidity: number, uid: number): string => `${folder}/${uidValidity}/${uid}`;

export function parseMessageId(id: unknown): { folder: string; uidValidity: number; uid: number } {
  const m = typeof id === 'string' ? /^(.+)\/(\d{1,10})\/(\d{1,10})$/.exec(id) : null;
  if (!m) throw new MailError('That is not a message id from search (folder/uidvalidity/uid).');
  return { folder: m[1], uidValidity: Number(m[2]), uid: Number(m[3]) };
}

const codeOf = (result: ImapResult, name: string): string | undefined =>
  [result.code, ...result.untagged.map((u) => u.code)].find((c) => c?.toUpperCase().startsWith(`${name} `));

export class Mailbox {
  private client: ImapClient | undefined;
  private opening: Promise<ImapClient> | undefined;
  private folderList: Folder[] | undefined;
  private selected: { wire: string; uidValidity: number } | undefined;
  /** One tool action at a time (B-053 fix): SELECT and the UID commands after it never interleave with another's. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly target: MailTarget;
  private readonly opts: { sockets?: MailSockets; timeoutMs?: number };

  constructor(target: MailTarget, opts: { sockets?: MailSockets; timeoutMs?: number } = {}) {
    this.target = target;
    this.opts = opts;
  }

  /** The logged-in connection (opened again after a drop). */
  imap(): Promise<ImapClient> {
    if (this.client?.isOpen) return Promise.resolve(this.client);
    this.opening ??= (async () => {
      const options: ImapOptions = { sockets: this.opts.sockets, timeoutMs: this.opts.timeoutMs };
      const client = await ImapClient.open(this.target.imap, options);
      try {
        const { user, password } = await this.target.login();
        await client.login(user, password);
      } catch (error) { client.destroy(); throw error; }
      this.client = client;
      this.selected = undefined;
      return client;
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  async run(parts: ImapArg[]): Promise<ImapResult> {
    const client = await this.imap();
    try { return await client.command(parts); } catch (error) {
      if (error instanceof ImapCommandError) throw new MailError(`The mail server said no: ${error.message}`);
      throw error;
    }
  }

  get caps(): Set<string> { return this.client?.caps ?? new Set(); }

  async folders(refresh = false): Promise<Folder[]> {
    if (this.folderList && !refresh) return this.folderList;
    const client = await this.imap();
    const extended = client.has('LIST-EXTENDED') && client.has('SPECIAL-USE');
    const result = await this.run(extended ? ['LIST "" "*" RETURN (SPECIAL-USE)'] : ['LIST "" "*"']);
    const list: Folder[] = [];
    const leaves = new Map<Folder, string>();
    for (const u of result.untagged) {
      if (u.type !== 'LIST' || list.length >= 1000) continue;
      const [attrs, delimiter, rawName] = u.values as [ImapValue, ImapValue, ImapValue];
      const wire = str(rawName);
      if (!wire) continue;
      const flags = flagsOf(attrs).map((f) => f.toUpperCase());
      const name = decodeMailboxName(wire);
      const leaf = name.split(str(delimiter) ?? '/').pop() ?? name;
      const use = wire.toUpperCase() === 'INBOX' ? 'inbox' : flags.map((f) => ATTR_USE[f]).find(Boolean);
      const folder: Folder = { name: wire.toUpperCase() === 'INBOX' ? 'INBOX' : name, wire, delimiter: str(delimiter), use, selectable: !flags.includes('\\NOSELECT') && !flags.includes('\\NONEXISTENT') };
      list.push(folder);
      if (!use) leaves.set(folder, leaf);
    }
    // A name guess only where no folder has that use by its attribute (the first matching name wins).
    for (const [folder, leaf] of leaves) {
      const guess = NAME_USE.find(([, re]) => re.test(leaf))?.[0];
      if (guess && folder.selectable && !list.some((f) => f.use === guess)) folder.use = guess;
    }
    this.folderList = list;
    return list;
  }

  async special(use: SpecialUse): Promise<Folder | undefined> {
    return (await this.folders()).find((f) => f.use === use && f.selectable);
  }

  /** A folder by its name (any case) or a word for its use ("trash", "spam", "archive" …). */
  async folder(name: string): Promise<Folder> {
    const folders = await this.folders();
    const wanted = name.trim();
    const exact = folders.find((f) => f.name === wanted) ?? folders.find((f) => f.name.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
    const alias = ALIASES[wanted.toLowerCase()];
    const byUse = alias && (folders.find((f) => f.use === alias) ?? (alias === 'archive' ? folders.find((f) => f.use === 'all') : undefined));
    if (byUse) return byUse;
    throw new MailError(`There is no folder "${wanted.slice(0, 80)}" – call folders for the list.`);
  }

  /** Runs `fn` alone on this mailbox: every tool action is one unit, so a SELECT of another call cannot move it. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async select(folder: Folder): Promise<number> {
    if (this.selected?.wire === folder.wire && this.client?.isOpen) return this.selected.uidValidity;
    this.selected = undefined; // a failed SELECT deselects the current folder (RFC 3501 6.3.1)
    let result: ImapResult;
    try { result = await this.run(['SELECT', astring(folder.wire)]); } catch (error) {
      if (error instanceof ImapCommandError || error instanceof MailError) this.folderList = undefined; // e.g. the folder is gone: list again next time
      throw error;
    }
    const validity = Number(/^UIDVALIDITY (\d+)/i.exec(codeOf(result, 'UIDVALIDITY') ?? '')?.[1] ?? 0);
    this.selected = { wire: folder.wire, uidValidity: validity };
    return validity;
  }

  /** Selects the message's folder and checks the id is still valid there. */
  async locate(id: unknown): Promise<MessageRef> {
    const parsed = parseMessageId(id);
    const folder = await this.folder(parsed.folder);
    const uidValidity = await this.select(folder);
    if (uidValidity !== parsed.uidValidity) throw new MailError('This message id is out of date (the folder was rebuilt) – search again.');
    return { folder, uidValidity, uid: parsed.uid };
  }

  async searchUids(criteria: ImapArg[]): Promise<number[]> {
    const utf8 = criteria.some((c) => typeof c !== 'string');
    const result = await this.run(['UID SEARCH', ...(utf8 ? ['CHARSET UTF-8'] : []), ...(criteria.length ? criteria : ['ALL'])]);
    const uids: number[] = [];
    for (const u of result.untagged) if (u.type === 'SEARCH') for (const v of u.values) { const n = Number(str(v)); if (Number.isInteger(n) && n > 0) uids.push(n); }
    return uids;
  }

  /** UID FETCH rows by uid. */
  async fetch(uids: number[], items: string): Promise<Map<number, Map<string, ImapValue>>> {
    const out = new Map<number, Map<string, ImapValue>>();
    if (!uids.length) return out;
    const result = await this.run([`UID FETCH ${uids.join(',')} (UID ${items})`]);
    for (const u of result.untagged) {
      if (u.type !== 'FETCH') continue;
      const row = fetchMap(u.values);
      const uid = Number(str(row.get('UID')));
      if (uid) out.set(uid, row);
    }
    return out;
  }

  /** APPEND into a folder; the new id when the server tells it (UIDPLUS). */
  async append(folder: Folder, raw: Buffer, flags: string[]): Promise<string | undefined> {
    const result = await this.run(['APPEND', astring(folder.wire), `(${flags.join(' ')})`, { literal: raw }]);
    const m = /^APPENDUID (\d+) (\d+)$/i.exec(codeOf(result, 'APPENDUID') ?? '');
    this.selected = this.selected?.wire === folder.wire ? undefined : this.selected;
    return m ? messageId(folder.name, Number(m[1]), Number(m[2])) : undefined;
  }

  async store(ref: MessageRef, op: '+' | '-', flags: string[]): Promise<void> {
    await this.run([`UID STORE ${ref.uid} ${op}FLAGS.SILENT (${flags.join(' ')})`]);
  }

  /** Moves a message; the new id when the server tells it. */
  async move(ref: MessageRef, to: Folder): Promise<string | undefined> {
    if (to.wire === ref.folder.wire) return messageId(ref.folder.name, ref.uidValidity, ref.uid);
    const dest = astring(to.wire);
    let result: ImapResult;
    if (this.caps.has('MOVE')) {
      result = await this.run([`UID MOVE ${ref.uid}`, dest]);
    } else {
      result = await this.run([`UID COPY ${ref.uid}`, dest]);
      await this.store(ref, '+', ['\\Deleted']);
      if (this.caps.has('UIDPLUS')) await this.run([`UID EXPUNGE ${ref.uid}`]);
    }
    const m = /^COPYUID (\d+) \S+ (\d+)$/i.exec(codeOf(result, 'COPYUID') ?? '');
    return m ? messageId(to.name, Number(m[1]), Number(m[2])) : undefined;
  }

  /** Removes a message for good (it is in Trash already, or there is no Trash). */
  async expunge(ref: MessageRef): Promise<boolean> {
    await this.store(ref, '+', ['\\Deleted']);
    if (!this.caps.has('UIDPLUS')) return false;
    await this.run([`UID EXPUNGE ${ref.uid}`]);
    return true;
  }

  async create(name: string): Promise<Folder> {
    const folders = await this.folders();
    const delimiter = folders.find((f) => f.delimiter)?.delimiter ?? '/';
    const wanted = name.trim().replace(/[\r\n]/g, '').split('/').join(delimiter);
    if (!wanted || wanted.length > 200) throw new MailError('Give the folder a name (up to 200 characters).');
    if (folders.some((f) => f.name.toLowerCase() === wanted.toLowerCase())) throw new MailError(`The folder "${wanted}" exists already.`);
    try {
      await this.run(['CREATE', mailboxArg(wanted)]);
    } catch (error) {
      // Servers with an "INBOX." namespace (Courier, some Dovecot setups) want new folders under INBOX.
      if (!(error instanceof MailError) || delimiter !== '.' || wanted.toUpperCase().startsWith('INBOX.')) throw error;
      await this.run(['CREATE', mailboxArg(`INBOX.${wanted}`)]);
    }
    const created = (await this.folders(true)).find((f) => f.name.toLowerCase() === wanted.toLowerCase() || f.name.toLowerCase() === `inbox.${wanted.toLowerCase()}`);
    return created ?? { name: wanted, wire: wanted, delimiter, selectable: true };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.logout();
  }
}
