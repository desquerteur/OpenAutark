// Plain-text clean-up for text that came from outside (apps, run journals, experience notes): invisible
// Unicode (controls, zero-width, bidi, tag characters) and markup go; suspicious() flags text aimed at AI agents.
// Owns: these pure rules and the injection patterns (EN + DE) – a signal, never a guarantee.

// C0/C1 controls except \t and \n, zero-width and word-joiner characters, BOM, bidi controls, Unicode tags.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;

/** Text without invisible or direction-changing characters. */
export function cleanText(value: string): string {
  return value.replace(INVISIBLE, '');
}

/** Plain text: links and images as their label, no fences, HTML tags, chat tokens, [[…]] directives or secret handles. */
export function stripMarkup(value: string): string {
  return value
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\[\[[\s\S]*?\]\]/g, '')
    .replace(/<\|[^|>\n]{0,40}\|>/g, '')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/secret:\/\/[^\s"'<>)\]]*/gi, '');
}

/** Text that addresses AI systems or tries to change what they do (EN + DE), tool or chat syntax, secret handles. */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,40}?\b(?:instructions?|prompts?|rules|directions|guidelines)\b/i,
  /\b(?:ignorier\w*|vergiss|vergesst|missacht\w*)\b[^.\n]{0,40}?\b(?:vorherig\w*|bisherig\w*|alle\w*|obig\w*|dein\w*|ihre\w*)\b[^.\n]{0,40}?\b(?:anweisung\w*|regeln|befehl\w*|vorgaben)\b/i,
  /\bsystem\s*prompt\b/i,
  /\bdeveloper\s+message\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\b/i,
  /\bdear\s+(?:ai|assistant|agent|model|llm|chatbot)\b/i,
  /\bdu\s+bist\s+(?:jetzt|nun|ab\s+sofort)\b/i,
  /\bneue\s+anweisung(?:en)?\b/i,
  /\bsystemanweisung(?:en)?\b/i,
  /\bliebe[rs]?\s+(?:ki|assistent\w*|agent\w*)\b/i,
  /<\|[a-z_]{2,20}\|>/i,
  /^\s*(?:system|assistant|developer)\s*:/im,
  /\[\[\s*tool:/i,
  /<\/?tool_call>/i,
  /secret:\/\//i,
  TAG_CHARS,
];

/** Any injection pattern matches. */
export function suspicious(value: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value));
}
