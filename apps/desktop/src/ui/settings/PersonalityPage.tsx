// Settings › Personality (AF-006): how every agent speaks to the person – presets, tone, form of address, language,
// emoji, length of answers, a free text "How the AI should treat you" (settings.json `personality`) and "About me"
// (profile.notes, which the AI keeps too). Every agent reads the values fresh on each turn (runtime/personality/prompt.ts),
// so a change applies at the next answer; an agent's own values on its page go first. The preview shows the section as
// the agents get it. A phone or another device sees the values read-only (settings.update takes only appearance and
// notifications from a device).
// Owns: this page's rows and their mapping onto settings. Never: the wording the agents read.

import { useEffect, useState } from 'preact/hooks';
import '../../shared/api/methods-personality.ts'; // personality.preview (module augmentation)
import { applyPreset, globalPersonality, matchingPreset, PERSONALITY_INSTRUCTIONS_MAX, type Personality } from '../../shared/model/personality.ts';
import { rpc } from '../lib/rpc.ts';
import { isOwner, PC_NOTE } from '../lib/session.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { act, Group, Row } from './controls.tsx';
import { NoteField, PersonalityRows, PresetChips, PromptPreview } from './personality-fields.tsx';

/** profile.notes' cap (runtime/settings/schema.ts NOTES_MAX). */
const ABOUT_MAX = 600;

/** The section an agent without own values reads now, again after every change of the settings. */
function usePreview(key: unknown): string {
  const [text, setText] = useState('');
  useEffect(() => {
    let alive = true;
    rpc.call('personality.preview').then((result) => { if (alive) setText(result.text); }).catch(() => undefined);
    return () => { alive = false; };
  }, [key]);
  return text;
}

export function PersonalityPage() {
  const value = settings.value;
  const preview = usePreview(value?.personality);
  if (!value) return null;
  const current = globalPersonality(value.personality);
  const locked = !isOwner();
  const save = (patch: Partial<Personality>) => act(() => updateSettings({ personality: patch }), 'Could not save');
  const selected = matchingPreset(current)?.id;

  return (
    <div class="personality-settings">
      <Group title="Presets" hint={locked ? PC_NOTE : 'A preset sets tone, form of address, emoji and length. It fills the text below only while that is empty – your own words stay.'}>
        <Row label={<PresetChips selected={selected} disabled={locked} onPick={(preset) => void save(applyPreset(current, preset))} />} stack />
      </Group>

      <Group title="How agents speak to you" hint="Applies to every agent from its next answer on. An agent's own personality on its page goes first.">
        <PersonalityRows values={current} disabled={locked} onChange={(field, next) => void save({ [field]: next })} />
      </Group>

      <Group title="How the AI should treat you" hint="In your own words, like custom instructions – every agent reads it each turn">
        <Row label="Your instructions" stack>
          <NoteField label="How the AI should treat you" value={current.instructions} max={PERSONALITY_INSTRUCTIONS_MAX} disabled={locked} rows={5}
            placeholder="For example: Call me Kim. Explain technical terms. Ask before you send anything in my name."
            onCommit={(instructions) => void save({ instructions: instructions.trim() })} />
        </Row>
      </Group>

      <Group title="About me" hint="What every agent should know about you. The AI adds to it too when you tell it something about yourself.">
        <Row label="About me" stack>
          <NoteField label="About me" value={value.profile.notes ?? ''} max={ABOUT_MAX} disabled={locked} rows={4}
            placeholder="For example: I run a small video studio, I work mornings, English for code, German for everything else."
            onCommit={(notes) => void act(() => updateSettings({ profile: { notes: notes.trim() } }), 'Could not save')} />
        </Row>
      </Group>

      <PromptPreview text={preview} empty="Nothing set yet – every agent keeps its own way." />
    </div>
  );
}
