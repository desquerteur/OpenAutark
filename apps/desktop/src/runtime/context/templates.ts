// Base prompt templates (`resources/prompts/*.md`) and the tiny template language they use.
// Owns: loading the shipped files once (HTML comments stripped, CRLF normalized), the person's own versions (the open
// file system: <data>/prompts/<name>.md replaces the shipped prompt of that name - every prompt, rules.md included), and
// rendering `{{key}}`, `{{#key}}...{{/key}}` (only when the value is non-empty) and `{{^key}}...{{/key}}` (only when it is
// empty). Lines that become empty because a value or section was empty are dropped, so optional lines leave no gaps
// (identity and rules also get the has_<tool> flags of the turn's tool offer, context/environment.ts toolFlags). An own
// version is read once and kept until the data folder watcher reports a change in prompts/ (watch()), so the stable
// prompt stays byte-identical until the file changes; an unusable file (too large, not text) is logged and the
// shipped prompt used. A missing shipped file renders empty (a broken install; tests point at resources/).
// B-076: rendering agent-default (the standard SYSTEM.md) fills {{rules}} with the rules in force, rendered for a hire
// (the person's name, every tool flag on – standardRuleValues).
// Never: evaluates code, re-expands placeholders inside inserted values, or reads files per turn.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts.ts';
import { ROOT_PROMPTS } from '../root/layout.ts';
import { readText } from '../root/text-doc.ts';
import type { RootWatcher } from '../root/watcher.ts';

/** The prompts the context renders as templates. */
export type TemplateName = 'identity' | 'rules' | 'skills' | 'compaction';
const NAMES: readonly TemplateName[] = ['identity', 'rules', 'skills', 'compaction'];
const SECTION = /\{\{([#^])([a-z_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VARIABLE = /\{\{([a-z_]+)\}\}/g;
const GAP = '\u0000'; // marks text that rendered empty (dropped together with its line)

/** Every shipped prompt by name: the templates plus the ones other modules read (onboarding, agent-default, subconscious). */
export type PromptName = TemplateName | 'onboarding' | 'agent-default' | 'subconscious';
/** The prompts an own file in <data>/prompts may replace: all of them. */
export const OVERRIDABLE: ReadonlySet<PromptName> = new Set<PromptName>(['identity', 'rules', 'onboarding', 'compaction', 'skills', 'agent-default', 'subconscious']);
/** An own prompt file is never larger. */
export const OVERRIDE_MAX_BYTES = 256 * 1024;

/** Removes HTML comments, normalizes line ends and trims the result. */
export function cleanTemplate(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function renderSections(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(SECTION, (_all, kind: string, key: string, inner: string) => {
    const present = Boolean(values[key]?.trim());
    const show = kind === '#' ? present : !present;
    return show ? renderSections(inner, values) : GAP;
  });
}

/** The tool flags rules.md knows (context/environment.ts toolFlags); a hire's SYSTEM.md names every one of them. */
const RULE_TOOL_FLAGS = ['has_files_search', 'has_web_search', 'has_models', 'has_human_ask', 'has_schedules', 'has_todos'] as const;

/** B-076: the values the team's "How I work" is rendered with inside a standard SYSTEM.md (the person's name, all tools). */
export function standardRuleValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const name = values.user_name?.trim() || values.owner?.trim() || 'the person';
  return { ...Object.fromEntries(RULE_TOOL_FLAGS.map((flag) => [flag, 'yes'])), ...values, user_name: name };
}

/** `template` with its tool-flag sections decided as "offered" (the rest of its placeholders kept), as a hire renders them. */
export function resolveToolFlags(template: string): string {
  const flags: ReadonlySet<string> = new Set(RULE_TOOL_FLAGS);
  return template.replace(SECTION, (all, kind: string, key: string, inner: string) => (flags.has(key) ? (kind === '#' ? resolveToolFlags(inner) : '') : all));
}

/** Renders a template with string values. Unknown placeholders render empty. */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const withSections = renderSections(template, values);
  // Single pass: inserted values are never scanned for placeholders again.
  const filled = withSections.replace(VARIABLE, (_all, key: string) => {
    const value = values[key];
    return value && value.trim() ? value : GAP;
  });
  const lines: string[] = [];
  for (const line of filled.split('\n')) {
    if (line.includes(GAP) && !line.replaceAll(GAP, '').trim()) continue; // line existed only for an empty value
    lines.push(line.replaceAll(GAP, '').trimEnd());
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Loads every known template once; a missing or unreadable file renders empty (logged unless missing). */
export function loadTemplates(dir: string | undefined, log?: Logger): Record<TemplateName, string> {
  const out: Record<TemplateName, string> = { identity: '', rules: '', skills: '', compaction: '' };
  if (!dir) return out;
  for (const name of NAMES) {
    try {
      const text = cleanTemplate(readFileSync(path.join(dir, `${name}.md`), 'utf8'));
      if (text) out[name] = text;
    } catch (error) {
      const code = (error as { code?: string }).code;
      log?.warn(code === 'ENOENT' ? 'prompt template missing' : 'prompt template unreadable', { name, error: String(error) });
    }
  }
  return out;
}

export interface PromptTemplatesOptions {
  /** <data>: own versions live in <data>/prompts (absent: the shipped prompts only). */
  data?: () => string | undefined;
}

/** Lazily loaded template set (the resources path is only known once services are wired). */
export class PromptTemplates {
  private readonly dir: () => string | undefined;
  private readonly log: () => Logger | undefined;
  private readonly options: PromptTemplatesOptions;
  private loaded?: Record<TemplateName, string>;
  /** Shipped prompts that are no template (raw text; null: none shipped). */
  private readonly shipped = new Map<PromptName, string | null>();
  /** Own versions as read (null: none or unusable) until the watcher reports a change. */
  private readonly own = new Map<PromptName, string | null>();

  constructor(dir: () => string | undefined, log: () => Logger | undefined = () => undefined, options: PromptTemplatesOptions = {}) {
    this.dir = dir;
    this.log = log;
    this.options = options;
  }

  /** The template in force: the person's own version (cleaned) when there is a usable one, else the shipped text. */
  get(name: TemplateName): string {
    const own = this.ownText(name);
    if (own) return own;
    this.loaded ??= loadTemplates(this.dir(), this.log());
    return this.loaded[name];
  }

  render(name: TemplateName, values: Readonly<Record<string, string>>): string {
    return renderTemplate(this.get(name), values);
  }

  /** Any prompt's text in force (cleaned; '' when neither an own version nor a shipped file exists). */
  text(name: PromptName): string {
    if ((NAMES as readonly string[]).includes(name)) return this.get(name as TemplateName);
    return this.ownText(name) ?? cleanTemplate(this.shippedText(name) ?? '');
  }

  /**
   * B-076: the standard SYSTEM.md as one template – agent-default with its {{rules}} line replaced by the rules template
   * in force (placeholders kept). Prompt updates remember and compare this text, so a change of the rules counts too.
   */
  standardTemplate(): string {
    const rules = resolveToolFlags(this.get('rules'));
    return this.text('agent-default').replace(/^[ \t]*\{\{rules\}\}[ \t]*$/m, () => rules);
  }

  renderText(name: PromptName, values: Readonly<Record<string, string>>): string {
    // B-076: the standard SYSTEM.md takes the team's "How I work" in whole – rendered for a hire, every tool named.
    const filled = name === 'agent-default' && values.rules === undefined ? { ...values, rules: renderTemplate(this.get('rules'), standardRuleValues(values)) } : values;
    return renderTemplate(this.text(name), filled);
  }

  /** Forgets the own versions read so far (all, or the one of `file`, e.g. 'identity.md'); the next use reads again. */
  invalidate(file?: string): void {
    const match = file ? /^([a-z-]+)\.md$/i.exec(file) : null;
    if (!match) { this.own.clear(); return; }
    this.own.delete(match[1].toLowerCase() as PromptName);
  }

  /** Makes this the data folder watcher's owner of prompts/ (a change there drops the cached own versions). */
  watch(root: Pick<RootWatcher, 'register'>): () => void {
    return root.register(ROOT_PROMPTS, (event) => this.invalidate(event.parts?.length === 1 ? event.parts[0] : undefined));
  }

  private ownText(name: PromptName): string | undefined {
    if (!OVERRIDABLE.has(name)) return undefined;
    if (!this.own.has(name)) this.readOwn(name);
    return this.own.get(name) ?? undefined;
  }

  private readOwn(name: PromptName): void {
    const data = this.options.data?.();
    let raw: string | null = null;
    if (data) {
      const read = readText(path.join(data, ROOT_PROMPTS, `${name}.md`), { maxBytes: OVERRIDE_MAX_BYTES });
      if (read.kind === 'ok') raw = read.text;
      else if (read.kind === 'problem') this.log()?.warn('own prompt not used, the shipped one applies', { name, problem: read.problem });
    }
    const cleaned = raw === null ? '' : cleanTemplate(raw);
    this.own.set(name, cleaned || null);
  }

  private shippedText(name: PromptName): string | undefined {
    if (!this.shipped.has(name)) {
      const dir = this.dir();
      let text: string | null = null;
      if (dir) {
        try { text = readFileSync(path.join(dir, `${name}.md`), 'utf8'); } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') this.log()?.warn('prompt unreadable', { name, error: String(error) });
        }
      }
      this.shipped.set(name, text);
    }
    return this.shipped.get(name) ?? undefined;
  }
}
