// Migration 81 (owner 29.10.2026 – secrets as a catalog like skills, with its
// "Nachtrag"): the secrets store is a catalog like a skill, with ZERO restrictions – card data included.
//  * Every remaining domain binding goes (migration 80 kept the ones on card data): its first rule becomes the entry's
//    `source` when it has none ("*." and a leading www dropped), and EVERY rule is kept as a usage tag "for the web at
//    <site>" (information only – review intent #13: no site is lost); `domains` becomes '[]' and is never read again.
//  * `route` (the catalog area whose file <data>/secrets/<route>.md lists the entry) on single secrets and groups,
//    filled like shared/model/security.ts autoSecretRoute: card data → payment, server words → servers, keys and
//    tokens → keys, sign-ins → logins, the rest → notes. A grouped field's own column stays NULL (its group's counts).
//  * `tags` (usage tags, JSON array, information only) on both, '[]'.
// Owns: these columns and that one data step. Never: a value, a cipher or an access entry.

const rule = (column: string) => /* sql */ `lower(json_extract(${column}, '$[0]'))`;
const noStar = (column: string) => /* sql */ `(CASE WHEN ${rule(column)} LIKE '*.%' THEN substr(${rule(column)}, 3) ELSE ${rule(column)} END)`;
const first = (column: string) => /* sql */ `
  CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' AND json_array_length(${column}) > 0
    THEN (CASE WHEN ${noStar(column)} LIKE 'www.%' THEN substr(${noStar(column)}, 5) ELSE ${noStar(column)} END) END`;
const bound = (column: string) => /* sql */ `${column} IS NOT NULL AND ${column} <> '[]' AND ${column} <> ''`;

/** Server words in a name or description (the same list as autoSecretRoute, as LIKE patterns). */
const SERVER = ['ssh', 'sftp', 'ftp', 'server', 'vps', 'hosting', 'database', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'mongodb', 'redis', 'rdp', 'vpn', 'imap', 'smtp', 'router', 'nas'];
const servers = (text: string) => SERVER.map((word) => `(' ' || lower(${text}) || ' ') GLOB '*[^a-z0-9_]${word}[^a-z0-9_]*'`).join(' OR ');
/** One rule of a domains array (json_each value) as a site: lower-case, "*." and a leading www dropped. */
const site = /* sql */ `(CASE WHEN (CASE WHEN lower(trim(value)) LIKE '*.%' THEN substr(lower(trim(value)), 3) ELSE lower(trim(value)) END) LIKE 'www.%'
  THEN substr((CASE WHEN lower(trim(value)) LIKE '*.%' THEN substr(lower(trim(value)), 3) ELSE lower(trim(value)) END), 5)
  ELSE (CASE WHEN lower(trim(value)) LIKE '*.%' THEN substr(lower(trim(value)), 3) ELSE lower(trim(value)) END) END)`;
const asTags = (table: string) => /* sql */ `(SELECT json_group_array(DISTINCT 'for the web at ' || ${site}) FROM json_each(${table}.domains) WHERE type = 'text' AND trim(value) <> '')`;
const listed = (column: string) => /* sql */ `json_valid(${column}) AND json_type(${column}) = 'array' AND json_array_length(${column}) > 0`;

export const sql = /* sql */ `
ALTER TABLE secrets ADD COLUMN route TEXT;
ALTER TABLE secrets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE secret_groups ADD COLUMN route TEXT;
ALTER TABLE secret_groups ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
UPDATE secrets SET source = COALESCE(source, ${first('domains')}) WHERE group_id IS NULL AND ${bound('domains')};
UPDATE secret_groups SET source = COALESCE(source, ${first('domains')}) WHERE ${bound('domains')};
UPDATE secrets SET tags = ${asTags('secrets')} WHERE group_id IS NULL AND ${listed('domains')};
UPDATE secret_groups SET tags = ${asTags('secret_groups')} WHERE ${listed('domains')};
UPDATE secrets SET domains = '[]' WHERE domains <> '[]';
UPDATE secret_groups SET domains = '[]' WHERE domains <> '[]';
UPDATE secrets SET route = CASE
  WHEN kind = 'card' THEN 'payment'
  WHEN ${servers(`label || ' ' || COALESCE(description, '')`)} THEN 'servers'
  WHEN kind IN ('api_key', 'token') THEN 'keys'
  WHEN kind IN ('password', 'totp') THEN 'logins'
  ELSE 'notes' END
WHERE group_id IS NULL;
UPDATE secret_groups SET route = CASE
  WHEN kind = 'card' OR EXISTS (SELECT 1 FROM secrets WHERE secrets.group_id = secret_groups.id AND secrets.kind = 'card') THEN 'payment'
  WHEN ${servers(`label || ' ' || COALESCE(description, '')`)} THEN 'servers'
  WHEN kind = 'login' THEN 'logins'
  ELSE 'notes' END;
`;
