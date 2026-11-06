// Several companies on one PC (B-072, owner 04.11.2026: "das sind nicht Accounts bei uns, sondern ... einfach neue Firmen"):
// a company is one data folder with its own chats, agents, settings, secrets and linked devices. The first is the app's
// own folder; every other one lies in "<first> Companies/<id>" beside it. companies.list names them; companies.open
// switches: that company's window opens (it starts when it does not run) and this one goes to the tray, its agents keep
// working. A new company starts with the normal first run; joining another company as employee or CEO is connecting
// to that company's PC (remote.connect). B-075 (owner 04.11.2026, an agent could not find the other company): the company
// asked names its own role and linked PCs in companies.list, and companies.tool runs one agent tool in it for an agent of
// another company on this PC (tools.call with company – runtime/tools/placement.ts); both runtimes reach each other over
// loopback with the owner token of the other's runtime.json (parseRuntimeFile, the same rule in main and runtime).
// Owns: the id rule, the label rule, the runtime.json rule and the three methods' contract. Never: behaviour
// (runtime/root/companies.ts lists and calls, main/companies.ts opens and stops).

/** A company's folder name: lower-case letters, digits and dashes ("company-2"). */
export const COMPANY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Windows device names, which no folder may carry ("con", "nul", "com1" …). */
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;

export function isCompanyId(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_ID.test(value) && !DEVICE_NAME.test(value);
}

/** The person's place in a company: its owner (the CEO), or an employee of another firm whose data it holds (it joined that firm's PC as an employee). */
export type CompanyRole = 'owner' | 'employee';

/**
 * B-078: how a new company from the company menu's "+" starts (main passes it as `--start=`): its own first run ('new'),
 * connected as my other device to a company on another PC ('mine'), or joining a company as an employee ('employee').
 */
export type CompanyStart = 'new' | 'mine' | 'employee';

export function isCompanyStart(value: unknown): value is CompanyStart {
  return value === 'new' || value === 'mine' || value === 'employee';
}

/** One company on this PC; `id` null = the first one (the app's own data folder); `current` = the one asked. */
export interface CompanyEntry {
  id: string | null;
  label: string;
  current: boolean;
  /** B-075: only on the current entry – the person's role there. */
  role?: CompanyRole;
  /** B-075: only on the current entry – its linked PCs (not removed or half-paired) and whether each is online. */
  linkedPcs?: Array<{ name: string; online: boolean }>;
  /** B-078: only on the current entry – how this start was asked for (`--start=`; its first run opens that way). */
  start?: CompanyStart;
}

/** A company's name: profile.company of its settings, else the person's name there, else its folder ("First company"). */
export function companyLabel(profile: { company?: unknown; name?: unknown } | null | undefined, id: string | null): string {
  const pick = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');
  return pick(profile?.company) || pick(profile?.name) || (id ?? 'First company');
}

/** The file a company's runtime writes once it listens: {port, token, pid} (runtime/main.ts). */
export const RUNTIME_FILE = 'runtime.json';

/** runtime.json's text as {port, token, pid} – a port in range and a header-safe token –, else null. */
export function parseRuntimeFile(text: string): { port: number; token: string; pid: number } | null {
  try {
    const { port, token, pid } = JSON.parse(text) as { port?: unknown; token?: unknown; pid?: unknown };
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(token) || typeof pid !== 'number' || !Number.isInteger(pid)) return null;
    return { port, token, pid };
  } catch {
    return null;
  }
}

/** B-075: one agent tool call another company on this PC sends here (its registry checked it there; `from` is its name). */
export interface CompanyToolCall {
  name: string;
  args?: Record<string, unknown>;
  agentId: string;
  agentName?: string;
  runId: string;
  mode?: string;
  from?: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** B-072: the companies on this PC, the first one first; empty where there are none (a test profile, headless). B-075: the current one with its role and linked PCs. */
    'companies.list': { params: void; result: { companies: CompanyEntry[] } };
    /**
     * B-072: switches to a company – id from companies.list, null or none = the first one – or starts a new one (create: true;
     * with an id: that folder name). Its window opens, this one goes to the tray and keeps working. B-078: `start` with
     * create – 'mine' / 'employee' open the new company's first run at connecting to another PC that way.
     */
    'companies.open': { params: { id?: string | null; create?: boolean; start?: CompanyStart }; result: { ok: true; id: string | null } };
    /**
     * B-075: runs one agent tool here for an agent of another company on this PC (tools.call with company) and returns its
     * output, values of this company's secrets masked; refused where the person is an employee of another firm.
     */
    'companies.tool': { params: CompanyToolCall; result: { content: Array<Record<string, unknown>>; isError?: boolean; effect?: { status: 'confirmed' | 'unknown' | 'failed'; externalId?: string } } };
  }
}
