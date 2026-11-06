// Migration 80 (owner correction 29.10.2026 – secrets as a catalog like skills):
// nobody restricts a secret to sites – neither the app nor the person ('Only on' is gone). Migration 79 kept every
// binding it could not tell apart from one the person set; this drops them all, except on card data (the money rules:
// a card single secret, a card group, or a group holding a card field).
//  * The first rule becomes the entry's `source` when it has none ("*." and a leading www dropped) – the site it was
//    tied to stays visible as "Saved from …" and still lets browser.save_totp find an agent's login for that site.
//  * `domains` becomes '[]'. The vault reads domains only on card data anyway (secrets/groups.ts toInfo).
// Owns: that one data step. Never: a value, a cipher, an access entry or a card's domains.

const rule = (column: string) => /* sql */ `lower(json_extract(${column}, '$[0]'))`;
const noStar = (column: string) => /* sql */ `(CASE WHEN ${rule(column)} LIKE '*.%' THEN substr(${rule(column)}, 3) ELSE ${rule(column)} END)`;
const first = (column: string) => /* sql */ `
  CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' AND json_array_length(${column}) > 0
    THEN (CASE WHEN ${noStar(column)} LIKE 'www.%' THEN substr(${noStar(column)}, 5) ELSE ${noStar(column)} END) END`;

const bound = (column: string) => /* sql */ `${column} IS NOT NULL AND ${column} <> '[]' AND ${column} <> ''`;

export const sql = /* sql */ `
UPDATE secrets SET source = COALESCE(source, ${first('domains')}), domains = '[]'
WHERE group_id IS NULL AND kind <> 'card' AND ${bound('domains')};
UPDATE secret_groups SET source = COALESCE(source, ${first('domains')}), domains = '[]'
WHERE kind <> 'card' AND ${bound('domains')}
  AND NOT EXISTS (SELECT 1 FROM secrets WHERE secrets.group_id = secret_groups.id AND secrets.kind = 'card');
`;
