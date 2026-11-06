// Secret safety for team patterns (patterns/format.ts): which field names are credentials,
// permissions or machine bindings (never imported – the report names the field, never its value),
// and a scrub for secrets written into free text (keys, tokens, private keys, "password: <value>"
// when the value looks like a credential – prose such as "password: at least 8 characters" stays).
// Owns: these rules. Never: logs or returns a removed value, or decides what an agent may do.

const SECRET_TEXT: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-|ant-(?:api\d+-)?|or-v1-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const ASSIGNMENT = /\b(password|passwd|pwd|passwort|kennwort|secret|token|api[_-]?key|apikey|access[_-]?key|authorization|client[_-]?secret)(\s*[:=](?!\/\/)\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
export const REMOVED = '[removed secret]';

/** Field names whose values are credentials (never read into a proposal). */
const SECRET_FIELD = /(api[_-]?key|apikey|token|secret|password|passwd|credential|auth|private[_-]?key|access[_-]?key|env)$/i;
/** Field names that grant rights, tools or machine bindings in the source system (dropped, named in the report). */
const PERMISSION_FIELD = /^(tools|allowed[_-]?tools|disallowed[_-]?tools|permission[_-]?mode|permissions|mcp[_-]?servers|hooks|allow[_-]?delegation|allow[_-]?code[_-]?execution|code[_-]?execution[_-]?mode|max[_-]?rpm|max[_-]?iter|max[_-]?execution[_-]?time|llm|function[_-]?calling[_-]?llm|model|color|memory|cache|verbose|output[_-]?file|output[_-]?json|output[_-]?pydantic|human[_-]?input|async[_-]?execution|callback|step[_-]?callback|knowledge[_-]?sources|embedder|context|guardrail)$/i;

export function isSecretField(name: string): boolean {
  return SECRET_FIELD.test(name.trim());
}

export function isPermissionField(name: string): boolean {
  return PERMISSION_FIELD.test(name.trim());
}

/** Removes secrets from free text; `count` says how many were removed. */
export function scrubSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of SECRET_TEXT) {
    out = out.replace(rule, (match: string, scheme?: string) => {
      count++;
      return typeof scheme === 'string' && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${REMOVED}` : REMOVED;
    });
  }
  out = out.replace(ASSIGNMENT, (match: string, key: string, sep: string, value: string) => {
    if (!credentialLike(value)) return match; // prose ("password: at least 8 characters"), placeholders and removed schemes stay
    count++;
    return `${key}${sep}${REMOVED}`;
  });
  return { text: out, count };
}

/**
 * Whether the value after "password:" / "token=" looks like a credential: quoted (and not empty),
 * or one unquoted word of at least 6 characters that is not an ordinary word ("rule", "Required",
 * "at"; a letters-only run longer than 15 counts as random), not a placeholder ({KEY}, <token>,
 * $VAR, ${VAR}, %VAR%) and not a removed one.
 */
function credentialLike(value: string): boolean {
  if (value === REMOVED || /^(bearer|basic)$/i.test(value) || /^\{.*\}$/.test(value) || /^<.*>$/.test(value)) return false;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value)) return false;
  if (/^(["']).*\1$/.test(value)) return value.length > 2;
  const word = value.replace(/[.,;:!?)]+$/, '');
  return word.length >= 6 && !(word.length <= 15 && /^[A-Z]?[a-z]+(-[a-z]+)*$/.test(word));
}
