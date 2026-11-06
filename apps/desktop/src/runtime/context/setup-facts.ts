// The app's live state: what is really connected right now – first run, spaces, agents per space with their
// managers, accounts, usable strong models, routing cost mode, linked PCs, paired phones/browsers,
// chat bridges – returned by the read tool app.status (tools/builtin/app-status.ts; G1: was setup.status).
// Manager-mode turns get a part of them in their volatile prompt (prompt-volatile.ts): '## Team and models (live)' –
// the agents per space, the accounts, the usable strong models and the models that answer decisions and search by
// meaning now, by name (usesLine, also models.list; B-072: was the stored "auto", which agents read as nothing chosen). E1 (01.11.2026):
// the whole list under '## Setup (live)' in every manager turn (onboarding finished, spaces none yet, paid API fallback
// off, phone access off, Telegram off …) read like a checklist of the app to work through: Codex took "Alles einrichten"
// as configuring the app in every live test and named the off switches as reasons to ask. The rest stays one call away.
// Every other mode gets the compact account line of context/environment.ts (B-047 D6), which reuses cleanLabel.
// B-078 (D16): every agent's stable "My environment" also carries one models line (modelsFactsLine: price, smarts, plan/key/local).
// Owns: collecting those facts from their services (each source in its own try/catch – a failing
// source is left out, never fatal) and the compact renderings with their hard cap (SETUP_CAP).
// Never: shows account emails, CLI homes, base URLs, secret ids, limit details or tokens, and
// never writes anything.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent, Space } from '../../shared/model/org.ts';
import { DECISION_PROVIDER, type AccountState, type ModelInfo, type ProviderId } from '../../shared/model/providers.ts';
import type { BridgeStatus } from '../../shared/model/bridges.ts';
import { chosenFor, useValue, USE_AUTO, USE_LOCAL, USE_OFF } from '../../shared/model/models-uses.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { TokenService } from '../pwa/tokens.ts';
import { BridgeRepo } from '../bridges/repo.ts';
import { decisionConnection } from '../decision/systemone.ts';
import { isDecisionModelName } from '../models/catalog-merge.ts';
import { embeddingChoice } from '../models/embeddings.ts';
import { helperModel } from '../routing/helper-default.ts';
import { resolvePin } from '../routing/pins.ts';
import { factsLine } from '../routing/model-facts.ts';
import { LOCAL_EMBEDDING_NAME, LocalEmbedder } from '../vectors/local-model.ts';

export const APP_STATUS_HEADER = '## App status (live)';
/** The manager prompt's part of the facts (setupFactsSection). */
export const TEAM_HEADER = '## Team and models (live)';
/** Hard cap of the rendered section (header included). */
export const SETUP_CAP = 1650;
const EMAIL = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi;

export interface SetupFacts {
  onboarding?: { completed: boolean };
  spaces?: Array<{ name: string; kind: Space['kind'] }>;
  agents?: { active: number; bySpace: Array<{ space: string; count: number; managers: string[] }> };
  accounts?: Array<{ provider: ProviderId; label: string; state: AccountState; plan?: string }>;
  models?: { strong: string[]; other: string[] };
  routing?: { costMode: string; paidFallback: boolean };
  /** What answers these two uses now, in words (useWords). */
  uses?: UseWords;
  linkedPcs?: Array<{ name: string; online: boolean }>;
  /** B-078 (D5): access is the accepted rows – `bind` only when browsers reach this PC beyond itself (lan, tailscale). */
  phones?: { bind?: string; paired: number };
  bridges?: { telegram: number; byStatus: Partial<Record<BridgeStatus, number>> };
}

/** An account label without e-mail addresses (a label is free text; the email stays private). Also context/environment.ts. */
export function cleanLabel(label: string, email?: string): string {
  let out = label;
  if (email?.trim()) out = out.split(email.trim()).join('');
  out = out.replace(EMAIL, '').replace(/\s*[·(]\s*\)?\s*$/, '').trim();
  return excerpt(out, 40) || 'unnamed';
}

/** What answers decisions and what searches by meaning now, each in a few words. */
export interface UseWords { decision: string; embeddings: string }

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

/** "<model> on <account>": the account's label without its e-mail, else the provider. */
function onAccount(services: RuntimeServices, model: string, accountId: string | undefined, provider: string): string {
  const account = accountId ? services.accounts.list().find((entry) => entry.id === accountId) : undefined;
  return `${model} on ${account ? cleanLabel(account.label, account.email) : provider}`;
}

/** A model made for decisions: one of a decision connection, or a decision family a server lists (nimble, tev1 …). */
export const isDecisionModel = (model: Pick<ModelInfo, 'provider' | 'model'>): boolean => model.provider === DECISION_PROVIDER || isDecisionModelName(model.model);

/** A decision connection, else the chat model that stands in: a model chosen for decisions, else the helper default's. */
function decisionWords(services: RuntimeServices): string {
  const connection = decisionConnection(services);
  if (connection) return `${onAccount(services, connection.model, connection.account.id, connection.account.provider)} (a decision model)`;
  const models = services.catalog.list();
  const chosen = chosenFor(services.settings.get().routing, 'decision');
  const pinned = chosen ? resolvePin(models, chosen) : undefined;
  const pick = pinned?.available ? { model: pinned, accountId: pinned.accounts[0] } : helperModel(services);
  const gone = chosen && !pinned?.available ? `; ${chosen} is not available now` : '';
  if (!pick) return `no model connected${gone}`;
  const none = models.some((model) => model.available && isDecisionModel(model)) ? 'no decision model chosen' : 'no decision model connected';
  const kind = isDecisionModel(pick.model) ? 'a decision model' : `a chat model; ${none}`;
  return `${onAccount(services, pick.model.name, pick.accountId, pick.model.provider)} (${kind}${gone})`;
}

/** The embedding model vector.embed and vector.search use now (models/embeddings.ts). */
function searchWords(services: RuntimeServices): string {
  const stored = useValue(services.settings.get().routing, 'embeddings');
  if (stored === USE_OFF) return 'off';
  const possible = quiet(() => new LocalEmbedder({ dataDir: services.paths.data }).possible(), false);
  const choice = embeddingChoice(services, possible);
  if (choice?.kind === 'local') return `${LOCAL_EMBEDDING_NAME} on this PC`;
  if (choice) return onAccount(services, choice.model, choice.accountId, choice.provider);
  return stored === USE_AUTO ? 'no embedding model connected' : `${stored === USE_LOCAL ? LOCAL_EMBEDDING_NAME : stored} is not available now`;
}

/** Both, read now without a route (a turn's router can differ for a moment, routing/helper-default.ts helperModel). */
export function useWords(services: RuntimeServices): UseWords {
  return { decision: decisionWords(services), embeddings: searchWords(services) };
}

const usesText = (uses: UseWords) => `Decisions: ${uses.decision} · Search by meaning: ${uses.embeddings} (settings.json routing.decision, routing.embeddings)`;

/** The live line of these two uses, by model name (the manager's turn, app.status, models.list). */
export function usesLine(services: RuntimeServices): string {
  return usesText(useWords(services));
}

function isManager(agent: Agent, active: Agent[]): boolean {
  return agent.mode === 'manager' || active.some((other) => other.managerId === agent.id);
}

function agentFacts(services: RuntimeServices): NonNullable<SetupFacts['agents']> {
  const active = services.org.list().filter((agent) => !agent.archivedAt);
  const spaces = services.org.spaces().filter((space) => !space.archivedAt);
  const groups = [...spaces.map((space) => ({ id: space.id as string | undefined, name: space.name })), { id: undefined, name: spaces.length ? 'no space' : '' }]; // G1: no spaces at all – no "no space" group
  const known = new Set(spaces.map((space) => space.id));
  const bySpace = groups.map((group) => {
    const members = active.filter((agent) => (group.id ? agent.spaceId === group.id : !agent.spaceId || !known.has(agent.spaceId)));
    return { space: group.name, count: members.length, managers: members.filter((agent) => isManager(agent, active)).map((agent) => agent.name) };
  }).filter((group) => group.count > 0);
  return { active: active.length, bySpace };
}

function modelFacts(services: RuntimeServices): NonNullable<SetupFacts['models']> {
  const rank = (model: ModelInfo) => (model.tier === 'frontier' ? 2 : model.tier === 'strong' ? 1 : 0) * 1000 + Math.round((model.relCost ?? 0) * 100); // within a tier the pricier first
  const usable = services.catalog.list().filter((model) => model.available).sort((a, b) => rank(b) - rank(a));
  const strong = usable.filter((model) => model.tier === 'frontier' || model.tier === 'strong');
  return { strong: strong.map((model) => model.name), other: usable.filter((model) => !strong.includes(model)).map((model) => `${model.name} (${model.tier})`) };
}

/**
 * B-078 (D16): the models line of every agent's stable prompt ("My environment", context/environment.ts) – the connected
 * work models with list price, smarts and how a turn on each is paid (routing/model-facts.ts factsLine); '' when the catalog
 * cannot be read or nothing is connected. It changes only when connections or the priors change.
 */
export function modelsFactsLine(services: RuntimeServices): string {
  return quiet(() => factsLine(services.catalog.list(), services.accounts.list()), '');
}

/** The linked PCs (not this one, not removed or half-paired) and whether each is online now; throws without devices. Also
 *  context/environment.ts and companies.list (B-075). */
export function linkedPcs(services: RuntimeServices): Array<{ name: string; online: boolean }> {
  return services.devices.list()
    .filter((device) => device.kind === 'pc' && !device.self && !device.revokedAt && device.status !== 'revoked' && device.status !== 'pairing')
    .map((device) => ({ name: device.name, online: services.devices.online(device.id) }));
}

/** Collects every fact; a source that throws (or is not wired) is skipped and logged. */
export function collectSetupFacts(services: RuntimeServices): SetupFacts {
  const facts: SetupFacts = {};
  const read = <K extends keyof SetupFacts>(key: K, build: () => SetupFacts[K]) => {
    try {
      const value = build();
      if (value !== undefined) facts[key] = value;
    } catch (error) {
      try { services.log?.debug('setup fact skipped', { source: key, error: String(error) }); } catch { /* no logger */ }
    }
  };
  read('onboarding', () => ({ completed: Boolean(services.settings.get().onboarding.completed) }));
  read('spaces', () => services.org.spaces().filter((space) => !space.archivedAt).map((space) => ({ name: space.name, kind: space.kind })));
  read('agents', () => agentFacts(services));
  read('accounts', () => services.accounts.list().map((account) => {
    const item: { provider: ProviderId; label: string; state: AccountState; plan?: string } = {
      provider: account.provider, label: cleanLabel(account.label, account.email), state: account.enabled === false ? 'disabled' : account.state,
    };
    if (account.plan?.trim()) item.plan = excerpt(account.plan, 20);
    return item;
  }));
  read('models', () => modelFacts(services));
  read('routing', () => {
    const routing = services.settings.get().routing;
    return { costMode: routing.costMode, paidFallback: Boolean(routing.allowPaidFallback) };
  });
  read('uses', () => useWords(services));
  read('linkedPcs', () => linkedPcs(services));
  read('phones', () => {
    const settings = services.settings.get();
    const paired = new TokenService(services.db, services.clock).devices().length;
    const phones: NonNullable<SetupFacts['phones']> = { paired };
    if (settings.pwa?.bind && settings.pwa.bind !== 'localhost') phones.bind = settings.pwa.bind;
    return phones;
  });
  read('bridges', () => {
    const telegram = new BridgeRepo(services.db).list().filter((bridge) => bridge.kind === 'telegram');
    const byStatus: Partial<Record<BridgeStatus, number>> = {};
    for (const bridge of telegram) byStatus[bridge.status] = (byStatus[bridge.status] ?? 0) + 1;
    return { telegram: telegram.length, byStatus };
  });
  return facts;
}

/**
 * `head` + whole items joined by `separator` within `budget` characters, then "+N more" for the
 * rest (the count always survives the cap); `empty` when there are no items.
 */
function listLine(head: string, items: string[], budget: number, separator = ', ', empty = 'none'): string {
  if (!items.length) return excerpt(head + empty, budget);
  let line = head;
  let shown = 0;
  for (const item of items) {
    const rest = items.length - shown - 1;
    const next = (shown ? separator : '') + item;
    if (line.length + next.length + (rest ? ` +${rest} more`.length : 0) > budget) break;
    line += next;
    shown += 1;
  }
  if (!shown) {
    line += excerpt(items[0], Math.max(12, budget - line.length - ` +${items.length} more`.length));
    shown = 1;
  }
  return shown < items.length ? `${line} +${items.length - shown} more` : line;
}

const name = (value: string) => excerpt(value, 32);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One "- " line per known fact, each within its own budget (the budgets, header and newlines sum below SETUP_CAP); `only`: these facts. */
function lines(facts: SetupFacts, only?: ReadonlySet<keyof SetupFacts>): string[] {
  if (only) facts = Object.fromEntries(Object.entries(facts).filter(([key]) => only.has(key as keyof SetupFacts))) as SetupFacts;
  const out: string[] = [];
  const add = (budget: number, line: string) => out.push(excerpt(`- ${line}`, budget));
  if (facts.onboarding) add(70, `First run: ${facts.onboarding.completed ? 'finished' : 'not finished'}`);
  if (facts.spaces) out.push(listLine('- Spaces: ', facts.spaces.map((space) => `${name(space.name)} (${space.kind})`), 150, ', ', 'none'));
  if (facts.agents) {
    const managersOf = (list: string[]) => {
      const names = list.slice(0, 2).map(name).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
      return list.length ? ` (manager${list.length === 1 ? '' : 's'} ${names})` : '';
    };
    const [only] = facts.agents.bySpace;
    if (facts.agents.bySpace.length === 1 && !only.space) add(230, `Agents: ${facts.agents.active} active${managersOf(only.managers)}`);
    else out.push(listLine(`- Agents: ${facts.agents.active} active – `, facts.agents.bySpace.map((group) => `${name(group.space)} ${group.count}${managersOf(group.managers)}`), 230, ' · ', 'none'));
  }
  if (facts.accounts) {
    const accounts = facts.accounts.map((account) => `${account.label} (${[account.provider, account.state, account.plan ? `plan ${account.plan}` : ''].filter(Boolean).join(', ')})`);
    out.push(listLine('- Accounts: ', accounts, 320, '; ', 'none connected'));
  }
  if (facts.models) {
    const strong = facts.models.strong.slice(0, 3).map(name);
    const other = facts.models.other.slice(0, 2).map(name);
    add(130, strong.length
      ? `Strong model: usable – ${strong.join(', ')}`
      : `Strong model: none usable${other.length ? ` (usable: ${other.join(', ')})` : ' (no model usable)'}`);
  }
  if (facts.uses) add(300, usesText(facts.uses));
  if (facts.routing) add(70, `Routing: cost mode ${facts.routing.costMode} · paid API fallback ${facts.routing.paidFallback ? 'on' : 'off'}`);
  if (facts.linkedPcs) out.push(listLine('- Linked PCs: ', facts.linkedPcs.map((pc) => `${name(pc.name)} (${pc.online ? 'online' : 'offline'})`), 130));
  if (facts.phones) {
    const phones = facts.phones;
    add(100, `Paired phones/browsers: ${phones.paired}${phones.bind ? ` · browsers reach this PC over ${phones.bind}` : ''}`);
  }
  if (facts.bridges) {
    const statuses = Object.entries(facts.bridges.byStatus).map(([status, count]) => `${count} ${status}`).join(', ');
    add(90, `Chat bridges: ${facts.bridges.telegram ? `Telegram on – ${plural(facts.bridges.telegram, 'chat')} (${statuses})` : 'Telegram off'}`);
  }
  return out;
}

function render(header: string, body: string[]): string {
  if (!body.length) return '';
  const text = [header, ...body].join('\n');
  return text.length > SETUP_CAP ? `${text.slice(0, SETUP_CAP - 1).trimEnd()}…` : text;
}

/** The '## App status (live)' text of app.status (≤ SETUP_CAP characters); '' when no source could be read. */
export function renderSetupFacts(facts: SetupFacts): string {
  return render(APP_STATUS_HEADER, lines(facts));
}

/** The facts a manager's turn carries: the team, the accounts, the strong models and what answers decisions and search. */
const TEAM_FACTS: ReadonlySet<keyof SetupFacts> = new Set(['agents', 'accounts', 'models', 'uses']);

/** The '## Team and models (live)' part of the facts; '' when none of them could be read. */
export function renderTeamFacts(facts: SetupFacts): string {
  return render(TEAM_HEADER, lines(facts, TEAM_FACTS));
}

/** Collect + render the manager prompt's section in one call (prompt-volatile.ts). */
export function setupFactsSection(services: RuntimeServices): string {
  return renderTeamFacts(collectSetupFacts(services));
}
