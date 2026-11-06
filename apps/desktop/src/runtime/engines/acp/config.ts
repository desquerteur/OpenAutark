// ACP session configuration: the models and reasoning levels an agent offers in session/new|load
// (`configOptions` with category 'model' / 'thought_level', else the older `models` field), the
// model listing built from them and the next request that applies a turn's model and effort
// (session/set_config_option, or session/set_model for the `models` form).
// Owns: parsing these offers and choosing among the offered values.
// Never: sends requests (turn.ts does) or invents ids the agent did not offer.

import type { Effort } from '../../../shared/model/providers.ts';
import type { EngineModel } from '../types.ts';
import { isRecord, nearestEffort, normalizeEffort, str } from '../shared.ts';

export interface Choice { value: string; name: string }

export interface SessionConfig {
  models: Choice[];
  model?: string; // current model value
  modelConfigId?: string; // set when models come as a config option
  efforts: Array<{ value: string; effort: Effort }>;
  effort?: string; // current thought level value
  effortConfigId?: string;
}

/** The model id that means "whatever the agent uses by default" (no set request). */
export const DEFAULT_MODEL = 'default';
const MAX_CHOICES = 200;

function choices(raw: unknown): Choice[] {
  const out: Choice[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    if (Array.isArray(item.options)) { out.push(...choices(item.options)); continue; } // grouped options
    const value = str(item.value) ?? str(item.modelId);
    if (value && value.length <= 200) out.push({ value, name: (str(item.name) ?? value).slice(0, 200) });
  }
  return out.slice(0, MAX_CHOICES);
}

function effortsOf(values: Choice[]): SessionConfig['efforts'] {
  return values.flatMap((choice) => {
    const effort = normalizeEffort(choice.value.toLowerCase()) ?? normalizeEffort(choice.name.toLowerCase());
    return effort ? [{ value: choice.value, effort }] : [];
  });
}

/** Reads the offers of a session/new|load|resume answer or a config_option_update; keeps what it does not mention. */
export function parseConfig(result: unknown, previous: SessionConfig = { models: [], efforts: [] }): SessionConfig {
  const r = isRecord(result) ? result : {};
  const config: SessionConfig = { ...previous };
  let modelOption = false;
  for (const option of Array.isArray(r.configOptions) ? r.configOptions.filter(isRecord) : []) {
    if (option.type !== undefined && option.type !== 'select') continue;
    const id = str(option.id);
    const category = str(option.category) ?? id;
    if (!id) continue;
    if (category === 'model') {
      modelOption = true;
      Object.assign(config, { models: choices(option.options), model: str(option.currentValue), modelConfigId: id });
    } else if (category === 'thought_level') {
      Object.assign(config, { efforts: effortsOf(choices(option.options)), effort: str(option.currentValue), effortConfigId: id });
    }
  }
  if (!modelOption && isRecord(r.models)) {
    Object.assign(config, { models: choices(r.models.availableModels), model: str(r.models.currentModelId), modelConfigId: undefined });
  }
  return config;
}

/** EngineModels for an account from what its agent offered (one 'default' model when it offered none).
 *  B-058 G7: `audio` (initialize promptCapabilities.audio) lists every model with audioIn, so the listener
 *  may route a recording to the agent (engine-runner hearsAudio; turn.ts sends it as ACP audio blocks). */
export function listing(config: SessionConfig | undefined, label: string, vision: boolean, audio = false): EngineModel[] {
  const efforts = [...new Set((config?.efforts ?? []).map((e) => e.effort))];
  const defaultEffort = config?.efforts.find((e) => e.value === config.effort)?.effort;
  const base = { efforts: efforts.length ? efforts : (['none'] as Effort[]), defaultEffort, vision, audioIn: audio };
  const models = config?.models ?? [];
  if (!models.length) return [{ model: DEFAULT_MODEL, name: `${label} (default model)`.slice(0, 200), ...base }];
  return models.map((choice) => ({ model: choice.value, name: choice.name, ...base }));
}

export interface ConfigRequest { method: string; params: Record<string, unknown>; apply(result: unknown): void }

/** The next request that brings the session to the turn's model and effort, or undefined. */
export function nextConfigRequest(sessionId: string, config: SessionConfig, model: string, effort: Effort): ConfigRequest | undefined {
  if (model !== DEFAULT_MODEL && model !== config.model && config.models.some((m) => m.value === model)) {
    const configId = config.modelConfigId;
    return configId
      ? { method: 'session/set_config_option', params: { sessionId, configId, value: model }, apply: (result) => Object.assign(config, parseConfig(result, { ...config, model })) }
      : { method: 'session/set_model', params: { sessionId, modelId: model }, apply: () => { config.model = model; } };
  }
  if (config.effortConfigId && config.efforts.length) {
    const wanted = nearestEffort(effort, config.efforts.map((e) => e.effort));
    const value = config.efforts.find((e) => e.effort === wanted)?.value;
    if (value && value !== config.effort) {
      const configId = config.effortConfigId;
      return { method: 'session/set_config_option', params: { sessionId, configId, value }, apply: (result) => Object.assign(config, parseConfig(result, { ...config, effort: value })) };
    }
  }
  return undefined;
}
