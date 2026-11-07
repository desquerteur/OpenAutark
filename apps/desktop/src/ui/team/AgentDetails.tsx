// Agent page, working setup: the model (one pinned model, or by name the one routing takes for it now without a pin,
// chosen per task – no "Auto" word, also while a pin holds: lib/route-preview.ts), the agent's two files that open in
// the pane's file tab (SYSTEM.md, last-prompt.md), the agent folder with its skills (the agent and the AI write
// SKILL.md files; here only their names and "Open folder") and the schedules it owns (each row has the schedule menu:
// pause or resume, delete), and (AF-013, AccessSection.tsx) its access mode and rules. Nothing else is set here – whom it reports to, effort limits or budgets are things the AI
// changes on request.
// Owns: these sections. Never: invents data – the folder and skills come from the runtime.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import '../../shared/api/methods-agent-core.ts'; // agents.core (module augmentation)
import type { Agent } from '../../shared/model/org.ts';
import { SYSTEM_FILE, type AgentCoreInfo } from '../../shared/model/agent-core.ts';
import type { ModelPolicy } from '../../shared/model/providers.ts';
import { Select } from '../lib/ui.tsx';
import type { SelectOption } from '../lib/ui.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { loadModels, models } from '../lib/store.ts';
import { platform } from '../lib/platform.ts';
import { PER_TASK, useRoutePreview } from '../lib/route-preview.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { openFileTab, pathMenu } from '../workspace/file-tabs.ts';
import { fullDate } from '../lib/format.ts';
import { toastError } from '../lib/toasts.ts';
import { skillTitle } from './agent-core-model.ts';
import { ensureSchedules, scheduleMenu, schedules } from '../tasks/schedules.ts';
import { AccessSection } from './AccessSection.tsx'; // AF-013

function Section(props: { title: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="agent-section" aria-label={props.title}>
      <div class="agent-section-head"><h3 class="agent-section-title">{props.title}</h3>{props.action}</div>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; hint?: string; children?: ComponentChildren; menu?: ReturnType<typeof useContextMenu> }) {
  return (
    <div class="agent-row" {...props.menu}>
      <span class="agent-row-text"><span class="agent-row-label">{props.label}</span>{props.hint && <small class="agent-row-hint">{props.hint}</small>}</span>
      {props.children}
    </div>
  );
}

function ModelSection(props: { agent: Agent; readOnly: boolean }) {
  const [pin, setPin] = useState(props.agent.modelPolicy?.pin ?? '');
  useEffect(() => setPin(props.agent.modelPolicy?.pin ?? ''), [props.agent.modelPolicy?.pin]);
  useEffect(() => { if (!models.value.length) void loadModels().catch(() => undefined); }, []);
  /** The model routing takes for this agent now without its pin; the pin itself answered back is no such model. */
  const route = useRoutePreview(props.agent.id, undefined, [pin, models.value]);
  const routed = route && !(route.by === 'pin' && route.modelId === pin) ? route.modelId : undefined;
  const save = async (next: string) => {
    const before = pin;
    setPin(next);
    const { pin: _old, ...rest } = props.agent.modelPolicy ?? {};
    const policy: ModelPolicy = next ? { ...rest, pin: next } : rest;
    try { await rpc.call('models.setPolicy', { agentId: props.agent.id, policy }); } catch (error) { setPin(before); toastError(error, 'Could not save the model'); }
  };
  const available = models.value.filter((model) => model.available || model.id === pin);
  const routedName = routed ? models.value.find((model) => model.id === routed)?.name ?? routed : undefined;
  const options: Array<SelectOption<string>> = [
    // the policy value stays '' (no pin); the option names the model that runs
    routedName ? { value: '', label: routedName, hint: PER_TASK } : { value: '', label: PER_TASK },
    ...available.map((model) => ({ value: model.id, label: model.available ? model.name : `${model.name} (unavailable)` })),
  ];
  if (pin && !available.some((model) => model.id === pin)) options.push({ value: pin, label: pin });
  return (
    <Section title="Model">
      <Row label="Model" hint={pin ? 'Always this model' : PER_TASK}>
        <Select label="Model" value={pin} options={options} disabled={props.readOnly} onChange={(next) => void save(next)} />
      </Row>
    </Section>
  );
}

/** One file of the agent's folder, opened in the pane's file tab. */
function FileRow(props: { folder: string; name: string; hint: string }) {
  const file = `${props.folder}${props.folder.includes('\\') ? '\\' : '/'}${props.name}`;
  const menu = useContextMenu(() => pathMenu(file));
  return <Row label={props.name} hint={props.hint} menu={menu}><button type="button" class="text-button" onClick={() => openFileTab(file)}>Open</button></Row>;
}

function FolderSection(props: { agent: Agent }) {
  const { agent } = props;
  const [info, setInfo] = useState<AgentCoreInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => { rpc.call('agents.core', { agentId: agent.id }).then((core) => { if (alive) setInfo(core); }).catch(() => undefined); };
    load();
    const offCore = rpc.on('agentCore.changed', (event) => { if (event.agentId === agent.id) load(); });
    const offSkills = rpc.on('skills.changed', load);
    return () => { alive = false; offCore(); offSkills(); };
  }, [agent.id, agent.instructions]);
  const main = info?.mainSkills ?? [];
  const own = agent.skills.filter((skill) => !main.some((entry) => entry.name === skill));
  if (!info && !own.length) return null;
  const folder = info?.folder;
  const open = () => { if (folder) void rpc.call('files.openPath', { path: folder }).catch((error) => toastError(error, 'Could not open the folder')); };
  return (
    <>
    {folder && can('files.readPath') && (
      <Section title="Files">
        <FileRow folder={folder} name={SYSTEM_FILE} hint="Its instructions" />
        <FileRow folder={folder} name="last-prompt.md" hint="The whole system prompt the app sent on its last turn" />
      </Section>
    )}
    <Section title="Skills" action={platform === 'desktop' && folder ? <button type="button" class="text-button" onClick={open}>Open folder</button> : undefined}>
      {!main.length && !own.length && <Row label="No skills yet" />}
      {main.map((skill) => <Row key={skill.name} label={skillTitle(skill.name)} hint={skill.description} />)}
      {own.map((skill) => <Row key={skill} label={skillTitle(skill)} />)}
    </Section>
    </>
  );
}

function ScheduleRow(props: { item: ReturnType<typeof schedules.peek>[number] }) {
  const { item } = props;
  const menu = useContextMenu(() => scheduleMenu(item));
  return <Row label={item.title} hint={item.active ? (item.nextAt ? `Next ${fullDate(item.nextAt)}` : 'No next run') : 'Paused'} menu={menu} />;
}

function SchedulesSection(props: { agentId: string }) {
  useEffect(() => { ensureSchedules(); }, []);
  const own = schedules.value.filter((item) => item.ownerId === props.agentId).sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  if (!own.length) return null;
  return <Section title="Schedules">{own.map((item) => <ScheduleRow key={item.id} item={item} />)}</Section>;
}

export function AgentDetails(props: { agent: Agent }) {
  const { agent } = props;
  const live = agent.archivedAt === undefined;
  return (
    <>
      <ModelSection agent={agent} readOnly={!live} />
      <AccessSection agent={agent} />
      <FolderSection agent={agent} />
      <SchedulesSection agentId={agent.id} />
    </>
  );
}
