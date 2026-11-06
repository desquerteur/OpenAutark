// The "never anywhere else" guard (owner 29.10.2026: a secret is ALWAYS stored directly in the secrets store and
// never copied into an agent's notes, memory, rules, files or messages): before any tool runs, every string in its
// arguments passes the vault's leak redactor, so a stored value an agent tries to write somewhere – a memory or note,
// a skill or rule, a file, a chat message, a task, an agent's instructions, a command line – arrives as its handle
// `secret://<id>` instead (tools/registry.ts). A value the vault does not know yet is the agent's to save first
// (secrets.save, browser.save_secret – the agent guidance says so); from then on the redactor knows it.
// A tool's vault arguments (tools/registry.ts VAULT_ARGS – secrets.save's value) are left as given: they go straight
// into the vault, so a new value that merely contains a stored one is saved as typed, never with a handle inside.
// Owns: that deep redaction of tool arguments. Never: changes a non-string, drops an argument, or reads a value.

import type { SecretService } from '../contracts.ts';

const MAX_DEPTH = 32;

/** `args` with every stored secret value in its strings replaced by the handle (the same object when nothing changed);
 * `vault`: top-level argument names left as given (they go into the vault). */
export function withoutSecretValues<T>(secrets: Pick<SecretService, 'redact'>, args: T, vault: readonly string[] = []): T {
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      try { return secrets.redact(value); } catch { return value; }
    }
    if (value === null || typeof value !== 'object') return value;
    // Deeper than any real argument: the whole rest is redacted as one JSON text, never passed on unchecked.
    if (depth > MAX_DEPTH) { try { return JSON.parse(secrets.redact(JSON.stringify(value))) as unknown; } catch { return value; } }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => { const next = walk(item, depth + 1); if (next !== item) changed = true; return next; });
      return changed ? out : value;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = depth === 0 && vault.includes(key) ? item : walk(item, depth + 1);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  };
  return walk(args, 0) as T;
}
