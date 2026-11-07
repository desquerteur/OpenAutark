// AF-002: the setup assistant's last step, Your first agent: the Manager the app starts with (its picture, name and role
// and what it will do first), and – if wanted – one more hire by role and name (agents.create, the call Team › Add ›
// Agent makes; the new agent joins the team list here). Start saves nothing else and ends the assistant: onboarding.start
// has the runtime post the app's start text in the Manager's chat as the person's own line, the chat opens, the Manager
// answers – and the spotlight tour starts once (tour/spotlight.ts; not again when it was seen). Skip ends the assistant
// without that line, on My day (the tour starts there the same way). Without a model that answers the card says the
// Manager answers once one is connected.
// Owns: this card. Never: changes a setting other than the onboarding step, or writes as the person.

import { useState } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { rpc } from '../lib/rpc.ts';
import { accounts, agents, models, settings, upsertById } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { AgentAvatar, Button } from '../lib/ui.tsx';
import { startTour } from '../tour/spotlight.ts';
import { STEP_INFO, noUsableModel, previousStep } from './first-run-model.ts';
import { finishFirstRun, goStep, managerAgent } from './first-run.ts';
import { Card, StatusLine } from './parts.tsx';

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

/** Agents hired on this card (they outlive a remount). */
const hiredHere: string[] = [];

/** The tour starts after the assistant unless the person saw it to the end or closed it before. */
function tourAfterSetup(): void {
  const tour = settings.value?.onboarding.tour ?? 'new';
  if (tour === 'new' || tour === 'started') startTour({ resume: tour === 'started' });
}

export function AgentCard() {
  const team = agents.value.filter((agent) => !agent.archivedAt);
  const manager = managerAgent(team);
  const hired = team.filter((agent) => hiredHere.includes(agent.id));
  const silent = noUsableModel(models.value, accounts.value);
  const [busy, setBusy] = useState<'start' | 'skip' | 'back' | 'hire' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hireOpen, setHireOpen] = useState(false);
  const [role, setRole] = useState('');
  const [name, setName] = useState('');

  const start = async () => {
    setBusy('start');
    setError(undefined);
    try {
      await finishFirstRun();
      tourAfterSetup();
    } catch (failure) { toastError(failure, 'Could not start'); setError('Could not start – try again.'); } finally { setBusy(null); }
  };
  const skip = () => {
    setBusy('skip');
    goStep('done', { onboarding: { completed: true } }).then(tourAfterSetup, (failure) => toastError(failure, 'Could not finish')).finally(() => setBusy(null));
  };
  const back = () => {
    setBusy('back');
    goStep(previousStep('agent')).catch((failure) => toastError(failure, 'Could not go back')).finally(() => setBusy(null));
  };
  const hire = async () => {
    if (!role.trim()) return;
    setBusy('hire');
    setError(undefined);
    try {
      const agent = await rpc.call('agents.create', { role: role.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      upsertById(agents, agent);
      hiredHere.push(agent.id);
      setRole(''); setName(''); setHireOpen(false);
    } catch (failure) { toastError(failure, 'Agent could not be created'); setError('Could not hire – try again.'); } finally { setBusy(null); }
  };

  const info = STEP_INFO.agent;
  const note = error ?? (silent ? 'No AI is connected yet – your Manager answers once one is (Settings › Models).' : undefined);
  return (
    <Card id="first-run-agent" title={info.title} purpose={info.purpose} actions={<>
      <Button variant="secondary" busy={busy === 'back'} disabled={busy !== null} onClick={back}>Back</Button>
      <span class="first-run-spacer" />
      <Button variant="ghost" busy={busy === 'skip'} disabled={busy !== null} onClick={skip}>Skip</Button>
      <Button variant="primary" busy={busy === 'start'} disabled={busy !== null || !manager} onClick={() => void start()}>Start</Button>
    </>}>
      {manager ? <AgentIntro agent={manager} lead text="Your Manager runs your company with you: it gets to know you and your work, hires specialists and hands out tasks. Start sends it a first message – it answers in your chat." />
        : <p class="first-run-note">There is no Manager on the team.</p>}
      {hired.map((agent) => <AgentIntro key={agent.id} agent={agent} text="Hired just now – it is on your team." />)}
      {hireOpen ? (
        <div class="first-run-hire">
          <div class="first-run-fields">
            <label class="first-run-field">
              <span class="field-label">Role</span>
              <input class="input" maxLength={120} placeholder="e.g. Researcher" value={role} onInput={(event) => setRole(value(event))}
                onKeyDown={(event) => { if (event.key === 'Enter') void hire(); }} />
            </label>
            <label class="first-run-field">
              <span class="field-label">Name</span>
              <input class="input" maxLength={60} placeholder="Optional" value={name} onInput={(event) => setName(value(event))}
                onKeyDown={(event) => { if (event.key === 'Enter') void hire(); }} />
            </label>
          </div>
          <div class="first-run-hire-actions">
            <Button variant="ghost" disabled={busy !== null} onClick={() => setHireOpen(false)}>Cancel</Button>
            <Button variant="secondary" busy={busy === 'hire'} disabled={busy !== null || !role.trim()} onClick={() => void hire()}>Hire</Button>
          </div>
        </div>
      ) : (
        <button type="button" class="text-button first-run-hire-open" disabled={busy !== null} onClick={() => setHireOpen(true)}>Hire another agent too</button>
      )}
      <StatusLine text={note} tone={error ? 'error' : undefined} />
    </Card>
  );
}

function AgentIntro(props: { agent: Agent; text: string; lead?: boolean }) {
  return (
    <div class={`first-run-agent${props.lead ? ' lead' : ''}`}>
      <AgentAvatar agentId={props.agent.id} size={props.lead ? 44 : 32} />
      <div class="first-run-agent-text">
        <span class="first-run-agent-name">{props.agent.name}{props.agent.role ? <span class="first-run-agent-role"> · {props.agent.role}</span> : null}</span>
        <span class="first-run-agent-about">{props.text}</span>
      </div>
    </div>
  );
}
