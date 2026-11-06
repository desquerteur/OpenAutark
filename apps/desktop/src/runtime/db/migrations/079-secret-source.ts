// Migration 79 (owner decision 29.10.2026 – secrets usable everywhere):
// a stored secret is not tied to one website. The site a value came from is kept only as its provenance (`source`,
// "Saved from example.com" in Settings › Secrets); a domain restriction exists only where the person set one ('Only on').
//  * `source` on single secrets and on groups (logins, cards) – a registrable domain, or NULL.
//  * The automatic binding the app wrote becomes its source and the restriction goes – where it has exactly one plain
//    domain and is either an agent's own (browser.save_secret, secrets.generate, browser.save_totp: `created_by` an
//    agent id) or a form answer (secrets/capture.ts: the form field's domain; recognisable by its fixed hash id
//    sec_/sgr_ + 24 hex characters – Settings' ids are time-based and 17 characters long).
//    Cards keep theirs (money rules). What cannot be told apart from a restriction the person set stays as it is: the
//    person's own entries (also passwords bound on their first use), the app's own ('system'), entries with several
//    domains, a "*." or a www rule. Known limit: an 'Only on' the person set to exactly one plain domain on such an
//    agent's or form entry is taken for automatic too (there is no edit history to tell them apart).
// Owns: these columns and that one data step. Never: a value, a cipher, an access entry or a card's domains.

const plain = (column: string) => /* sql */ `
  CASE WHEN json_valid(${column}) THEN json_type(${column}) = 'array' AND json_array_length(${column}) = 1 ELSE 0 END
  AND json_extract(${column}, '$[0]') NOT LIKE '*.%' AND json_extract(${column}, '$[0]') NOT LIKE 'www.%'
  AND instr(json_extract(${column}, '$[0]'), '/') = 0`;

/** An agent's entry or a form answer's (fixed hash id with `prefix`). */
const automatic = (prefix: string) => /* sql */ `
  ((created_by IS NOT NULL AND created_by <> 'system')
    OR (created_by IS NULL AND length(id) = 28 AND substr(id, 1, 4) = '${prefix}_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'))`;

export const sql = /* sql */ `
ALTER TABLE secrets ADD COLUMN source TEXT;
ALTER TABLE secret_groups ADD COLUMN source TEXT;
UPDATE secrets SET source = json_extract(domains, '$[0]'), domains = '[]'
WHERE group_id IS NULL AND ${automatic('sec')} AND kind <> 'card' AND ${plain('domains')};
UPDATE secret_groups SET source = json_extract(domains, '$[0]'), domains = '[]'
WHERE ${automatic('sgr')} AND kind <> 'card' AND ${plain('domains')}
  AND NOT EXISTS (SELECT 1 FROM secrets WHERE secrets.group_id = secret_groups.id AND secrets.kind = 'card');
`;
