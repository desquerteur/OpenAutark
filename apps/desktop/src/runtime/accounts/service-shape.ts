// AccountService's input and dependency shapes, its additions to the AccountService contract and the
// default account labels per provider (split from service.ts, B-044 integration).
// Owns: these shapes and labels. Never: behaviour – the service is accounts/service.ts.

import type { Clock, EngineRegistry, Logger, Paths } from '../contracts.ts';
import type { Bus } from '../bus.ts';
import type { Db } from '../db/database.ts';
import type { Account, ProviderId } from '../../shared/model/providers.ts';
import type { Supervisor } from '../system/supervisor.ts';
import type { ResetOutcome } from '../../shared/api/methods-providers.ts';
import type { ExecutableFinder } from './executables.ts';
import type { DetectDeps } from './detect.ts';
import type { SignInDeps } from './sign-in.ts';
import type { SecretPort } from './connect.ts';
import type { EndpointTestInput } from './endpoint-test.ts';
import type { ProviderSettings } from './provider-file.ts';

export interface AddAccountInput {
  provider: ProviderId; label?: string; apiKey?: string; baseUrl?: string; rotation?: boolean;
  /** PR5: use the provider key in this environment variable (ENV_KEY_PROVIDERS) – read when needed, never stored. */
  envVar?: string;
  /** PR5 "Add again": the dismissed login in the provider's default CLI home that detection found on this PC. */
  detected?: boolean;
  /** The fake engine's own row (runtime/main.ts): no connection of settings.json, so demo profiles keep "compatible:<model>". */
  demoEngine?: boolean;
}

declare module '../contracts/models.ts' {
  interface AccountService {
    /** Addition (PR5): `envVar` connects a key from the environment, `detected` adds a dismissed login found on this PC again. B-051: `signInUrl` = the page a CLI sign-in printed (never stored). */
    add(input: AddAccountInput): Promise<Account & { signInUrl?: string }>;
    /** B-051 L4: `page` – also the sign-in page the CLI printed (the person's own UI only; agent tools never ask for it). */
    login(id: string, options?: { page?: boolean }): Promise<{ started: boolean; url?: string }>;
    /** B-044 (optional so simple fakes stay valid): redeems one banked Codex reset after the person confirmed (resets.ts). */
    useReset?(id: string, creditId?: string): Promise<ResetOutcome>;
    /** B-044 (optional like useReset): the model ids an API endpoint lists before it is saved (endpoint-test.ts). */
    test?(input: EndpointTestInput): Promise<{ models: string[] }>;
  }
}

export interface AccountServiceDeps {
  /** `data` → the empty engine folder CLIs start in (system/paths.ts engineCwd); without it temp, else the OS temp. */
  db: Db; bus: Bus; clock: Clock; paths: Pick<Paths, 'accounts'> & Partial<Pick<Paths, 'data' | 'temp'>>; log?: Logger;
  engines: () => EngineRegistry; // lazy: the registry also depends on this service (apiKey)
  finder: ExecutableFinder; supervisor: Supervisor; secrets: SecretPort;
  /** settings.json: its `providers` section is where API connections live (provider-file.ts); absent (tests): they stay in the table. */
  settings?: ProviderSettings;
  detectDeps?: Partial<DetectDeps>;
  env?: NodeJS.ProcessEnv;
  version?: string; // what ACP sign-in probes report as the client version
  mkdir?: (dir: string) => Promise<void>;
  rmdir?: (dir: string) => Promise<void>;
  /** Demo/test mode: the deterministic fake engine serves 'compatible' accounts; real logins are never detected. */
  demo?: boolean;
  /** Platform and PATH lookup of the sign-in terminal window (tests). */
  terminal?: SignInDeps['terminal'];
  /** B-051 L4: how long add()/login() wait for the sign-in page a CLI prints (default sign-in.ts URL_WAIT_MS; tests 0). */
  signInUrlMs?: number;
  /** B-049 F3: the folder for ACP plan CLIs' replacement system prompts (system/paths.ts enginePromptDir); none = no CLI's own prompt is replaced. */
  enginePrompts?: string;
}

/** The default label of a new account per provider (also: which providers can be added). */
export const PROVIDER_LABELS: Partial<Record<ProviderId, string>> = {
  codex: 'Codex', claude: 'Claude Code', openai: 'OpenAI API', anthropic: 'Anthropic API', openrouter: 'OpenRouter',
  google: 'Gemini API', xai: 'xAI API', deepseek: 'DeepSeek API', ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', vllm: 'vLLM',
  compatible: 'Custom server', 'gemini-cli': 'Gemini CLI', copilot: 'Copilot CLI',
  'kimi-cli': 'Kimi Code', groq: 'Groq API', elevenlabs: 'ElevenLabs', fal: 'fal.ai', // B-058
  'decision-api': 'Decision API',
};
