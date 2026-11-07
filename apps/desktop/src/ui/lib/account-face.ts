// The picture and the kind of an account (AF-009 – owner 07.11.2026: where a picture belongs the quota rail and the
// account rows showed an empty space; "nie eine leere Fläche"). One rule for every account, in this order:
//   the provider's logo (a small inline SVG, lib/provider-logos.tsx – never loaded from the network);
//   else the account's own avatar (a local image URL the caller has: blob: or data:image/; a remote address never loads);
//   else the initials of its name in a stable palette colour – also when the avatar fails to load (lib/account-avatar.tsx).
// The kind is one quiet word for what the account is: a subscription (a CLI plan, with its tier), an API key or a
// local server.
// Owns: these choices. Never: draws (lib/account-avatar.tsx), fetches or reads the store.

import type { ProviderId } from '../../shared/model/providers.ts';
import { initials } from './format.ts';

/** The marks lib/provider-logos.tsx draws. */
export type LogoId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'github';

export type AccountFaceView =
  | { kind: 'logo'; logo: LogoId }
  | { kind: 'avatar'; src: string }
  | { kind: 'initials'; text: string; color: number };

export interface AccountFaceInput {
  provider: ProviderId | string;
  /** The name shown beside the picture; the initials come from it. */
  name: string;
  /** The account's own picture, when the caller has one (a local URL). */
  avatar?: string;
  /** The named service of a connection (shared/model/providers-connect.ts serviceOfAccount id), e.g. 'openai' for an OpenAI-compatible key on api.openai.com. */
  service?: string;
}

/** Provider or named service → its logo. */
const LOGOS: Readonly<Record<string, LogoId>> = {
  claude: 'anthropic', anthropic: 'anthropic',
  codex: 'openai', openai: 'openai',
  google: 'gemini', 'gemini-cli': 'gemini',
  ollama: 'ollama',
  copilot: 'github',
};

/** Colours of the initials placeholder (tokens.css --av-0…5, the same palette as lib/avatar.tsx). */
const PALETTE = 6;

/** The logo of a provider, else of the connection's named service; undefined when there is none. */
export function logoOf(provider: string, service?: string): LogoId | undefined {
  if (Object.hasOwn(LOGOS, provider)) return LOGOS[provider];
  return service && Object.hasOwn(LOGOS, service) ? LOGOS[service] : undefined;
}

/** A picture this window may show without going to the network: an object URL or an inline image. */
export function isLocalImage(src: string | undefined): src is string {
  return typeof src === 'string' && /^(blob:|data:image\/)/i.test(src.trim());
}

/** Up to two letters of the name's first words ("LM Studio" → "LS", "llama.cpp" → "LC", "Kimi (Moonshot)" → "KM"). */
export function faceInitials(name: string): string {
  return initials(name.replace(/[^\p{L}\p{N}\s]+/gu, ' '));
}

/** A stable palette index for a seed (the same hash as lib/avatar.tsx paletteIndex). */
export function faceColor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % PALETTE;
}

/** Logo → avatar → initials. `avatarFailed`: the avatar did not load, so the initials stand in. */
export function accountFace(input: AccountFaceInput, avatarFailed = false): AccountFaceView {
  const logo = logoOf(input.provider, input.service);
  if (logo) return { kind: 'logo', logo };
  if (!avatarFailed && isLocalImage(input.avatar)) return { kind: 'avatar', src: input.avatar.trim() };
  const name = input.name.trim() || input.provider;
  const text = faceInitials(name);
  return { kind: 'initials', text: text === '?' ? faceInitials(input.provider) : text, color: faceColor(name) };
}

// ------------------------------------------------------------------ the kind

export type AccountKind = 'plan' | 'api' | 'local';

export const KIND_LABELS: Readonly<Record<AccountKind, string>> = { plan: 'Subscription', api: 'API key', local: 'Local server' };

const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);

/** A CLI sign-in is a subscription (Codex, Claude Code, Gemini CLI, Copilot CLI, Kimi Code); a local server; else a key. */
export function accountKind(account: { provider: string; auth?: string }): AccountKind {
  if (account.auth === 'local' || LOCAL_PROVIDERS.has(account.provider)) return 'local';
  return account.auth === 'cli' ? 'plan' : 'api';
}

/** "Max subscription", "Subscription", "API key", "Local server" – the tier only for a subscription that reports one. */
export function kindText(account: { provider: string; auth?: string; plan?: string }): string {
  const kind = accountKind(account);
  const tier = kind === 'plan' ? account.plan?.trim() : undefined;
  return tier ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)} ${KIND_LABELS.plan.toLowerCase()}` : KIND_LABELS[kind];
}
