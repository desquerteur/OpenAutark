// Redaction for anything that leaves the PC in a feedback report (a public GitHub issue).
// Owns: generic secret/PII patterns (keys, tokens, JWTs, private keys, passwords in text,
// signed URL parameters, e-mail addresses, user names in home-folder paths).
// Never: replaces the vault's exact-value redaction (SecretService.redact runs first) – this
// is the safety net for secrets the vault never saw.

type Replacement = string | ((match: string) => string);

const RULES: Array<[RegExp, Replacement]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\b(?:sk|pk|rk)-(?:proj-|live-|test-|ant-(?:api\d+-)?|or-v1-)?[A-Za-z0-9_-]{16,}/g, '[key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [token]'],
  [/\b(password|passwd|pwd|passwort|kennwort|secret|token|api[_-]?key|apikey|authorization|client[_-]?secret)(\s*[:=](?!\/\/)\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]'],
  [/([?&#](?:token|key|secret|sig|signature|code|access_token|refresh_token|id_token|auth|password)=)[^&\s#]+/gi, '$1[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b([A-Za-z]:\\(?:Users|Dokumente und Einstellungen|Documents and Settings)\\)[^\\\s"'<>|]+/gi, '$1[user]'],
  [/(\/(?:Users|home)\/)[^/\s"'<>]+/g, '$1[user]'],
  [/\b(?:\d[ -]?){13,19}\b/g, (match: string) => (luhn(match.replace(/\D/g, '')) ? '[card]' : match)],
];

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Applies every pattern; idempotent (redacted output stays the same when redacted again). */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === 'function' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}
