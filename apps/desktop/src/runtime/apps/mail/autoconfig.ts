// B-053 track D: finding a mailbox's IMAP and SMTP servers from its address – shipped presets (Gmail, iCloud, Yahoo,
// GMX, web.de, Fastmail, Proton Bridge), an honest "not yet" for Outlook.com / Microsoft 365 (password logins over
// IMAP are switched off there; only Microsoft's own sign-in works), then Mozilla's ISPDB
// (autoconfig.thunderbird.net), the domain's own autoconfig file, and last the domain's MX host (Google Workspace,
// Microsoft 365, or the ISPDB entry of the MX provider). Only encrypted servers with a password login are taken.
// Owns: these lookups (fetched XML is untrusted: only host names, ports and socket types are read). Never: sends the
// address itself anywhere – only its domain is looked up.

import { resolveMx as dnsResolveMx } from 'node:dns/promises';
import type { MailServer } from '../../../shared/model/apps.ts';

export interface MailConfig { imap: MailServer; smtp: MailServer; note?: string; /** Login name when it is not the address. */ user?: string }
export type MailConfigResult = MailConfig | { unsupported: string };
export type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

export const MICROSOFT_UNSUPPORTED = 'Outlook and Microsoft 365 allow mail access only through Microsoft sign-in, which is not built yet.';
const APP_PASSWORD = 'Use an app password, not the account password.';

const imap = (host: string, port = 993, tls: MailServer['tls'] = 'implicit'): MailServer => ({ host, port, tls });

const GMAIL: MailConfig = { imap: imap('imap.gmail.com'), smtp: imap('smtp.gmail.com', 465), note: 'Gmail needs an app password: turn on 2-Step Verification, then create one under Google Account › Security › App passwords.' };
const PRESETS: Array<{ domains: string[]; config: MailConfig }> = [
  { domains: ['gmail.com', 'googlemail.com'], config: GMAIL },
  { domains: ['icloud.com', 'me.com', 'mac.com'], config: { imap: imap('imap.mail.me.com'), smtp: imap('smtp.mail.me.com', 587, 'starttls'), note: 'iCloud needs an app-specific password (Apple Account › Sign-In and Security › App-Specific Passwords).' } },
  { domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.de', 'yahoo.co.uk', 'yahoo.fr'], config: { imap: imap('imap.mail.yahoo.com'), smtp: imap('smtp.mail.yahoo.com', 465), note: `Yahoo needs an app password (Account security › Generate app password).` } },
  { domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'], config: { imap: imap('imap.gmx.net'), smtp: imap('mail.gmx.net', 587, 'starttls'), note: 'Turn on "POP3/IMAP access" in the GMX settings first.' } },
  { domains: ['web.de'], config: { imap: imap('imap.web.de'), smtp: imap('smtp.web.de', 587, 'starttls'), note: 'Turn on "POP3/IMAP access" in the WEB.DE settings first.' } },
  { domains: ['fastmail.com', 'fastmail.fm'], config: { imap: imap('imap.fastmail.com'), smtp: imap('smtp.fastmail.com', 465), note: `Fastmail needs an app password (Settings › Privacy & Security › App passwords).` } },
  { domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'], config: { imap: imap('127.0.0.1', 1143, 'starttls'), smtp: imap('127.0.0.1', 1025, 'starttls'), note: 'Proton Mail works through Proton Mail Bridge on this computer: start the Bridge and use the password it shows.' } },
];

const MICROSOFT = /^(outlook|hotmail|live|msn|windowslive|passport)\.[a-z]{2,3}(\.[a-z]{2})?$/;
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_XML = 256 * 1024;

export function domainOf(address: string): string | undefined {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(address.trim());
  const domain = m?.[1].toLowerCase().replace(/\.$/, '');
  return domain && DOMAIN.test(domain) ? domain : undefined;
}

export function presetFor(domain: string): MailConfigResult | undefined {
  if (MICROSOFT.test(domain)) return { unsupported: MICROSOFT_UNSUPPORTED };
  return PRESETS.find((p) => p.domains.includes(domain))?.config;
}

const tagText = (block: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(block)?.[1];

function serverOf(block: string, address: string, domain: string): (MailServer & { user?: string }) | undefined {
  const local = address.split('@')[0];
  const host = tagText(block, 'hostname')?.replace(/%EMAILDOMAIN%/g, domain).toLowerCase();
  const port = Number(tagText(block, 'port'));
  const socket = tagText(block, 'socketType')?.toUpperCase();
  const auths = [...block.matchAll(/<authentication>\s*([^<]*?)\s*<\/authentication>/gi)].map((m) => m[1].toLowerCase());
  if (!host || !DOMAIN.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (socket !== 'SSL' && socket !== 'STARTTLS') return undefined; // never unencrypted
  if (auths.length && !auths.some((a) => a === 'password-cleartext' || a === 'password-encrypted' || a === 'plain')) return undefined;
  const username = tagText(block, 'username');
  const user = username === '%EMAILLOCALPART%' ? local : undefined;
  return { host, port, tls: socket === 'SSL' ? 'implicit' : 'starttls', ...(user ? { user } : {}) };
}

/** A Thunderbird autoconfig document (clientConfig 1.1) → the first usable IMAP and SMTP servers. */
export function parseAutoconfigXml(xml: string, address: string): MailConfig | undefined {
  const domain = domainOf(address) ?? '';
  const pick = (re: RegExp) => {
    for (const m of xml.matchAll(re)) { const s = serverOf(m[1], address, domain); if (s) return s; }
    return undefined;
  };
  const inbound = pick(/<incomingServer\s+type\s*=\s*["']imap["'][^>]*>([\s\S]*?)<\/incomingServer>/gi);
  const outbound = pick(/<outgoingServer\s+type\s*=\s*["']smtp["'][^>]*>([\s\S]*?)<\/outgoingServer>/gi);
  if (!inbound || !outbound) return undefined;
  const { user, ...imapServer } = inbound;
  const { user: _smtpUser, ...smtpServer } = outbound;
  return { imap: imapServer, smtp: smtpServer, ...(user ? { user } : {}) };
}

async function fetchXml(url: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow', headers: { accept: 'application/xml, text/xml' } });
    if (!response.ok) return undefined;
    if (response.url && !response.url.startsWith('https:')) return undefined;
    const text = await response.text();
    return text.length > MAX_XML ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Second-level public suffixes under a country code (B-053 fix: a short provider label such as web.de, gmx.de is
 *  no suffix – the old length rule kept 'mx-ha03.web.de' whole). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gv', 'ltd', 'plc', 'me', 'nom']);

/** The registrable part of a host, roughly (mx1.mail.ionos.de → ionos.de; mx.example.co.uk → example.co.uk). */
export function baseDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const keep = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** A preset whose domain the MX host lies in (mx00.gmx.net → GMX), before the registrable-part guess. */
function presetByMx(mx: string): MailConfig | undefined {
  return PRESETS.find((p) => p.domains.some((d) => mx === d || mx.endsWith(`.${d}`)))?.config;
}

async function lookup(domain: string, address: string, fetchFn: typeof fetch): Promise<MailConfig | undefined> {
  for (const url of [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ]) {
    const xml = await fetchXml(url, fetchFn);
    const config = xml ? parseAutoconfigXml(xml, address) : undefined;
    if (config) return config;
  }
  return undefined;
}

/** The servers for `address`, or why there are none to offer. */
export async function mailAutoconfig(address: string, fetchFn: typeof fetch = (i, o) => fetch(i, o), resolveMx: MxResolver = dnsResolveMx): Promise<MailConfigResult> {
  const domain = domainOf(address);
  if (!domain) return { unsupported: 'That is not an email address.' };
  const preset = presetFor(domain);
  if (preset) return preset;
  const found = await lookup(domain, address, fetchFn);
  if (found) return { ...found, note: APP_PASSWORD };
  let mx: string | undefined;
  try {
    mx = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0]?.exchange.toLowerCase().replace(/\.$/, '');
  } catch { mx = undefined; }
  if (mx) {
    if (/(^|\.)(google\.com|googlemail\.com)$/.test(mx)) return { ...GMAIL, note: `${GMAIL.note} (Google Workspace)` };
    if (/(^|\.)(outlook\.com|office365\.us|microsoft\.com)$/.test(mx)) return { unsupported: MICROSOFT_UNSUPPORTED };
    const preset = presetByMx(mx);
    if (preset) return { ...preset, note: preset.note ?? APP_PASSWORD };
    const provider = baseDomain(mx);
    if (provider !== domain && DOMAIN.test(provider)) {
      const byMx = presetFor(provider) ?? await lookup(provider, address, fetchFn);
      if (byMx && !('unsupported' in byMx)) return { ...byMx, note: byMx.note ?? APP_PASSWORD };
      if (byMx) return byMx;
    }
  }
  return { unsupported: `No mail server settings were found for ${domain} – enter the IMAP and SMTP servers yourself.` };
}
