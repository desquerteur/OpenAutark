// B-078 (D14, D16): which engine and model take the temperature an agent asks for (model.set) – one answer for the tool's
// reply, read from the adapters' own rules: the compatible engine sends it always, the OpenAI API to models without
// reasoning, the Anthropic API to models without thinking; Claude Code, Codex and ACP CLIs keep their own.
// Owns: that yes/no. Never: sends anything or decides the value an adapter puts on the wire (the adapters do).

import { anthropicTemperature } from './anthropic.ts';
import { openAiTemperature } from './openai.ts';

/** True when a turn of this engine on this provider model sends the temperature. */
export function takesTemperature(engine: string, model: string): boolean {
  if (engine === 'compatible' || engine === 'fake') return true;
  if (engine === 'openai') return openAiTemperature(model, 1) !== undefined;
  if (engine === 'anthropic') return anthropicTemperature(model, 1) !== undefined;
  return false;
}
