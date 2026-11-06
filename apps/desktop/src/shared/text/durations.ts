// Spoken durations (B-041): the one number-word table (DE/EN, folded – shared/text/normalize.ts foldText) and the
// one reading of a timer phrase with its length – "timer 10 min", "Timer für 25 Minuten", "Timer für eine halbe
// Stunde", "10-min timer", "zehn Minuten Timer", "15-Minuten-Timer". The to-do keyword widget (runtime/tasks/
// widgets.ts parseWhen), My day's input (runtime/day/intake.ts) and the day parser (runtime/calendar/when.ts) read
// the same words, so a phrase means the same everywhere.
// Owns: the table and the timer phrase. Never: a clock, or what the timer is for.

/** Number words of durations and clock times (folded DE/EN; no articles – "a"/"ein" mean one only where a reader says so). */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  eins: 1, one: 1, zwei: 2, two: 2, drei: 3, three: 3, vier: 4, four: 4, funf: 5, five: 5, sechs: 6, six: 6, sieben: 7, seven: 7,
  acht: 8, eight: 8, neun: 9, nine: 9, zehn: 10, ten: 10, elf: 11, eleven: 11, zwolf: 12, twelve: 12, funfzehn: 15, fifteen: 15,
  zwanzig: 20, twenty: 20, funfundzwanzig: 25, 'twenty-five': 25, dreissig: 30, thirty: 30, vierzig: 40, forty: 40,
  funfundvierzig: 45, 'forty-five': 45, sechzig: 60, sixty: 60, neunzig: 90, ninety: 90,
};

/** The words as a regex alternation, longest first ("funfundzwanzig" before "funf"). */
export function numberWordPattern(extra: Readonly<Record<string, number>> = {}): string {
  return Object.keys({ ...NUMBER_WORDS, ...extra }).sort((a, b) => b.length - a.length).join('|');
}

const ONE: Readonly<Record<string, number>> = { ein: 1, eine: 1, einer: 1, einen: 1, a: 1, an: 1 };
const NUMBER = `(\\d{1,4}|${numberWordPattern(ONE)})`;
const UNIT = '(minuten|minutes|minute|mins|min|m|stunden|stunde|std|hours|hour|hrs|hr|h)';
const TIMER_WORD = '(?:timer|wecker|countdown)';
const HALF = '(?:(?:eine\\s+|einer\\s+)?halbe(?:n)?\\s+stunde|half\\s+an\\s+hour|a\\s+half\\s+hour)';
/** "timer 10 min", "Timer für eine halbe Stunde": the word, then its length. */
const AFTER = new RegExp(`\\b${TIMER_WORD}\\s*(?::\\s*)?(?:(?:fur|for|auf|von|of)\\s+)?(?:${NUMBER}[\\s-]*${UNIT}\\b|(${HALF})\\b)`);
/** "10-min timer", "zehn Minuten Timer", "15-Minuten-Timer": the length, then the word. */
const BEFORE = new RegExp(`(?<![\\w-])(?:${NUMBER}[\\s-]*${UNIT}|(${HALF}))[\\s-]+${TIMER_WORD}\\b`);

/** Minutes of `value` `unit` (a number word or digits). */
function minutesOf(value: string, unit: string): number | undefined {
  const count = /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value] ?? ONE[value];
  if (!count) return undefined;
  return /^(?:std|stunden?|hours?|hrs?|h)$/.test(unit) ? count * 60 : count;
}

/** The length of the timer a folded text names next to the word timer/Wecker/countdown, in minutes; else undefined. */
export function timerMinutes(folded: string): number | undefined {
  for (const pattern of [AFTER, BEFORE]) {
    const found = pattern.exec(folded);
    if (!found) continue;
    if (found[3]) return 30;
    const minutes = minutesOf(found[1], found[2]);
    if (minutes) return minutes;
  }
  return undefined;
}

/** An ISO 8601 duration for `minutes` ("PT2H", "PT90M", "PT10M"). */
export function isoMinutes(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `PT${minutes / 60}H` : `PT${minutes}M`;
}
