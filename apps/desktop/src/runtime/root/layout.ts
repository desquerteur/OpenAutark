// The open data folder: <data> = Electron userData or WORKFORCE_TEST_DATA (headless: --data). The names of the
// entries a person or an AI reads and edits – each has ONE owner that hears about it through the RootWatcher
// (watcher.ts) – and the app-managed entries the watcher never reports (the database files, blobs, CLI homes,
// logs, scratch, browser profiles, backups, exports and the engine folder). Entries nobody registered
// (Chromium's own caches beside them, runtime.json, boot.json …) are dropped the same way.
// Owns: these names and the path split. Never: reads or writes files, decides what an entry holds.

import { AGENT_CORE_DIR } from '../../shared/model/agent-core.ts';

/** Generated map of the folder: every entry, what it does and how to change it. */
export const ROOT_README = 'README.md';
/** Every setting of the app – the only place they are stored (runtime/settings). */
export const ROOT_SETTINGS = 'settings.json';
/** <id>/agent.json, SYSTEM.md, skills/<name>/SKILL.md (agent-core). */
export const ROOT_AGENTS = AGENT_CORE_DIR;
/** <name>.md overrides of the shipped prompts. */
export const ROOT_PROMPTS = 'prompts';
/** <key>.md own modes. */
export const ROOT_MODES = 'modes';
/** <id>.md secret metadata (never a value or a hash). */
export const ROOT_SECRETS = 'secrets';
/** The tabs of the global pane and of each chat's area above its messages, websites and panels (main/workspace-tabs.ts owns the file). */
export const ROOT_SIDE_TABS = 'side-tabs.json';
/** The person's browsing history (main/workspace-history.ts owns the file). */
export const ROOT_BROWSER_HISTORY = 'browser-history.json';
/** The browser's zoom per site (main/workspace-tab-memory.ts owns the file). */
export const ROOT_BROWSER_ZOOM = 'workspace-zoom.json';
/** The app's look: CSS applied live on top of the app's own styles (root/theme.ts). */
export const ROOT_THEME = 'theme.css';
/** <name>.html|js: views anyone adds, custom tabs of the side pane (root/pages.ts). */
export const ROOT_PAGES = 'pages';

/** The connectors (apps/connectors.ts): mcp.json, mail.json and the app's status.json. */
export const ROOT_CONNECTORS = 'connectors';
/** The derived chat folders (chat-files/mirror.ts) – documented in the README map, deliberately no ROOT_ENTRIES entry. */
export const ROOT_CHATS = 'chats';

/** Every documented entry, in the order the README map lists them. */
export const ROOT_ENTRIES: readonly string[] = [ROOT_README, ROOT_SETTINGS, ROOT_AGENTS, ROOT_PROMPTS, ROOT_MODES, ROOT_SECRETS, ROOT_CONNECTORS, ROOT_THEME, ROOT_PAGES, ROOT_SIDE_TABS, ROOT_BROWSER_HISTORY, ROOT_BROWSER_ZOOM];

/** App-managed entries: never reported, never registered ('db' = workforce.db and its journal files). */
export const EXCLUDED: ReadonlySet<string> = new Set([
  'workforce.db', 'workforce.db-wal', 'workforce.db-shm', 'workforce.db-journal',
  'blobs', 'logs', 'tmp', 'accounts', 'browser-profiles', 'backups', 'exports', 'engine-cwd', 'engine-transcripts',
]);

/** The path a watcher event names, split at either separator (empty parts dropped). */
export function splitRel(rel: string): string[] {
  return rel.split(/[\\/]/).filter(Boolean);
}

/** The key an entry name is looked up by: file names on Windows ignore case. */
export function entryKey(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? name.toLowerCase() : name;
}

/** True for an entry name the watcher never reports. */
export function isExcluded(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return EXCLUDED.has(entryKey(name, platform));
}
