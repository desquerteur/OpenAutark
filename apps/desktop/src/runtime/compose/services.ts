// Composition root, part 1: builds every RuntimeServices member and wires late bindings.
// Owns: construction order and the few adapters between modules (secret port for accounts,
// MCP base URL, the media hook on the file store and its fetch of another PC's bytes, the theme and connector file watchers). Never:
// business logic – each module owns its behaviour.
// A notification that pushes here also reaches the phones of the owner's other PCs (devices/sync/notify.ts, 'notify.relay').
//
// Late binding: modules receive `services: () => RuntimeServices` (or the shared record `s`
// itself, which is filled progressively), so construction order only matters for start-up
// side effects, never for references.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DetectionReport } from '../../shared/model/providers.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import type { Logger, Paths, RuntimeServices } from '../contracts.ts';
import type { Host } from '../host.ts';
import { Bus } from '../bus.ts';
import { openDatabase, upgradePending } from '../db/upgrade.ts';
import { systemClock } from '../system/clock.ts';
import { databasePath, enginePromptDir } from '../system/paths.ts';
import { Supervisor } from '../system/supervisor.ts';
import { SettingsStore } from '../settings/service.ts';
import { watchRemovedChats } from '../root/side-tabs.ts';
import { watchTheme } from '../root/theme.ts';
import { watchPages } from '../root/pages.ts';
import { SecretVault } from '../secrets/service.ts';
import { Blobs } from '../files/store.ts';
import { needBlob } from '../devices/sync/blobs.ts';
import { RELAY_METHOD, receiveNotification, relayNotification } from '../devices/sync/notify.ts';
import { extractPdfText } from '../files/pdf.ts';
import { Org } from '../org/service.ts';
import { ChatServiceImpl } from '../chat/service.ts';
import { DeliveryServiceImpl } from '../chat/delivery.ts';
import { TaskServiceImpl } from '../tasks/service.ts';
import { OwnershipServiceImpl } from '../tasks/ownership.ts';
import { ChatRedelivery } from '../agents/redelivery.ts';
import { WakeQueueImpl } from '../wakes/queue.ts';
import { SchedulerImpl } from '../schedules/scheduler.ts';
import { NextDueFile } from '../schedules/next-due.ts'; // B-044: the launcher's next-due.json
import { Journal } from '../runs/journal.ts';
import { KnowledgeStore } from '../knowledge/service.ts';
import { profileZone } from '../context/time.ts'; // B-044: a hit's saved day in the person's zone
import { createDataLifecycle } from './data-lifecycle.ts';
import { SkillLibrary } from '../skills/service.ts';
import { createAgentCore, mainSkillOptions } from './agent-core.ts';
import { RootWatcher } from '../root/watcher.ts'; // B-044: the open data folder's one watcher
import '../contracts/root.ts';
import '../contracts/secret-files.ts';
import { SecretFiles } from '../secrets/files.ts'; // B-044: <data>/secrets/<id>.md
import '../contracts/open-fs.ts'; // B-044: s.prompts, s.rootMaps
import { PromptTemplates, renderTemplate, standardRuleValues } from '../context/templates.ts';
import { RootMaps } from '../root/readme.ts';
import { createChatMirror } from './chat-files.ts'; // B-050 K8: <data>/chats
import { standingRuleValues } from '../org/hire.ts';
import { ModeLibrary } from '../modes/service.ts';
import { Notifications } from '../notify/service.ts';
import { AccountServiceImpl } from '../accounts/service.ts';
import type { AccountMonitor } from '../accounts/monitor.ts';
import { ExecutableFinder } from '../accounts/executables.ts';
import { claudeTranscriptsDir, createEngineRegistry, type EngineRegistry } from '../engines/registry.ts';
import { Priors } from '../models/priors.ts';
import { Catalog } from '../models/catalog.ts';
import { RouterImpl } from '../routing/router.ts';
import { Spend } from '../spend/ledger.ts';
import { Context } from '../context/service.ts';
import { WorkPresence } from '../work-presence/service.ts'; // B-055 G (Q11)
import '../work-presence/contract.ts'; // RuntimeServices.workPresence
import { SubconsciousImpl } from '../subconscious/service.ts';
import { ContextLedgerService } from '../context/ledger/service.ts';
import { SessionSweep, transcriptFiles } from '../agents/session-sweep.ts';
import { Registry } from '../tools/registry.ts';
import { registerBuiltinTools } from '../tools/builtin/index.ts';
import { TurnExecutor } from '../agents/turn.ts';
import { DispatcherImpl } from '../agents/dispatcher.ts';
import { WorkStop, bindWorkStop } from '../agents/work-stop.ts';
import { createCalls } from '../calls/wiring.ts';
import { createCalendar } from './calendar.ts'; // B-041 My day: calendar, sources, estimates, day service, morning run
import { createSplits } from './splits.ts'; // B-057: an agent split into parallel workers (services.splits)
import { Mcp } from '../mcp/hub.ts';
import '../contracts/apps.ts'; // RuntimeServices.apps
import { createApps } from '../apps/index.ts'; // connectors: MCP servers and mailboxes from <data>/connectors
import { DeviceIdentity } from '../devices/identity.ts';
import { DeviceMesh } from '../devices/mesh.ts';
import { MediaService } from '../media/service.ts';
import { withMediaHook } from '../media/hook.ts';
import { createDecisionHub } from './decisions.ts';
import { dialPeer } from './peer-dial.ts';
import { Transcriber } from '../voice/transcribe.ts';
import { createVectors } from '../vectors/create.ts';
import { LocalSpeech } from '../voice/local/service.ts';
import { LocalSpeechAuto } from '../voice/local/auto.ts'; // B-058 G1
import '../contracts/relogin.ts';
import { Relogin } from '../accounts/relogin.ts'; // B-047 D10: a sign-out becomes work
import '../contracts/evidence.ts';
import { createEvidenceChecker } from '../subconscious/verify-evidence.ts'; // B-047 D11: files exist, links answer – before the verifier

export interface CoreOptions {
  host: Host;
  paths: Paths;
  log: Logger;
  version: string;
  fakeEngine?: boolean;
  /** Base URL of the runtime HTTP server once it listens (MCP leases, peer addresses). */
  baseUrl: () => string;
}

export interface Core {
  services: RuntimeServices;
  supervisor: Supervisor;
  finder: ExecutableFinder;
  engines: EngineRegistry;
  catalog: Catalog;
  dispatcher: DispatcherImpl;
  scheduler: SchedulerImpl;
  mcp: Mcp;
  mesh: DeviceMesh;
  identity: DeviceIdentity;
  secrets: SecretVault;
  knowledge: KnowledgeStore;
  org: Org;
  chats: ChatServiceImpl;
  /** Media library (R4); every stored file reaches media.onFileStored through the FileStore hook. */
  media: MediaService;
  refreshDetection(force?: boolean): Promise<DetectionReport | undefined>;
  /** Keeps plan state and quota readings current (PR2); main starts it and feeds power events. */
  accountMonitor: AccountMonitor;
}

export async function createCore(options: CoreOptions): Promise<Core> {
  const { host, paths, log } = options;
  const clock = systemClock;
  // Upgrade safety: one pre-update copy (VACUUM INTO) before migrating older data; a failure is an UpgradeError (repair screen).
  // A large database takes longer to copy than main waits for ready: ask for the long boot wait (as for a restore).
  if (upgradePending(databasePath(paths))) await host.extendBoot?.('restore').catch(() => undefined);
  const db = openDatabase({ file: databasePath(paths), dataDir: paths.data, version: options.version, now: () => clock.now(), log });
  const bus = new Bus((error, event) => log.warn('bus listener failed', { event, error: String(error) }));

  // The shared record every module sees. Filled below; getters read it lazily.
  const s = { clock, log, paths, host, db, bus } as RuntimeServices;
  const services = () => s;
  // B-044: the one watcher on <data> (root/watcher.ts); the file owners (agent core, settings, secrets …) register their entry. Stop step 'data folder'.
  s.rootWatcher = new RootWatcher({ root: paths.data, clock, log });
  s.rootWatcher.start();

  // <data>/settings.json is the only settings store (settings/service.ts; the AI edits it – skill app-settings). `db`: the one-time move of old rows.
  const settings = new SettingsStore({ db, bus, clock, log, dataDir: paths.data, root: s.rootWatcher });
  s.settings = settings;
  // <data>/theme.css is the app's look (root/theme.ts): an edit is pushed as theme.updated; stopping s.rootWatcher ends it.
  watchTheme({ dataDir: paths.data, root: s.rootWatcher, bus, log });
  watchPages({ dataDir: paths.data, root: s.rootWatcher, bus }); // <data>/pages: custom tabs of the side pane (root/pages.ts)
  watchRemovedChats({ dataDir: paths.data, bus, log }); // a deleted chat's space leaves <data>/side-tabs.json (root/side-tabs.ts)
  const secrets = new SecretVault({ db, host, clock, log });
  await secrets.init();
  s.secrets = secrets;
  // B-044: the vault's metadata files (secrets/files.ts): missing ones written, disk edits of name/purpose taken over. Stop step 'secret files'.
  s.secretFiles = new SecretFiles({ dataDir: paths.data, vault: secrets, clock, log, bus, root: s.rootWatcher });
  await s.secretFiles.start();
  const media = new MediaService({ services });
  // A file row that came from another of the person's PCs gets its bytes from there when it is first read (devices/sync/blobs.ts).
  const blobs = new Blobs({ db, blobs: paths.blobs, clock, log, pdfText: extractPdfText, missing: (id) => needBlob(s, id) });
  const keepBlob = blobs.put.bind(blobs); // long tool outputs kept for the context ledger stay out of the media library
  s.files = withMediaHook(blobs, (file) => media.onFileStored(file), log);

  const supervisor = new Supervisor({ log });
  const finder = new ExecutableFinder();
  // B-044: one prompt set for the runtime – the shipped prompts and the person's own versions in <data>/prompts (any prompt, rules.md included).
  const prompts = new PromptTemplates(() => path.join(paths.resources, 'prompts'), () => log, { data: () => paths.data });
  if (s.rootWatcher) prompts.watch(s.rootWatcher);
  s.prompts = prompts;
  // B-044: every hire starts with the standing rules (prompts/agent-default.md – org/hire.ts); B-076: the team's rules inside.
  const standingRules = (values?: Readonly<Record<string, string>>) => renderTemplate(prompts.standardTemplate(), { ...standardRuleValues(standingRuleValues(settings.get())), ...values }); // B-047: + creator, role
  const org = new Org({ db, bus, clock, templatesDir: path.join(paths.resources, 'agents'), standingRules, standingTemplate: () => prompts.standardTemplate(), log, companyName: () => settings.get().profile.company });
  s.org = org;
  s.wakes = new WakeQueueImpl({ db, clock });
  s.runs = new Journal({
    db, bus, clock, log, // a captured run's tool output over 4,000 characters is kept whole in a blob (the ledger restores it)
    keepOutput: async (text, name, runId) => (s.ledger?.holds?.(runId) ? (await keepBlob(new TextEncoder().encode(text), `${name.replace(/[^a-z0-9_.-]/gi, '_')}-output.txt`, 'text/plain')).id : undefined),
  });
  // C3: the chat's notification level and sound filter pushes and toasts (chats are built next; late-bound).
  // A notification that pushes here goes to the online CEO PCs too (the mesh is built below; late-bound).
  const notifications = new Notifications({ bus, host, settings, clock, log, chat: (id) => s.chats?.get(id), relay: (pushed) => relayNotification(s, pushed) });
  s.notifications = notifications;
  const chats = new ChatServiceImpl(s);
  s.chats = chats;
  s.delivery = new DeliveryServiceImpl(s);
  // B-050 K4: the quiet pickup of a person's silent lines (chat/quiet-pickup.ts) runs from the dispatcher's idle moment (agents/dispatcher.ts).
  s.tasks = new TaskServiceImpl(s);
  s.ownership = new OwnershipServiceImpl(s);
  const scheduler = new SchedulerImpl(s, { nextDue: new NextDueFile(paths.data, { log }) }); // settled at the scheduler's stop
  s.scheduler = scheduler;

  const knowledge = new KnowledgeStore({ db, clock, log, bus, redact: (text) => secrets.redact(text), zone: () => profileZone(s), root: path.join(paths.data, 'memory'), vectors: () => s.vectors, writes: s.rootWatcher });
  s.knowledge = knowledge;
  // Retention of old knowledge versions and the provider histories (compose/data-lifecycle.ts).
  createDataLifecycle(s, knowledge);
  // Skills are plain folders with a SKILL.md (shipped, the workspace library, agents' own and Main Skills).
  const skillLibrary = new SkillLibrary({ paths, clock, log, ...mainSkillOptions(s) });
  s.skills = skillLibrary;
  // Wave 3: <data>/agents/<id>/SYSTEM.md is each agent's instructions (the row keeps the last good text), skills/ its Main Skills.
  createAgentCore(s, org, skillLibrary);
  // B-044: <data>/README.md and agents/README.md – the maps of the data folder, written at start and when the team changes.
  s.rootMaps = new RootMaps({
    paths: { data: paths.data, workspace: paths.workspace }, bus, log, writes: s.rootWatcher,
    agents: () => org.list({ includeArchived: true }), personName: () => settings.get().profile.name,
  });
  s.rootMaps.start();
  // CTX8: <data>/modes holds the person's and agents' modes (never the agent-writable workspace); save reports unknown skills;
  // every save or delete is pushed as modes.changed, so the windows' and phones' cached mode lists load again.
  s.modes = new ModeLibrary({
    resources: paths.resources, data: paths.data, workspace: paths.workspace, clock, log,
    skillNames: () => s.skills.list().map((skill) => skill.name),
    onChange: (key) => bus.emit('modes.changed', { key }),
  });

  // Accounts own CLI homes + API keys; keys go through the vault (agents never see them).
  const accounts = new AccountServiceImpl({
    db, bus, clock, paths, log, finder, supervisor, demo: options.fakeEngine,
    version: options.version, // PR8: the client version ACP sign-in probes report
    enginePrompts: enginePromptDir(paths), // B-049 F3: Gemini CLI's own prompt replaced by ours (engines/acp/providers.ts)
    engines: () => s.engines,
    settings, // settings.json's `providers` section is where API connections live (accounts/provider-file.ts)
    secrets: {
      save: async (input) => ({ id: (await secrets.save(input)).id }),
      read: async (id) => { try { return await secrets.use(id, SYSTEM_ID); } catch { return undefined; } },
      remove: (id) => secrets.remove(id),
    },
  });
  s.accounts = accounts;
  const engines = createEngineRegistry({
    supervisor, finder, paths, version: options.version, fake: options.fakeEngine,
    apiKey: (account) => accounts.apiKey(account.id),
    acp: accounts.acpLaunch, // PR8: an ACP plan runs the launch its detection confirmed (unavailable until then)
    onLimits: (accountId, limits) => { try { accounts.updateLimits(accountId, limits); } catch (error) { log.warn('limits update failed', { error: String(error) }); } },
  });
  s.engines = engines;
  // Superseded native sessions the app created go after the successor's finished turn and 24 h – checked now and whenever a session binds (no timer);
  // also the app's own rebuilt Claude transcripts no row binds (an hour after their last write).
  new SessionSweep({
    db, clock, log, accounts: () => accounts.list(), engine: (id) => { try { return engines.get(id); } catch { return undefined; } },
    transcripts: transcriptFiles(claudeTranscriptsDir(paths.data)),
  }).start();

  const refreshDetection = async (force = false): Promise<DetectionReport | undefined> => {
    try { return await accounts.detect(force); } catch (error) { log.warn('detection failed', { error: String(error) }); return undefined; }
  };

  // B-078: e2e and demo runs (fake engine) make no openrouter.ai price request
  const catalog = new Catalog({ services, priors: loadPriors(paths.resources, log), ...(options.fakeEngine ? { priceFeed: false as const } : {}) });
  s.catalog = catalog;
  s.router = new RouterImpl({ services });
  s.decisions = createDecisionHub(services);
  s.spend = new Spend({ services });
  s.context = new Context({ services, templates: prompts });
  // B-055 G (Q11): who works on which file, from the same run journal events – the "Working nearby" line.
  s.workPresence = new WorkPresence({ services });
  s.workPresence.start();
  s.ledger = new ContextLedgerService({ services }); // the context ledger: captures turns from the run journal, marks by item id (context/ledger)
  s.ledger.start?.();
  s.subconscious = new SubconsciousImpl({ services });
  s.evidence = createEvidenceChecker(); // B-047 D11: deterministic evidence checks of task results (subconscious/verify.ts)
  s.vectors = createVectors(s); // vector.embed / vector.search (runtime/vectors/create.ts)
  knowledge.startMemory(s.rootWatcher); // the memory tree follows the watcher and is embedded where it is not yet; stop step 'memory'
  bus.on('settings.updated', () => knowledge.embedderChanged());
  const localSpeech = new LocalSpeech({ services });
  s.stt = new Transcriber({ services, local: localSpeech }); // dictation (RPC voice) and agents hearing recordings; B-047 D14: local speech models
  new LocalSpeechAuto({ services, local: localSpeech }).start(); // B-058 G1: the recommended local speech model downloads by itself once (voice/local/auto.ts)

  const tools = new Registry({
    services,
    onCall: (ctx, running) => s.dispatcher.setCall?.(ctx, running), // tool boundaries by call id (agents/dispatch-boundary.ts)
  });
  registerBuiltinTools(tools);
  s.tools = tools;
  const mcp = new Mcp({ services, baseUrl: options.baseUrl, version: options.version });
  s.mcp = mcp;
  // Connectors: <data>/connectors (mcp.json, mail.json) applied and watched, cached tools registered, no server started; stop step 'apps'.
  const apps = createApps(s, { supervisor, version: options.version });
  s.apps = apps;
  apps.start();

  // Every PC is home of its own data; linked PCs are peers (the mesh keeps them connected).
  const identity = await DeviceIdentity.load({ db, host, clock });
  const mesh = new DeviceMesh({ db, identity, clock, log, bus, dial: dialPeer });
  s.devices = mesh;
  mesh.register(RELAY_METHOD, (params, from) => receiveNotification(s, notifications, params, from));
  createChatMirror(s); // B-050 K8 (a): the derived chat folders <data>/chats (chat-files/mirror.ts; after the mesh: chat.json names this PC); stop step 'chat mirror'

  const dispatcher = new DispatcherImpl({ services, executor: new TurnExecutor(services), supervisor });
  s.dispatcher = dispatcher;
  org.setActivitySource(() => dispatcher.activity());
  createSplits(s); // B-057: services.splits on the dispatcher's lanes (compose/splits.ts)
  // 21.10. 17:09: the person's emergency stop; a stored stop holds the dispatcher before it starts.
  const workStop = new WorkStop({ services });
  bindWorkStop(s, workStop);
  workStop.restore();
  createCalls(s); // realtime voice and the call talker in chats (stop: compose/lifecycle.ts 'calls')
  createCalendar(s); // B-041 My day (compose/calendar.ts; stopCalendar at shutdown)
  // Outages end with an event (T04): an account that becomes usable or a model that becomes
  // available re-wakes tasks whose last turn found no model or account (accounts and catalog exist now).
  if (s.ownership instanceof OwnershipServiceImpl) s.ownership.watchOutages();
  new ChatRedelivery({ services }).watch(); // B-044: a chat turn that met an outage is delivered again once (agents/redelivery.ts)
  // B-047 D10: a plan found signed out becomes a sign-in task (or the person's to-do), closed when the account works again.
  const relogin = new Relogin({ services });
  s.relogin = relogin;
  relogin.watch();

  return { services: s, supervisor, finder, engines, catalog, dispatcher, scheduler, mcp, mesh, identity, secrets, knowledge, org, chats, media, refreshDetection, accountMonitor: accounts.monitor };
}

function loadPriors(resources: string, log: Logger): Priors {
  try {
    return Priors.parse(JSON.parse(readFileSync(path.join(resources, 'model-priors.json'), 'utf8')));
  } catch (error) {
    log.warn('model priors not loaded', { error: String(error) });
    return Priors.empty();
  }
}
