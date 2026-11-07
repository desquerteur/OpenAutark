// Agent page (AF-006): the agent's own personality – presets and each field "Like everyone (…)" or its own value, plus an
// own text, saved in its personality.json (personality.setAgent) – and its role: its own part of SYSTEM.md (from
// "## My role" on), edited here and saved with personality.setRole, the team's standard above it kept. Both apply at
// the agent's next answer. The preview shows "## My personality" as its next turn reads it. Archived agents and
// sessions without 'manage' see it read-only.
// Owns: these two sections. Never: the wording the agent reads (runtime/personality/prompt.ts) or the global values.

import { useEffect, useState } from 'preact/hooks';
import '../../shared/api/methods-personality.ts'; // personality.* (module augmentation)
import type { AgentPersonalityInfo } from '../../shared/api/methods-personality.ts';
import type { Agent } from '../../shared/model/org.ts';
import {
  applyPresetToAgent, globalPersonality, matchingPreset, PERSONALITY_INSTRUCTIONS_MAX, type AgentPersonality, type PersonalityField,
} from '../../shared/model/personality.ts';
import { RpcError, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { agents, settings, upsertById } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { Row } from '../settings/controls.tsx';
import { NoteField, PersonalityRows, PresetChips, PromptPreview } from '../settings/personality-fields.tsx';

function useInfo(agent: Agent): [AgentPersonalityInfo | null, (info: AgentPersonalityInfo) => void, () => void] {
  const [info, setInfo] = useState<AgentPersonalityInfo | null>(null);
  const [tick, setTick] = useState(0);
  const global = settings.value?.personality;
  useEffect(() => {
    let alive = true;
    rpc.call('personality.agent', { agentId: agent.id }).then((next) => { if (alive) setInfo(next); }).catch(() => undefined);
    return () => { alive = false; };
  }, [agent.id, agent.instructions, global, tick]);
  return [info, setInfo, () => setTick((value) => value + 1)];
}

function RoleEditor(props: { agent: Agent; info: AgentPersonalityInfo; readOnly: boolean; reload: () => void }) {
  const { agent, info } = props;
  const [draft, setDraft] = useState(info.role);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(info.role), [info.role]);
  const changed = draft.trim() !== info.role.trim();
  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      upsertById(agents, await rpc.call('personality.setRole', { agentId: agent.id, role: draft, base: info.instructions }));
    } catch (error) {
      toastError(error, error instanceof RpcError && error.code === 'conflict' ? 'SYSTEM.md changed meanwhile – the new text is loaded' : 'Could not save the role');
      if (error instanceof RpcError && error.code === 'conflict') props.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="agent-section agent-role-edit" aria-label="Role">
      <div class="agent-section-head"><h3 class="agent-section-title">Role</h3></div>
      <p class="agent-section-hint">{info.standard
        ? 'Its own part of SYSTEM.md, from “## My role” on. The team’s standard “How I work” above it stays as it is.'
        : 'Its whole SYSTEM.md (it has no team standard above its role).'} Applies at its next answer.</p>
      <textarea class="set-textarea mono agent-role-input" aria-label={`${agent.name}'s role`} rows={10} maxLength={20_000} value={draft} disabled={props.readOnly}
        onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)} />
      {!props.readOnly && (
        <div class="agent-editor-actions">
          <Button variant="ghost" disabled={!changed || busy} onClick={() => setDraft(info.role)}>Discard</Button>
          <Button variant="primary" busy={busy} disabled={!changed || !draft.trim()} onClick={() => void save()}>Save role</Button>
        </div>
      )}
    </section>
  );
}

export function AgentPersonality(props: { agent: Agent }) {
  const { agent } = props;
  const [info, setInfo, reload] = useInfo(agent);
  const readOnly = agent.archivedAt !== undefined || !can('personality.setAgent');
  if (!info) return null;
  const global = globalPersonality(settings.value?.personality);
  const own = info.own;
  const save = async (next: AgentPersonality) => {
    try { setInfo(await rpc.call('personality.setAgent', { agentId: agent.id, personality: next })); } catch (error) { toastError(error, 'Could not save the personality'); }
  };
  const setField = (field: PersonalityField, value: string) => {
    const next: AgentPersonality = { ...own };
    if (value) (next as Record<PersonalityField, string>)[field] = value;
    else delete next[field];
    void save(next);
  };
  const style = { tone: own.tone ?? 'auto', address: own.address ?? 'auto', emoji: own.emoji ?? 'auto', length: own.length ?? 'auto' } as const;
  const hasOwn = Object.keys(own).length > 0;

  return (
    <>
      <section class="agent-section agent-personality" aria-label="Personality">
        <div class="agent-section-head">
          <h3 class="agent-section-title">Personality</h3>
          {hasOwn && !readOnly && <button type="button" class="text-button" onClick={() => void save({})}>Like everyone</button>}
        </div>
        <p class="agent-section-hint">Goes before Settings › Personality for {agent.name} alone. Applies at its next answer.</p>
        <Row label={<PresetChips selected={hasOwn ? matchingPreset(style)?.id : undefined} disabled={readOnly} onPick={(preset) => void save(applyPresetToAgent(own, preset))} />} stack />
        <PersonalityRows values={own} global={global} disabled={readOnly} onChange={setField} />
        <Row label="Own instructions" hint={global.instructions ? 'Added to yours from Settings › Personality; where they differ, these win' : 'Only for this agent'} stack>
          <NoteField label={`How ${agent.name} should treat you`} value={own.instructions ?? ''} max={PERSONALITY_INSTRUCTIONS_MAX} disabled={readOnly} rows={3}
            placeholder="For example: Always answer with a short summary first."
            onCommit={(text) => setField('instructions', text.trim())} />
        </Row>
        <PromptPreview text={info.preview} empty={`Nothing set – ${agent.name} keeps its own way.`} />
      </section>
      <RoleEditor agent={agent} info={info} readOnly={readOnly} reload={reload} />
    </>
  );
}
