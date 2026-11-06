// The person's browser (desktop only): native views with no app preload or runtime access. Tabs live in spaces (a page's
// `space`): the global pane shows GLOBAL_SPACE, a chat's tabs show in its area above the messages, an agent's in its area
// on its agent page (the agent keeps it). One shown tab per
// space ('show' puts it on its slot, 'hide' takes it off); <data>/side-tabs.json holds the spaces, panels and shown tabs
// ('layout' and onLayout are the window's way to that file). Tabs come back after a restart (`restored` until shown again
// – main/workspace-tabs.ts); a tab carries its last download (saved to <workspace>/downloads/personal; 'reveal' shows it in
// its folder), its find-in-page count and – when an agent opened it – the agent and the chat (`opener`). An agent's
// `transient` tab is its preview: its next page replaces it until the person uses the page or 'keep's it. 'capture' is
// a picture of a tab's visible page (Send page to chat, Mark a region); 'key' tells the app about a browser shortcut
// pressed inside a page (workspace-browser-keys.ts) or the page menu's Send page to chat; 'history' reads or clears the
// person's history (main/workspace-history.ts). The address field takes an address or a search (omniboxUrl).
// keptAddress is the one rule for an address saved for a restart or the history: no user info, no token-like query or
// fragment, a credential link as its site only.
// Owns: its IPC contract, URL validation and the kept-address rule. Never: agent browser sessions or credentials.

export const WORKSPACE_BROWSER = {
  command: 'workspace-browser:command', changed: 'workspace-browser:changed', capture: 'workspace-browser:capture', key: 'workspace-browser:key',
  layout: 'workspace-browser:layout', layoutChanged: 'workspace-browser:layout-changed', history: 'workspace-browser:history',
} as const;
export interface BrowserBounds { x: number; y: number; width: number; height: number }

/**
 * Where the person works; any AI may use it. A chat's space ('chat:<id>') holds the tabs shared by everyone in that chat,
 * an agent's ('agent:<id>') its own area, shown on its agent page.
 */
export const GLOBAL_SPACE = 'global';
export const chatSpace = (chatId: string): string => `chat:${chatId}`;
export const agentSpace = (agentId: string): string => `agent:${agentId}`;
export const isSpace = (value: unknown): value is string => typeof value === 'string' && /^(?:global|(?:chat|agent):[\w.:-]{1,128})$/.test(value);
/**
 * One entry of <data>/side-tabs.json: a website `{id, url, by?}` or one of the app's panels `{id, panel, …what it shows}`.
 * B-076: a panel that shows something of another linked PC names it in `device` – a file, folder or media item by path
 * keeps its form ('file@<device>:<path>', pathTabId), a website of that PC is `{id: remoteTabId, panel: 'remote',
 * device, tab: <its web-… id there>, url, title?}`; without `device` it is this PC's.
 */
export interface SideEntry { id: string; url?: string; by?: string; panel?: string; device?: string; [field: string]: unknown }
/** A panel's id for a path: its kind and the path, and the PC when it is another one ('file@<device>:<path>'). */
export const pathTabId = (kind: string, key: string, device?: string): string => (device ? `${kind}@${device}:${key}` : `${kind}:${key}`);
/** The id of PC `device`'s website `tab` shown elsewhere (another PC, a phone). */
export const remoteTabId = (device: string, tab: string): string => `remote:${device}:${tab}`;
export interface SideSpace { shown?: string; tabs: SideEntry[] }
/** The tabs of every space, as side-tabs.json holds them. */
export type SideSpaces = Record<string, SideSpace>;

/** The tab's last download (saved to <workspace>/downloads/personal). */
export interface TabDownload { name: string; state: 'saving' | 'saved' | 'failed' }
/** The agent that opened a tab, and the chat it worked for (after a restart agentName may be empty: its id still names it). */
export interface PageOpener { agentId: string; agentName: string; chatId?: string }
export interface WorkspaceBrowserPage {
  id: string; url: string; title: string; loading: boolean; back: boolean; forward: boolean; error?: string;
  /** The space it lives in (GLOBAL_SPACE, a chat's or an agent's). */
  space: string;
  /** The page's icon as a small data: picture (main/workspace-favicon.ts), once a loaded page named one. */
  favicon?: string;
  /** Saved before the last restart, or given up by the memory saver – it loads when shown. */
  restored?: boolean;
  download?: TabDownload;
  /** Find in page – the shown match (1-based, 0 = none) and how many there are. */
  find?: { active: number; matches: number };
  /** Opened in the background (Ctrl/middle click, an agent's page): it does not take the selection. */
  background?: boolean;
  opener?: PageOpener;
  /** Playing sound now, and muted by the person. */
  audible?: boolean;
  muted?: boolean;
  /** The page's zoom in percent when it is not 100. */
  zoom?: number;
  /** An agent's preview tab (see the header); not kept over a restart. */
  transient?: true;
}
/** A browser shortcut pressed inside a page that the app acts on, or the page menu's Send page to chat (`url`). */
export type BrowserKeyAction = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | 'address' | 'find' | 'history' | 'send-page';
export interface BrowserKeyEvent { id: string; action: BrowserKeyAction; url?: string }
/** One page of the person's history: its last title and visit, how often it was shown. */
export interface HistoryEntry { url: string; title: string; at: number; visits: number }
/** What the window asks of the history: a search (newest first), or `clear`. */
export interface HistoryRequest { query?: string; limit?: number; clear?: boolean }
export type WorkspaceBrowserCommand =
  | { action: 'list' }
  | { action: 'open'; id: string; url: string; space?: string }
  /** The window's panels, order and shown tabs of every space. */
  | { action: 'layout'; spaces: SideSpaces }
  | { action: 'close'; id: string }
  /** The tab shown in its space, on its slot (it takes the place of the space's tab shown before), or taken off it. */
  | { action: 'show'; id: string; bounds: BrowserBounds }
  | { action: 'hide'; id: string }
  /** An agent's preview tab stays as a tab of its own. */
  | { action: 'keep'; id: string }
  | { action: 'back' | 'forward' | 'reload' | 'stop'; id: string }
  /** Show the tab's last download in its folder. */
  | { action: 'reveal'; id: string }
  /** The keyboard back to the page. */
  | { action: 'focus'; id: string }
  /** Find `text` in the page (`next`: the next match of the same text, `forward` false: backwards); 'find-stop' ends it. */
  | { action: 'find'; id: string; text: string; next?: boolean; forward?: boolean }
  | { action: 'find-stop'; id: string }
  /** One zoom step in (1) or out (-1), or back to 100 % (0); the site keeps it. */
  | { action: 'zoom'; id: string; step: 1 | -1 | 0 }
  /** Sound off or on again; DevTools open or shut. */
  | { action: 'mute' | 'devtools'; id: string }
  /** The tab closed last in `space` opens again. */
  | { action: 'reopen'; space: string };
/** A picture of a tab's visible page: JPEG, and the viewport's size in CSS px. */
export interface WorkspaceCapture { id: string; url: string; host: string; dataUrl: string; width: number; height: number }
export interface WorkspaceBrowserApi {
  command(command: WorkspaceBrowserCommand): Promise<WorkspaceBrowserPage[]>;
  onChanged(listener: (pages: WorkspaceBrowserPage[]) => void): () => void;
  /** The spaces as side-tabs.json holds them. */
  layout(): Promise<SideSpaces>;
  /** The file was changed from outside (an AI, an editor). */
  onLayout(listener: (spaces: SideSpaces) => void): () => void;
  /** The visible page of a loaded tab (Send page to chat). */
  capture(id: string): Promise<WorkspaceCapture>;
  /** The person's history, newest first (a search), or cleared. */
  history(request: HistoryRequest): Promise<HistoryEntry[]>;
  /** A browser shortcut pressed inside a page, or Send page to chat (main moved the keyboard to the app first). */
  onKey?(listener: (event: BrowserKeyEvent) => void): () => void;
}

/** Where a search goes (Chrome's default engine). */
export const SEARCH_URL = 'https://www.google.com/search?q=';

/**
 * What the address field opens – an address (browserUrl's rules: http(s), no credentials) or,
 * for words, a search. Text with a scheme stays an address (so "file:…" is refused, never searched);
 * "?" first forces a search; spaces, no dot and no port (one word), or an "@" (a mail address) search.
 */
export function omniboxUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new Error('Enter a website address or search.');
  const search = () => `${SEARCH_URL}${encodeURIComponent(text.replace(/^\?\s*/, '')).replace(/%20/g, '+')}`;
  if (text.startsWith('?')) return search();
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/]+:\d+(?:\/|$)/.test(text);
  if (scheme) return browserUrl(text);
  const host = text.split(/[/?#]/)[0] ?? '';
  const hostLike = !/\s/.test(text) && !host.includes('@') && (/^localhost(?::\d+)?$/i.test(host) || /^\[[\da-f:]+\](?::\d+)?$/i.test(host) || /^[^.:\s]+(?:\.[^.:\s]+)+(?::\d+)?$/.test(host) || /^[^.:\s]+:\d+$/.test(host));
  return hostLike ? browserUrl(text) : search();
}

export function browserUrl(input: string): string {
  const text = input.trim();
  if (!text || text.length > 8192) throw new Error('Enter a website address.');
  const url = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/]+:\d+(?:\/|$)/.test(text) ? text : `https://${text}`;
  if (!/^https?:\/\/[^/?#@\s\\]+(?:[/?#][^\s\\]*)?$/i.test(url)) throw new Error('Use an HTTP or HTTPS address without credentials.');
  return url;
}

/** The WHATWG URL parts keptAddress uses (shared has no DOM or Node types; every layer's runtime has the global). */
interface AddressParts { protocol: string; username: string; password: string; pathname: string; search: string; hash: string; readonly origin: string; readonly href: string }
declare const URL: new (input: string) => AddressParts;

/** Query or fragment parameters that make an address a secret (OAuth callbacks, signed links, session ids). */
const SECRET_PARAM = /(?:^|[?&#;])(?:[\w.-]*(?:token|secret|password|passwd|pwd|session|sessionid|sid|auth|apikey|api_key|key|code|sig|signature|credential|otp|state|nonce))=/i;

/**
 * A path that carries a one-time credential or an account step (password reset, magic sign-in,
 * e-mail verification, invitations, OAuth callbacks, '/token/…'): such an address is kept as its site only.
 */
const AUTH_PATH = /(?:^|[/_.-])(?:(?:reset|verif|confirm|magic|invit|log-?in|sign-?in|sign-?up|activat|passw|oauth|callback|unsubscribe|one-?time)[a-z-]*|auth|sso|otp|mfa|2fa|tokens?|jwt)(?=$|[/_.-])/i;
/** A path segment that looks like a token itself: a JWT, or a long opaque run (64+ characters with digits). */
const TOKEN_SEGMENT = /(?:^|\/)(?:eyJ[\w-]{8,}\.[\w-]{8,}|(?=[\w-]*\d)[\w-]{64,})(?=$|[/.])/;

/** The address as it may leave its tab (see the header), or undefined when it is not one to keep. */
export function keptAddress(raw: string): string | undefined {
  let url: AddressParts;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.username = '';
  url.password = '';
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
  if (AUTH_PATH.test(path) || TOKEN_SEGMENT.test(path)) return `${url.origin}/`; // review fix 23.10.2026: tokens in the path
  if (SECRET_PARAM.test(url.search) || SECRET_PARAM.test(url.hash.replace(/^#/, '#&'))) { url.search = ''; url.hash = ''; }
  const out = url.href;
  return out.length <= 8192 ? out : undefined;
}
