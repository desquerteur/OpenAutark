// Agents in the person's browser – the person's pane, each chat's area above its messages and each agent's area (host op `sideBrowser`,
// shared/model/side-browser.ts). The person works there with the AI all day, so an agent works like a careful colleague:
// it reads the page as an accessibility snapshot and then only what changed, finds elements by words, acts in batches
// that stop at the first failure, debugs with console, network and eval, and waits on page events. Its mouse moves along
// the shared motion model and its named cursor is drawn in the page. The person goes first: a step within 2 s of their input
// in that tab is refused (personActive); a page showing a human check says so (humanCheck). A tab an agent opens
// carries the agent and its chat; without newTab it is the agent's preview tab there until the person's click or key in
// it keeps it (sideKeep). The person's pointer and every agent move go to the runtime's pointer hub
// (deps.pointer: host bridge message 'pointer', surface side:<tabId>). A call without a tab means its space's tab
// (call.space: global or chat:<id>; each space shows its own tab); a given tab id works from anywhere. B-076: `side` hands
// a tab to the caster (caster.ts) when the person watches it from another PC or a phone.
// Owns: the call dispatch, the tab registry, the agents' last looks and the pointer reports.
// Never: imports electron (the workspace browser hands in the tabs), or hands out field values of passwords
// (snapshot.ts / logs.ts redact).

import { GLOBAL_SPACE, browserUrl } from '../../shared/api/workspace-browser.ts';
import { DEFAULT_MOTION, thinSteps, type MotionStep } from '../../shared/model/pointer-motion.ts';
import { POINTER_PATH_MAX, surfaceKey, type PointerAction, type PointerActor, type PointerPoint } from '../../shared/model/pointers.ts';
import type { SideBrowserCall, SideBrowserResult } from '../../shared/model/side-browser.ts';
import type { PageOpener } from '../../shared/api/workspace-browser.ts';
import { SideError, type ContentsLike } from './cdp.ts';
import { dialogError, evaluate, pageText, responseBody, screenshot, takeLook } from './read.ts';
import { changeList, findLines, maskUrl, type Look } from './snapshot.ts';
import { release, runStep, type StepContext } from './steps.ts';
import { SideTab, type PersonInput } from './tab.ts';
import { checkCall } from './validate.ts';
import { waitFor } from './wait.ts';

/** The workspace browser's surface for the driver (main/workspace-browser.ts). */
export interface SideTabsLike {
  /** Every tab with its space. `active`: the tab the person looks at in `space` now (its slot's tab); `last`: the one side-tabs.json names for it. */
  sideTabs(space?: string): { pages: Array<{ id: string; url: string; title: string; space?: string; opener?: PageOpener }>; active: string | null; last?: string | null };
  /** The tab's page (a restored tab loads); undefined when it cannot be reached. `watcher`: the person watching it from elsewhere wakes it, no agent uses it. */
  sideContents(id: string, watcher?: boolean): ContentsLike | undefined;
  /** Opens a page in `space` (in the background unless `show`) with its opener – in the agent's preview tab there unless `newTab`; returns its id. */
  sideOpen(url: string, opener: PageOpener, show?: boolean, space?: string, newTab?: boolean): string;
  sideKeep?(id: string): void; // the person used the tab (a click or a key in it): an agent's preview stays as a tab of its own
  /** Closes a tab. */
  sideClose(id: string): void;
}

export interface SideDriverDeps {
  browser(): SideTabsLike | null;
  /** A pointer for the runtime's hub (best effort). */
  pointer?(point: Omit<PointerPoint, 'at'>): void;
  /** The person at this PC as a pointer actor. */
  person?(): PointerActor;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export const PERSON_PRIORITY_MS = 2000;
const LOAD_MS = 15_000;
const LOOKS_MAX = 64;
const COLORS = ['#2f6fed', '#d9480f', '#2b8a3e', '#ae3ec9', '#c2255c', '#0b7285', '#e67700', '#5f3dc4'];
const BUSY = 'The person is using this tab right now – wait a moment, then try again.';
const NO_BROWSER = 'The side browser is not available right now.';

function colorOf(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export class SideDriver {
  private readonly deps: SideDriverDeps;
  private readonly tabs = new Map<string, SideTab>();
  /** Each agent's last look per tab ('agent|tab'). */
  private readonly looks = new Map<string, Look>();
  private lastPersonTab: string | null = null;
  /** The tab each agent last named or opened, per space ('agent|space'). */
  private readonly agentTabs = new Map<string, string>();

  constructor(deps: SideDriverDeps) {
    this.deps = deps;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private sleep(ms: number): Promise<void> { return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)); }

  /** The workspace browser's tab hook: a tab's page was made, or it is gone (null). */
  tab(id: string, contents: ContentsLike | null): void {
    const old = this.tabs.get(id);
    if (old && old.contents !== contents) {
      old.dispose();
      this.tabs.delete(id);
      for (const key of [...this.looks.keys()]) if (key.endsWith(`|${id}`)) this.looks.delete(key);
    }
    // From the start: the person's pointer, and console/network history for a later look.
    if (contents && !this.tabs.has(id)) void this.make(id, contents).cdp.ready().catch(() => {});
  }

  private make(id: string, contents: ContentsLike): SideTab {
    const tab = new SideTab(id, contents, { now: () => this.now(), person: (from, input) => this.personInput(from, input) });
    this.tabs.set(id, tab);
    return tab;
  }

  private personInput(tab: SideTab, input: PersonInput): void {
    this.lastPersonTab = tab.id;
    if (input.action === 'click' || input.action === 'type') this.deps.browser()?.sideKeep?.(tab.id);
    if (input.x === undefined || input.y === undefined) return;
    const person = this.deps.person?.() ?? { kind: 'person', id: 'owner', name: 'Owner' };
    this.deps.pointer?.({ surface: surfaceKey('side', tab.id), actor: person, x: input.x, y: input.y, action: input.action, ...(input.target ? { target: input.target } : {}) });
  }

  /** The tab a call means: the given one, else in its space the one this agent last named or opened, the one the person looks at (or the shown or used last), else the first. */
  private pick(id: string | undefined, space: string, agentId: string): SideTab {
    const browser = this.deps.browser();
    if (!browser) throw new SideError(NO_BROWSER);
    const { pages, active, last } = browser.sideTabs(space);
    const here = pages.filter((page) => (page.space ?? GLOBAL_SPACE) === space);
    const known = (tab: string | null | undefined) => (tab && here.some((page) => page.id === tab) ? tab : undefined);
    const chosen = id ?? known(this.agentTabs.get(`${agentId}|${space}`)) ?? known(active) ?? known(last) ?? known(this.lastPersonTab) ?? here[0]?.id;
    if (!chosen) throw new SideError('This browser has no open tab – open a page first (action open).');
    if (!pages.some((page) => page.id === chosen)) throw new SideError(`There is no side-browser tab ${chosen} – list the tabs (action tabs).`);
    let contents: ContentsLike | undefined;
    try { contents = browser.sideContents(chosen); } catch { throw new SideError(NO_BROWSER); }
    if (!contents || contents.isDestroyed()) throw new SideError(`The tab ${chosen} cannot be reached right now – try again.`);
    if (id) this.agentTabs.set(`${agentId}|${space}`, chosen); // a tab it named or opened; otherwise it goes on following what the person looks at
    const tab = this.tabs.get(chosen);
    return tab && tab.contents === contents ? tab : this.make(chosen, contents);
  }

  /** B-076: tab `id` with its page awake for the person watching it from another PC or a phone (caster.ts); undefined when it is not open. */
  side(id: string): SideTab | undefined {
    let contents: ContentsLike | undefined;
    try { contents = this.deps.browser()?.sideContents(id, true); } catch { return undefined; }
    if (!contents || contents.isDestroyed()) return undefined;
    const tab = this.tabs.get(id);
    return tab && tab.contents === contents ? tab : this.make(id, contents);
  }

  /** Checks, then runs the call; every failure comes back as one sentence. */
  async call(raw: unknown): Promise<SideBrowserResult> {
    const checked = checkCall(raw);
    if ('error' in checked) return { ok: false, error: checked.error };
    try {
      return await this.run(checked.call);
    } catch (error) {
      if (error instanceof SideError) return { ok: false, error: error.message, ...(error.personActive ? { personActive: true } : {}) };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `The side browser could not do that (${message.slice(0, 200)}).` };
    }
  }

  private where(tab: SideTab): Pick<SideBrowserResult, 'tab' | 'url' | 'title'> {
    return { tab: tab.id, url: maskUrl(tab.contents.getURL(), undefined, 2000), title: tab.contents.getTitle() };
  }

  private async run(call: SideBrowserCall): Promise<SideBrowserResult> {
    if (call.action === 'tabs') return this.tabList(call.space);
    if (call.action === 'open') return this.open(call);
    if (call.action === 'close') {
      const browser = this.deps.browser();
      if (!browser) throw new SideError(NO_BROWSER);
      try { browser.sideClose(call.tab!); } catch (error) { throw new SideError(error instanceof Error ? error.message : 'This tab could not be closed.'); }
      return this.tabList(call.space);
    }
    const tab = this.pick(call.tab, call.space ?? GLOBAL_SPACE, call.agent.id);
    await tab.cdp.ready();
    const key = `${call.agent.id}|${tab.id}`;
    switch (call.action) {
      case 'snapshot': {
        const { look, human } = await takeLook(tab);
        const before = this.looks.get(key);
        this.remember(key, look);
        const diff = call.full ? { text: '', full: true } : changeList(before, look);
        return { ok: true, ...this.where(tab), ...(diff.full ? { text: [diff.text, look.lines.join('\n')].filter(Boolean).join('\n') } : { changes: diff.text }), ...(human ? { humanCheck: true } : {}) };
      }
      case 'find': {
        const { snap, human } = await takeLook(tab);
        const hits = findLines(snap.lines, call.query!);
        const text = hits.lines.length ? [...hits.lines, ...(hits.more ? [`… ${hits.more} more – use more words`] : [])].join('\n') : `Nothing on the page matches ${JSON.stringify(call.query)}.`;
        return { ok: true, ...this.where(tab), text, ...(human ? { humanCheck: true } : {}) };
      }
      case 'act': return this.act(tab, call, key);
      case 'screenshot': return { ok: true, ...this.where(tab), ...(await screenshot(tab, call)) };
      case 'text': return { ok: true, ...this.where(tab), text: await pageText(tab) };
      case 'console': return { ok: true, ...this.where(tab), text: tab.console.text(call) };
      case 'network': {
        if (!call.requestId) return { ok: true, ...this.where(tab), text: tab.network.text(call) };
        const body = await responseBody(tab, call.requestId);
        const detail = tab.network.detail(call.requestId, body);
        if (!detail) throw new SideError(`There is no request ${call.requestId} in this tab's list – list the requests again (network without requestId).`);
        return { ok: true, ...this.where(tab), text: body ? detail : `${detail}\n(No body is kept for this request – it failed, was a redirect, or the tab moved on since.)` };
      }
      case 'eval':
        if (tab.dialog) throw dialogError(tab)!; // the page is blocked until the dialog is answered
        return { ok: true, ...this.where(tab), text: await evaluate(tab, call.expression!) };
      case 'wait': {
        const out = await waitFor(tab, call.wait!, { now: () => this.now() });
        return out.ok ? { ok: true, ...this.where(tab), text: out.note } : { ok: false, ...this.where(tab), error: out.error };
      }
    }
    return { ok: false, error: 'Unknown side-browser action.' };
  }

  private remember(key: string, look: Look): void {
    this.looks.delete(key);
    this.looks.set(key, look);
    while (this.looks.size > LOOKS_MAX) this.looks.delete(this.looks.keys().next().value!);
  }

  private tabList(space = GLOBAL_SPACE): SideBrowserResult {
    const browser = this.deps.browser();
    if (!browser) throw new SideError(NO_BROWSER);
    const { pages, active } = browser.sideTabs(space);
    const tabs = pages.filter((page) => (page.space ?? GLOBAL_SPACE) === space).map((page) => ({ id: page.id, url: maskUrl(page.url, undefined, 2000), title: page.title, active: page.id === active, ...(page.opener ? { by: page.opener.agentName || page.opener.agentId } : {}) }));
    const text = tabs.length ? tabs.map((t) => `${t.id}${t.active ? ' (the person looks at it)' : ''} · ${t.title || '(no title)'} · ${t.url}${t.by ? ` · opened by ${t.by}` : ''}`).join('\n') : 'This browser has no open tab.';
    return { ok: true, tabs, text };
  }

  /** Waits (on page events) until the main document is parsed – or nothing loads any more – at most `ms`. */
  private loaded(tab: SideTab, ms: number): Promise<boolean> {
    const ready = () => !tab.contents.isLoading() || (tab.domReady && !tab.navigating);
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => { off(); clearTimeout(timer); resolve(value); };
      const off = tab.onEvent(() => { if (ready()) done(true); });
      const timer = setTimeout(() => done(ready()), ms);
    });
  }

  private async open(call: SideBrowserCall): Promise<SideBrowserResult> {
    let url: string;
    try { url = new URL(browserUrl(call.url!)).href; } catch (error) { throw new SideError(error instanceof Error ? error.message : 'Use an HTTP or HTTPS address.'); }
    let tab: SideTab;
    if (call.newTab !== false) {
      const browser = this.deps.browser();
      if (!browser) throw new SideError(NO_BROWSER);
      let id: string;
      const opener: PageOpener = { agentId: call.agent.id, agentName: call.agent.name, ...(call.chat ? { chatId: call.chat } : {}) };
      try { id = browser.sideOpen(url, opener, call.show === true, call.space, call.newTab === true); } catch (error) { throw new SideError(error instanceof Error ? error.message : 'The page could not be opened.'); }
      tab = this.pick(id, call.space ?? GLOBAL_SPACE, call.agent.id);
      tab.domReady = false; // the load already started: its document counts as not parsed until it says so (a reused preview tab still holds its last one)
      await tab.cdp.ready();
    } else {
      tab = this.pick(call.tab, call.space ?? GLOBAL_SPACE, call.agent.id);
      if (tab.personActive(PERSON_PRIORITY_MS)) throw new SideError(BUSY, { personActive: true });
      tab.domReady = false;
      const out = await tab.cdp.send('Page.navigate', { url }) as { errorText?: string };
      if (out.errorText) throw new SideError(`The page could not be loaded (${out.errorText}).`);
    }
    const ready = await this.loaded(tab, LOAD_MS);
    const { look, human } = await takeLook(tab);
    this.remember(`${call.agent.id}|${tab.id}`, look);
    return { ok: true, ...this.where(tab), text: `${ready ? '' : 'The page is still loading.\n'}${look.lines.join('\n')}`, ...(human ? { humanCheck: true } : {}) };
  }

  /** Steps in order, stopping at the first that fails; then what changed since the agent's last look. */
  private async act(tab: SideTab, call: SideBrowserCall, key: string): Promise<SideBrowserResult> {
    const agent = call.agent;
    const style = call.motion ?? DEFAULT_MOTION;
    const ctx: StepContext = {
      tab, agentId: agent.id, style, now: () => this.now(), sleep: (ms) => this.sleep(ms),
      moved: (path, action, ref) => this.agentMoved(tab, agent, path, action, ref),
    };
    const steps = call.steps!;
    let done = 0;
    let failure: SideError | undefined;
    try {
      for (const step of steps) {
        if (tab.personActive(PERSON_PRIORITY_MS)) { failure = new SideError(BUSY, { personActive: true }); break; }
        try { await runStep(ctx, step); } catch (error) {
          failure = error instanceof SideError ? error : new SideError(`Step ${done + 1} (${step.action}) failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
          break;
        }
        done += 1;
        await this.settle(tab, done < steps.length ? 40 : 120);
      }
    } finally { release(tab); }
    if (failure && done > 0 && !/^Step \d/.test(failure.message)) failure = new SideError(`Step ${done + 1} (${steps[done]!.action}): ${failure.message}`, failure);
    const result: SideBrowserResult = { ok: !failure, ...this.where(tab), done, ...(failure ? { error: failure.message } : {}), ...(failure?.personActive ? { personActive: true } : {}) };
    // A page dialog blocks the page: it is the change (the page itself cannot be read until it is answered).
    if (tab.dialog) { result.changes = `Dialog: ${tab.dialog.type} ${JSON.stringify(tab.dialog.message)} – press Enter to accept or Escape to dismiss it.`; return result; }
    if (done === 0) return result;
    const { look, human } = await takeLook(tab).catch(() => ({ look: undefined, human: false }));
    if (!look) return result;
    const diff = changeList(this.looks.get(key), look);
    this.remember(key, look);
    if (diff.full) { if (diff.text) result.changes = diff.text; result.text = look.lines.join('\n'); } else result.changes = diff.text;
    if (human) result.humanCheck = true;
    return result;
  }

  /** After a step: a navigation it started is waited for (≤ 10 s), otherwise a short breath for the page. */
  private async settle(tab: SideTab, ms: number): Promise<void> {
    await this.sleep(ms);
    if (tab.navigating && !tab.dialog) await this.loaded(tab, 10_000);
  }

  /** The agent's cursor moves: drawn in the page and reported to the runtime (surface side:<tab>). */
  private agentMoved(tab: SideTab, agent: { id: string; name: string }, path: MotionStep[], action: PointerAction, ref?: string): void {
    const last = path[path.length - 1];
    if (!last) return;
    const drawn = JSON.stringify(thinSteps(path, 80).map((s) => ({ x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10, t: Math.round(s.t) })));
    void tab.cdp.inWorld(`__wfSide.cursor(${JSON.stringify(agent.id)}, ${JSON.stringify(agent.name.slice(0, 40))}, ${JSON.stringify(colorOf(agent.id))}, ${drawn}, ${action === 'click'})`).catch(() => {});
    const info = ref ? tab.refs.get(ref) : undefined;
    this.deps.pointer?.({
      surface: surfaceKey('side', tab.id), actor: { kind: 'agent', id: agent.id, name: agent.name }, x: last.x, y: last.y, action,
      ...(ref ? { target: { ...(info?.role ? { role: info.role } : {}), ...(info?.name ? { name: info.name.slice(0, 80) } : {}), ref } } : {}),
      path: thinSteps(path, POINTER_PATH_MAX),
    });
  }

  /** The window went: every tab's state goes with it. */
  dispose(): void {
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    this.looks.clear();
  }
}
