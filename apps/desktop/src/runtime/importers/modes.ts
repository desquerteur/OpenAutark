// The mode an agent from a team pattern starts in (patterns/library.ts): a mode key the source names, else the first mode whose
// words appear in its name, role or goal, else 'general'. Manager mode (org powers) is never
// guessed from words – a "lead" or "coordinator" stays general. A mode with powers (manager,
// computer, or one that needs frontier models) is never preselected from an imported
// source (a picked file, a URL pattern) either: it falls back to 'general' with a report line, and
// the person or the AI chooses it later when wanted.
// Owns: these word lists and the power-mode rule. Never: invents modes this app does not have.

const WORDS: ReadonlyArray<[string, RegExp]> = [
  ['research', /\b(research|analy[sz]|investigat|market study|scout|fact[- ]check)/i],
  ['video', /\b(video|cutting|youtube|animation|motion graphics|film)/i],
  ['web', /\b(web|developer|frontend|backend|full[- ]?stack|engineer|programm|coder|code review|software|devops|qa|test)/i],
  ['writing', /\b(writ|copy|content|blog|editor|author|journalist|newsletter|translat)/i],
  ['social', /\b(social|instagram|tiktok|linkedin|community|influenc)/i],
  ['finance', /\b(financ|bookkeep|accounting|invoice|tax|controller)/i],
  ['secretary', /\b(secretary|assistant|calendar|scheduling|inbox)/i],
  ['browser', /\b(browser|web scraping|scrap)/i],
  ['computer', /\b(desktop automation|computer use)/i],
];

/** Modes with powers over the org, the app or the computer. */
export const POWER_MODES: ReadonlySet<string> = new Set(['manager', 'computer']);

/** The installed modes with their minimum tier (a failing mode list leaves 'general'). */
export function modeTiers(list: () => ReadonlyArray<{ key: string; minTier?: string }>): Map<string, string | undefined> {
  try { return new Map(list().map((mode) => [mode.key, mode.minTier])); } catch { return new Map([['general', undefined]]); }
}

/**
 * `mode` for an agent from an imported source: a power mode (or one that needs frontier models)
 * becomes 'general' and `dropped` says so – the person can still choose it in the proposal.
 */
export function importedMode(name: string, mode: string, tiers: ReadonlyMap<string, string | undefined>, dropped: string[]): string {
  if (!POWER_MODES.has(mode) && tiers.get(mode) !== 'frontier') return mode;
  dropped.push(`${name}: mode "${mode}" is not preselected from an imported source – choose it in the proposal if you want it`);
  return tiers.has('general') ? 'general' : [...tiers.keys()].find((key) => !POWER_MODES.has(key) && tiers.get(key) !== 'frontier') ?? 'general';
}

export function guessMode(hint: string, modes: ReadonlySet<string>): string {
  const text = hint.trim();
  const named = /^\s*([a-z][a-z0-9-]{1,63})\b/.exec(text.toLowerCase())?.[1];
  if (named && modes.has(named)) return named;
  for (const [mode, words] of WORDS) if (modes.has(mode) && mode !== 'manager' && words.test(text)) return mode;
  return modes.has('general') ? 'general' : [...modes][0] ?? 'general';
}
