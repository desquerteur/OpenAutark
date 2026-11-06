// B-047 (contract D9): agents are colleagues with human first names; the role says what they do.
// A hire without a name gets a free first name from FIRST_NAMES (org/hire.ts), and agents.create
// refuses a name that is a role, a template or a numbered label instead of a person's first name.
// Owns: the name list, the pick and the person-name check. Never: decides roles or saves anything.

/** Short first names that read naturally in German and English (no famous or branded names). */
export const FIRST_NAMES: readonly string[] = [
  'Mara', 'Jonas', 'Ella', 'Felix', 'Nora', 'Leon', 'Clara', 'Paul', 'Lina', 'Theo', 'Ida', 'Noah',
  'Lea', 'Elias', 'Mila', 'Finn', 'Hanna', 'Jan', 'Emma', 'Luca', 'Sophie', 'Ben', 'Lotta', 'Max',
  'Greta', 'David', 'Romy', 'Tom', 'Frida', 'Samuel', 'Nina', 'Oskar', 'Ronja', 'Levi', 'Alma', 'Milan',
];

/** A stable start index for `seed` (the new agent's id), so the same hire picks the same name. */
function startOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % FIRST_NAMES.length;
}

/** The first name from the list nobody uses yet, starting at the seed's place; undefined when all are taken. */
export function freeFirstName(seed: string, taken: (name: string) => boolean): string | undefined {
  const start = startOf(seed);
  for (let step = 0; step < FIRST_NAMES.length; step++) {
    const name = FIRST_NAMES[(start + step) % FIRST_NAMES.length];
    if (!taken(name)) return name;
  }
  return undefined;
}

/** Words that name a job or a thing, not a person ("Researcher", "Agent", "Bot"). */
const ROLE_WORDS = new Set(['agent', 'assistant', 'bot', 'helper', 'specialist', 'manager', 'lead', 'team', 'ai', 'worker', 'operator', 'expert']);
/** One or two name parts: letters, joined by a space, hyphen or apostrophe ("Anna-Lena", "Jean Luc", "O'Neill"). */
const PERSON_NAME = /^\p{Lu}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)?(?: \p{Lu}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)?)?$/u;

/**
 * Why `name` is no person's first name (undefined: it is one). `roles` are the words that would make it a
 * role instead – template names, roles and keys, mode keys (compared without case, word by word).
 */
export function personNameProblem(name: string, roles: Iterable<string> = []): string | undefined {
  const value = name.trim();
  if (value.length < 2 || value.length > 30 || !PERSON_NAME.test(value)) return 'a first name starts with a capital letter and has letters only (one or two parts, e.g. "Mara" or "Anna-Lena")';
  const words = new Set(ROLE_WORDS);
  for (const role of roles) for (const word of role.toLowerCase().split(/[^\p{L}]+/u)) if (word.length > 2) words.add(word);
  const parts = value.toLowerCase().split(/[ '’-]+/u);
  if (words.has(value.toLowerCase()) || parts.some((part) => words.has(part))) return 'that is a role, not a person\'s name - put the role in "role"';
  return undefined;
}
