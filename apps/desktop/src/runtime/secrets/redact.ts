// Exact-value redaction: replaces known secret values (and their common encodings) in any text
// with the secret's handle `secret://<id>`. X05: a 2FA setup key is learnt as a `pattern` (any
// case and grouping, totp.ts seedPattern) – never its stored JSON.
// Owns: the in-memory matcher. Never: logs values, matches values shorter than MIN_SECRET_CHARS
// (too many false hits; the UI flags such secrets as "too short for leak detection").

export const MIN_SECRET_CHARS = 8;

export function handleFor(id: string): string {
  return `secret://${id}`;
}

/** All encodings of a value we look for (raw, base64, URL-encoded, hex). */
function variants(value: string): string[] {
  const out = new Set<string>([value]);
  out.add(Buffer.from(value, 'utf8').toString('base64'));
  out.add(Buffer.from(value, 'utf8').toString('base64url'));
  out.add(encodeURIComponent(value));
  out.add(Buffer.from(value, 'utf8').toString('hex'));
  return [...out].filter(variant => variant.length >= MIN_SECRET_CHARS);
}

export class Redactor {
  private byValue = new Map<string, string>(); // variant → secret id
  private ordered: string[] = []; // variants, longest first (prefer the most specific match)
  private patterns = new Map<string, RegExp>(); // secret id → every spelling of a 2FA key (global)

  set(id: string, value: string | undefined, pattern?: RegExp): void {
    this.remove(id);
    if (pattern?.global) this.patterns.set(id, pattern);
    const forms = value && value.length >= MIN_SECRET_CHARS ? variants(value) : [];
    if (!forms.length) return;
    for (const form of forms) this.byValue.set(form, id);
    this.reorder();
  }

  remove(id: string): void {
    this.patterns.delete(id);
    let changed = false;
    for (const [variant, owner] of this.byValue) if (owner === id) { this.byValue.delete(variant); changed = true; }
    if (changed) this.reorder();
  }

  redact(text: string): string {
    if (!text || (this.ordered.length === 0 && this.patterns.size === 0)) return text;
    let out = text;
    for (const [id, pattern] of this.patterns) out = out.replace(pattern, () => handleFor(id));
    for (const variant of this.ordered) {
      if (out.includes(variant)) out = out.split(variant).join(handleFor(this.byValue.get(variant)!));
    }
    return out;
  }

  private reorder(): void {
    this.ordered = [...this.byValue.keys()].sort((a, b) => b.length - a.length);
  }
}
