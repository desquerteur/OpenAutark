// The Settings pages: ids (used in #/settings/<id>, lib/router.ts holds the same list), titles, icons, the search keywords
// of every row inside (so the nav search finds each setting), the methods a page needs to be useful on this connection
// (a phone lists only the pages it may use; rows inside gate themselves) and the file behind the page (its header's one
// way to open it: settings.json, a folder of the data folder, connectors/mcp.json – "nicht irgendwo versteckt im PC").
// Owns: page order, searchable vocabulary, the gates and the file names. Never: renders or holds values.

import type { MethodName } from '../../shared/api/methods.ts';
import type { IconName } from '../lib/icons.tsx';
import { DEFAULT_SETTINGS_PAGE, type SettingsPage } from '../lib/router.ts';

export interface SectionInfo {
  id: SettingsPage;
  title: string;
  icon: IconName;
  keywords: string[];
  /** Listed only where the session may call every one of these ([] = everywhere). */
  requires: readonly MethodName[];
  /** The file or folder behind the page, relative to the data folder (or the workspace), and how the header names it. */
  file: { path: string; label: string; base?: 'workspace' };
  /** The nav entry's data-tour name (the spotlight tour), when it has one. */
  tour?: string;
}

const SETTINGS_FILE = { path: 'settings.json', label: 'Open settings.json' };

export const SECTIONS: readonly SectionInfo[] = [
  { id: 'general', title: 'General', icon: 'gear-six', file: SETTINGS_FILE, requires: ['settings.update'], keywords: [
    'profile', 'name', 'company', 'photo', 'appearance', 'theme', 'dark', 'light',
    'enter sends', 'send', 'tray', 'close', 'login', 'startup', 'start with windows', 'notifications', 'sound',
    'behavior', 'keep running', 'keep the screen on', 'screen', 'keep awake', 'sleep',
  ] },
  // AF-006: how the agents speak to the person (settings.json `personality`, profile.notes as "About me")
  { id: 'personality', title: 'Personality', icon: 'smiley', file: SETTINGS_FILE, requires: [], tour: 'personality', keywords: [
    'personality', 'tone', 'style', 'voice of the ai', 'casual', 'formal', 'factual', 'friendly', 'direct', 'playful', 'du', 'sie', 'address', 'form of address',
    'language', 'emoji', 'length', 'short', 'detailed', 'custom instructions', 'instructions', 'how the ai should treat me', 'about me', 'notes', 'presets', 'template',
  ] },
  // Listed everywhere (B-078: it holds the former Voice page); its providers and uses show where accounts.detect is allowed.
  { id: 'models', title: 'Models', icon: 'plugs', file: SETTINGS_FILE, requires: [], keywords: [
    'codex', 'claude', 'plan', 'account', 'provider', 'login', 'sign in', 'api key', 'openai', 'anthropic', 'openrouter', 'gemini', 'deepinfra', 'mistral',
    'ollama', 'lm studio', 'llama.cpp', 'local server', 'install', 'limits', 'usage', 'quota', 'cost', 'kimi', 'copilot', 'reset', 'base url', 'endpoint', 'compatible',
    'work', 'decisions', 'decision model', 'embeddings', 'vector', 'speech to text', 'text to speech', 'images', 'video', 'music', 'sound effects', 'this pc', 'download model',
    'set up with ai', 'groq', 'elevenlabs', 'fal', 'best', 'balanced', 'cheaper', 'model choice', 'another account', 'key variable', 'environment variable', 'rename',
    // B-078: the Voice page joined Models
    'voice', 'call', 'realtime', 'dictation', 'dictate', 'microphone', 'speech model', 'parakeet', 'canary', 'fastconformer',
    'reading voice', 'read aloud', 'learned words', 'word list', 'vocabulary', 'speech models', 'remove model',
  ] },
  { id: 'calendar', title: 'Calendar', icon: 'calendar-blank', file: SETTINGS_FILE, requires: ['calendar.sources'], keywords: [
    'calendar', 'calendars', 'connect a calendar', 'google', 'google calendar', 'ics', 'ical', 'subscribe', 'sync', 'reconnect', 'my day', 'working hours',
    'work start', 'work end', 'plan my day', 'morning plan', 'plan at', 'agent runs', 'schedules', 'client id', 'client secret', 'own google app',
  ] },
  { id: 'secrets', title: 'Secrets', icon: 'key', file: { path: 'secrets', label: 'Open the secrets folder' }, requires: ['secrets.list'], keywords: [
    'secrets', 'password', 'passwords', 'api keys', 'tokens', 'cards', 'payment card', 'vault', 'catalog', 'logins', '2fa', 'import passwords', 'handle', '.env', 'env file', 'import keys',
  ] },
  { id: 'apps', title: 'Apps', icon: 'squares-four', file: { path: 'connectors/mcp.json', label: 'Open mcp.json' }, requires: ['apps.list'], keywords: [
    'apps', 'connected apps', 'connections', 'integrations', 'mcp', 'mcp servers', 'notion', 'linear', 'github', 'zapier', 'mail', 'mailbox', 'email', 'reconnect', 'sign in', 'tools', 'add by address', 'token', 'test',
  ] },
  { id: 'skills', title: 'Skills & memory', icon: 'folder', file: { path: 'skills', label: 'Open the skills folder', base: 'workspace' }, requires: ['skills.list'], keywords: [
    'skills', 'skill', 'new skill', 'descriptions', 'memory', 'memories', 'knowledge', 'library', 'open folder', 'modes', 'mode',
  ] },
  { id: 'devices', title: 'Devices', icon: 'monitor', file: SETTINGS_FILE, requires: [], keywords: [
    'this pc', 'remote id', 'connect', 'connect a pc', 'connect a phone', 'connection', 'accept connection requests', 'requests', 'accept', 'devices', 'pairing', 'code', 'qr', 'scan', 'tailscale',
    'phone', 'pwa', 'web app', 'revoke', 'relay', 'meeting server', 'device name', 'nearby', 'invite a colleague',
  ] },
  { id: 'feedback', title: 'Feedback', icon: 'megaphone', file: SETTINGS_FILE, requires: ['feedback.list'], keywords: [
    'feedback', 'report', 'reports', 'bug', 'idea', 'from agents', 'inbox', 'watch how it works', 'tour',
  ] },
  { id: 'about', title: 'About', icon: 'info', file: SETTINGS_FILE, requires: [], keywords: [
    'version', 'update', 'download', 'restart', 'auto-download', 'backup', 'back up to', 'restore', 'data folder', 'autark folder', 'settings.json', 'export', 'chats', 'chat export',
  ] },
];

/** The page of `id`, the first page for anything else. */
export function sectionById(id: string | undefined): SectionInfo {
  return SECTIONS.find((section) => section.id === (id ?? DEFAULT_SETTINGS_PAGE)) ?? SECTIONS[0];
}

/** Pages matching a search text (title or any keyword contains every word), among `sections`. */
export function searchSections(text: string, sections: readonly SectionInfo[] = SECTIONS): SectionInfo[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...sections];
  return sections.filter((section) => {
    const haystack = `${section.title} ${section.keywords.join(' ')}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The pages this session may use, in order. */
export function visibleSections(can: (method: MethodName) => boolean): SectionInfo[] {
  return SECTIONS.filter((section) => section.requires.every(can));
}

/** The page #/settings/<id> shows on this connection: itself where the session may use it, else the first it may. */
export function resolveVisibleSection(id: string | undefined, can: (method: MethodName) => boolean): SectionInfo {
  const wanted = sectionById(id);
  return wanted.requires.every(can) ? wanted : visibleSections(can)[0] ?? wanted;
}
