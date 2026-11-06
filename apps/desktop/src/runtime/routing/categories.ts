// Task categories for routing: keyword inference from what a turn is about (English and
// German, the user's languages), the category's default effort and a short label.
// Owns: the keyword table. Categories are exactly CATEGORIES of models/priors.ts.
// Never: calls a model – this is the cheap deterministic first step; a specific mode's category wins.
// B-047 D12: 'manager-planner' (the manager mode) is refined like 'chat': a Manager's chat, research or PC turn
// gets the category of its text (else 'chat'); only a turn without text (model lists) keeps the mode's own category.

import type { Effort } from '../../shared/model/providers.ts';
import { CATEGORIES } from '../models/priors.ts';

export type Category = (typeof CATEGORIES)[number];

/**
 * Keyword groups per category. `words` match whole words, `prefixes` match at a word start
 * ("termin" → "Termine", not "determine"), `parts` match anywhere (German compounds such as
 * "Musikvideo", "Buchhaltungssoftware"; a RegExp part is used as is). Weight 3 = specific;
 * weight 1 = generic: two different ones needed – one generic word repeated is no second hint.
 */
interface KeywordGroup { category: Category; weight: number; words?: string[]; prefixes?: string[]; parts?: Array<string | RegExp> }

const GROUPS: KeywordGroup[] = [
  { category: 'video-animation', weight: 3, parts: ['remotion', 'after effects', 'premiere pro', 'davinci', 'keyframe', 'b-roll', 'footage', 'motion canvas', 'videoschnitt', 'animation', 'video', 'untertitel', 'subtitles'] },
  // "Schneide den Podcast": cutting ("zusammenschneiden") and a podcast together are video work –
  // every form of "schneiden" is one hint, the name or trade "Schneider" none.
  { category: 'video-animation', weight: 1, parts: ['animier', 'animate', /schneid(?!er)/, 'podcast', 'thumbnail'], prefixes: ['render', 'schnitt', 'clip', 'intro', 'outro', 'timeline', 'blender'], words: ['reel', 'reels'] },
  { category: 'frontend-ui', weight: 3, parts: ['frontend', 'front-end', 'landingpage', 'landing page', 'tailwind', 'figma', 'benutzeroberfläche', 'user interface'], words: ['css', 'html', 'ui/ux'] },
  { category: 'frontend-ui', weight: 1, parts: ['website', 'webseite', 'homepage', 'komponente', 'design system', 'dark mode', 'responsive'], words: ['ui', 'ux', 'layout', 'component', 'components'] },
  { category: 'computer-use', weight: 3, parts: ['bildschirm', 'formular ausfüll', 'fill in the form', 'fill out the form', 'on my screen', 'on the screen', 'desktop app'], words: ['click', 'klick', 'klicke', 'mouse', 'maus', 'screenshot'] },
  { category: 'computer-use', weight: 1, parts: ['open the app', 'öffne die app'], words: ['browser', 'fenster', 'window', 'einloggen', 'log in', 'login'] },
  { category: 'research', weight: 3, prefixes: ['recherch', 'research'], parts: ['marktanalyse', 'market analysis'], words: ['literature', 'study', 'studies', 'studie', 'studien', 'sources', 'quellen'] },
  { category: 'research', weight: 1, prefixes: ['compar', 'vergleich', 'analys', 'analyz', 'untersuch', 'investigat'], parts: ['find out', 'finde heraus'], words: ['benchmark'] },
  { category: 'writing', weight: 3, parts: ['blogpost', 'blog post', 'artikel', 'essay', 'drehbuch', 'newsletter', 'ghostwrit', 'copywrit', 'storytelling'] },
  { category: 'writing', weight: 1, prefixes: ['write', 'writing', 'schreib', 'formulier', 'entwurf', 'draft', 'proofread', 'korrektur'], words: ['script', 'skript', 'text'] },
  { category: 'social-media', weight: 3, parts: ['instagram', 'tiktok', 'linkedin', 'twitter', 'social media', 'hashtag', 'caption'], words: ['x.com', 'threads'] },
  { category: 'social-media', weight: 1, prefixes: ['kommentar'], words: ['follower', 'followers', 'post', 'posts', 'posting', 'story', 'stories', 'comment', 'comments', 'community'] },
  { category: 'business-workflows', weight: 3, prefixes: ['rechnung'], parts: ['buchhaltung', 'bookkeeping', 'accounting', 'datev', 'lexoffice', 'bilanz', 'balance sheet', 'invoice', 'steuererklärung'], words: ['tax', 'taxes'] },
  { category: 'business-workflows', weight: 1, prefixes: ['steuer'], parts: ['spreadsheet', 'excel', 'tabelle', 'budget', 'finanz', 'finance', 'revenue', 'umsatz', 'payroll', 'vertrag'], words: ['angebot', 'quote', 'contract'] },
  { category: 'personal-assistant', weight: 3, prefixes: ['termin', 'erinner', 'besorg'], parts: ['kalender', 'calendar', 'appointment', 'remind me', 'errand', 'reservation', 'reservier'] },
  { category: 'personal-assistant', weight: 1, prefixes: ['flug', 'buche'], parts: ['postfach', 'book a'], words: ['email', 'e-mail', 'mail', 'inbox', 'meeting', 'flight', 'hotel', 'doctor', 'arzt'] },
  { category: 'coding', weight: 3, parts: ['typescript', 'javascript', 'python', 'golang', 'stacktrace', 'stack trace', 'refactor', 'unit test', 'pull request', 'compile', 'repository', 'bugfix', 'bug fix', 'programmier'], words: ['rust', 'git', 'npm'] },
  { category: 'coding', weight: 1, parts: ['exception', 'database', 'datenbank'], words: ['code', 'coding', 'api', 'bug', 'bugs', 'debug', 'function', 'sql', 'endpoint'] },
  { category: 'manager-planner', weight: 3, prefixes: ['delegat', 'delegier', 'roadmap', 'strateg', 'prioriti', 'priorisier'], parts: ['hire an agent', 'org chart', 'organigramm'] },
  { category: 'manager-planner', weight: 1, words: ['plan', 'plans', 'planning', 'planung', 'team', 'milestone', 'milestones', 'meilenstein', 'organize', 'organise', 'organisieren'] },
  { category: 'cheap-chat', weight: 3, prefixes: ['summari', 'zusammenfass', 'extract', 'extrahier'], words: ['tl;dr', 'tldr', 'kurzfassung'] },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const LETTER_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

const KEYWORDS: Array<{ category: Category; weight: number; pattern: RegExp }> = GROUPS.map((group) => {
  const alternatives: string[] = [];
  if (group.words?.length) alternatives.push(`${LETTER_BEFORE}(?:${group.words.map(escape).join('|')})${LETTER_AFTER}`);
  if (group.prefixes?.length) alternatives.push(`${LETTER_BEFORE}(?:${group.prefixes.map(escape).join('|')})`);
  if (group.parts?.length) alternatives.push(`(?:${group.parts.map((part) => typeof part === 'string' ? escape(part) : part.source).join('|')})`);
  return { category: group.category, weight: group.weight, pattern: new RegExp(alternatives.join('|'), 'gu') };
});

const MIN_SCORE = 2;
const MAX_HITS_PER_GROUP = 3;

/** Most likely category from free text, or undefined when nothing clearly matches. */
export function inferCategory(text: string | undefined): Category | undefined {
  if (!text || !text.trim()) return undefined;
  const value = text.slice(-4000).toLowerCase();
  const scores = new Map<Category, number>();
  for (const { category, weight, pattern } of KEYWORDS) {
    const matches = value.match(pattern) ?? [];
    // A generic keyword counts once ("Podcast … Podcast", "schneiden … zuschneiden" is one hint).
    const hits = weight === 1 ? new Set(matches).size : matches.length;
    if (hits) scores.set(category, (scores.get(category) ?? 0) + weight * Math.min(hits, MAX_HITS_PER_GROUP));
  }
  let best: Category | undefined;
  let bestScore = 0;
  for (const [category, score] of scores) {
    if (score > bestScore) { best = category; bestScore = score; }
  }
  return bestScore >= MIN_SCORE ? best : undefined;
}

/** True for known category names (mode files and tools use exactly these strings). */
export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** Mode categories that the turn's text refines (B-047 D12: the manager mode no longer labels every turn planning). */
export const REFINED_CATEGORIES: ReadonlySet<string> = new Set(['chat', 'manager-planner']);

/**
 * The category of a turn: a specific mode category wins; the generic 'chat' (general mode) and the
 * manager mode's 'manager-planner' are refined by keyword inference from the turn text; otherwise 'chat'
 * (the router may still classify it). Without any text a refined mode keeps its own category.
 */
export function resolveCategory(modeCategory: string | undefined, text: string | undefined): string {
  if (modeCategory && isCategory(modeCategory) && !REFINED_CATEGORIES.has(modeCategory)) return modeCategory;
  if (modeCategory === 'manager-planner' && text === undefined) return modeCategory;
  return inferCategory(text) ?? 'chat';
}

/** Default effort when neither policy nor chat chose one: hard creative/planning work high, helpers low. */
export function defaultEffortFor(category: string): Effort {
  if (category === 'video-animation' || category === 'manager-planner') return 'high';
  if (category === 'cheap-chat' || category === 'decision' || category === 'embeddings') return 'low';
  return 'medium';
}

/** "video-animation" → "video animation" (for short route reasons). */
export function categoryLabel(category: string): string {
  return category.replace(/-/g, ' ');
}
