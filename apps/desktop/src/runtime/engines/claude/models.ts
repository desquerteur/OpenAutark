// Claude Code model discovery: the `initialize` control response → the catalog's EngineModels.
// Owns: the static fallback list (CLAUDE_MODELS), tolerant reading of the initialize response
// (`models[]` and `account`, field names as the Agent SDK documents them – confirmed only by the
// opt-in probe test/live/claude-initialize.test.ts, so alternatives are accepted), mapping the
// CLI's aliases ("opus", "sonnet[1m]", "default") to model ids, and context windows that
// `result.modelUsage` reported for a model. A 1M-context variant gets the bracket-free catalog id
// `<id>-1m` (RPC and catalog ids allow no brackets); cliModel() turns it back into Claude Code's
// `<id>[1m]` for `--model` and for modelUsage lookups.
// Never: spawns processes, reads files, or keeps account details beyond the values it returns.

import type { Effort } from '../../../shared/model/providers.ts';
import type { EngineModel } from '../types.ts';
import { isRecord, normalizeEffort, str } from '../shared.ts';

export const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Used when the CLI cannot be asked (not installed, probe failed) or names no model we can map. */
export const CLAUDE_MODELS: EngineModel[] = [
  { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium', vision: true, contextTokens: 1_000_000 },
  { model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', vision: true, contextTokens: 1_000_000 },
  { model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium', vision: true, contextTokens: 1_000_000 },
  { model: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', vision: true, contextTokens: 1_000_000 },
];

const MAX_LISTED = 50;
const MAX_WINDOWS = 50;
const LONG = /\[1m\]$/i; // Claude Code's 1M-context variant suffix ("sonnet[1m]")
const LONG_ID = /^(claude-.+)-1m$/i; // the same variant as a catalog id ("claude-sonnet-5-5-1m")
const LONG_WINDOW = 1_000_000;
const FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const NAMED = /\b(opus|sonnet|haiku|fable)\s+(\d+(?:\.\d+)?)\b/gi; // "Opus 5.5 · …" in a description
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,150}$/i;

export interface ClaudeListedModel { value: string; name?: string; description?: string; efforts?: Effort[]; supportsEffort?: boolean }
export interface ClaudeAccountInfo { email?: string; organization?: string; plan?: string }
export interface ClaudeInit { models: ClaudeListedModel[]; account?: ClaudeAccountInfo }

const clip = (value: unknown, max: number): string | undefined => {
  const text = str(value)?.replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
};

function listedModel(raw: unknown): ClaudeListedModel | undefined {
  if (typeof raw === 'string') return clip(raw, 160) ? { value: clip(raw, 160)! } : undefined;
  if (!isRecord(raw)) return undefined;
  const value = clip(raw.value ?? raw.id ?? raw.model, 160);
  if (!value) return undefined;
  const levels = raw.supportedEffortLevels ?? raw.supported_effort_levels ?? raw.efforts;
  const efforts = Array.isArray(levels) ? [...new Set(levels.map(normalizeEffort).filter((e): e is Effort => e !== undefined && e !== 'none'))] : undefined;
  const supports = raw.supportsEffort ?? raw.supports_effort;
  return {
    value, name: clip(raw.displayName ?? raw.display_name ?? raw.name, 120), description: clip(raw.description, 300),
    efforts: efforts?.length ? efforts : undefined, supportsEffort: typeof supports === 'boolean' ? supports : undefined,
  };
}

/** The payload of a successful `initialize` control response; undefined when it lists nothing usable. */
export function parseInitialize(value: unknown): ClaudeInit | undefined {
  if (!isRecord(value)) return undefined;
  const list = Array.isArray(value.models) ? value.models : Array.isArray(value.availableModels) ? value.availableModels : [];
  const models = list.slice(0, MAX_LISTED).map(listedModel).filter((m): m is ClaudeListedModel => m !== undefined);
  const raw = isRecord(value.account) ? value.account : undefined;
  const account = raw ? { email: clip(raw.email, 200), organization: clip(raw.organization, 200), plan: clip(raw.subscriptionType ?? raw.subscription_type, 40) } : undefined;
  return models.length || account ? { models, account } : undefined;
}

/** The `--model` value (and modelUsage key) of a catalog model id: `<id>-1m` → `<id>[1m]`. */
export function cliModel(model: string): string {
  const long = LONG_ID.exec(model);
  return long ? `${long[1]}[1m]` : model;
}

/** Model ids named in a display text ("Opus 5.5 for complex work" → claude-opus-5-5). */
function namedIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(NAMED)) ids.add(`claude-${match[1].toLowerCase()}-${match[2].replace('.', '-')}`);
  return [...ids];
}

/** The static entry for an id or a dated variant of it ("claude-opus-5-5-20261001"). */
function staticFor(id: string): EngineModel | undefined {
  return CLAUDE_MODELS.find((m) => m.model === id || (id.startsWith(`${m.model}-`) && /^\d{6,8}$/.test(id.slice(m.model.length + 1))));
}

/** Concrete model id of a listed entry; undefined for modes ("opusplan") and unmappable aliases. */
function idOf(entry: ClaudeListedModel): string | undefined {
  const base = entry.value.replace(LONG, '').trim();
  const alias = base.toLowerCase();
  const text = `${entry.name ?? ''} ${entry.description ?? ''}`;
  if (alias.includes('claude-') && MODEL_ID.test(base)) return base;
  if (alias === 'default') {
    const named = namedIds(text);
    return named.length === 1 ? named[0] : undefined; // "Opus for 50 %, then Sonnet" names two: ambiguous
  }
  if (!FAMILIES.has(alias)) return undefined;
  return namedIds(text).find((id) => id.startsWith(`claude-${alias}-`)) ?? CLAUDE_MODELS.find((m) => m.model.startsWith(`claude-${alias}-`))?.model;
}

function displayName(id: string, entry: ClaudeListedModel, long: boolean): string {
  const known = staticFor(id)?.name;
  const family = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(id);
  const built = family ? `Claude ${family[1][0].toUpperCase()}${family[1].slice(1)} ${family[2]}${family[3] ? `.${family[3]}` : ''}` : undefined;
  const listed = entry.value.toLowerCase().includes('claude-') ? entry.name : undefined; // an alias's own name is just "Opus"
  const name = known ?? built ?? listed ?? id;
  return long ? `${name} (1M context)` : name;
}

/** Window `result.modelUsage` reported for `model` (exact id or a dated variant, same 1M suffix). */
export function windowFor(windows: ReadonlyMap<string, number> | undefined, model: string): number | undefined {
  if (!windows?.size) return undefined;
  const exact = windows.get(model);
  if (exact) return exact;
  const long = LONG.test(model);
  const base = model.replace(LONG, '');
  for (const [id, window] of windows) {
    const idBase = id.replace(LONG, '');
    if (LONG.test(id) === long && idBase.startsWith(`${base}-`) && /^\d{6,8}$/.test(idBase.slice(base.length + 1))) return window;
  }
  return undefined;
}

/** Keeps the windows a finished turn reported (bounded; newest reading wins). */
export function rememberWindows(into: Map<string, number>, reported: Record<string, number>): void {
  for (const [model, window] of Object.entries(reported)) {
    if (!MODEL_ID.test(model.replace(LONG, '')) || !(window > 0)) continue;
    into.delete(model);
    into.set(model, Math.round(window));
  }
  while (into.size > MAX_WINDOWS) into.delete(into.keys().next().value!);
}

/**
 * The account's models: the CLI's own list with aliases mapped to ids (1M variants kept apart,
 * "default" only when it names one model not listed otherwise), else the static list. Context
 * windows: reported by modelUsage, else 1M for a [1m] variant, else the static entry's (models
 * without one get theirs from the priors).
 */
export function claudeModels(init: ClaudeInit | undefined, windows?: ReadonlyMap<string, number>): EngineModel[] {
  const out = new Map<string, EngineModel>();
  const entries = [...(init?.models ?? [])].sort((a, b) => Number(a.value === 'default') - Number(b.value === 'default'));
  for (const entry of entries) {
    const id = idOf(entry);
    if (!id) continue;
    const long = LONG.test(entry.value);
    const model = long ? `${id}-1m` : id; // catalog id; Claude Code's own name is cliModel(model)
    if (out.has(model)) continue;
    const known = staticFor(id);
    const efforts = entry.supportsEffort === false ? [] : [...(entry.efforts ?? known?.efforts ?? CLAUDE_EFFORTS)];
    const defaultEffort = known?.defaultEffort && efforts.includes(known.defaultEffort) ? known.defaultEffort : undefined;
    const contextTokens = windowFor(windows, cliModel(model)) ?? (long ? LONG_WINDOW : known?.contextTokens);
    out.set(model, { model, name: displayName(id, entry, long), efforts, ...(defaultEffort ? { defaultEffort } : {}), vision: true, ...(contextTokens ? { contextTokens } : {}) });
  }
  if (out.size) return [...out.values()];
  return CLAUDE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts], contextTokens: windowFor(windows, m.model) ?? m.contextTokens }));
}
