// Composer Plus menu: Files & folders, Photos & screenshots, Secret (the composer's secret mode, settings/SecretRows.tsx),
// Task (turns the draft into a task; an empty field gets "/task " to write it), and how the draft goes out – "Send as
// important", "Send silently" and "Schedule…" (which switches the composer into schedule mode, composer/ScheduleBar.tsx;
// the Send button's right-click menu has the same three, slash.ts sendMenuItems). In schedule mode the first two read
// "Schedule as important" / "Schedule silently" and "Schedule…" is ticked. Owner 04.11.2026: no entry is ever greyed out.
// While a take runs the menu starts with "Discard dictation" (two deliberate clicks, nothing moves).
// Owns: the menu. Never: uploads or sends itself (callbacks do).

import { useRef, useState } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { Icon, Menu } from '../../lib/ui.tsx';
import type { MenuItem } from '../../lib/ui.tsx';
import { can } from '../../lib/session.ts';
import { sendMenuItems, type SendActions } from './slash.ts';

/** The Plus menu's first entry while a take runs – throws the take away (the draft stays as it is). */
export function discardDictationItem(discard: () => void): MenuItem {
  return { label: 'Discard dictation', description: 'The words of this take are not kept', danger: true, onSelect: discard };
}

export interface PlusActions extends SendActions {
  /** A take runs – the menu offers to discard it. */
  discardDictation?: () => void;
  secret?: () => void;
  pickFiles: () => void;
  pickImages: () => void;
  makeTask: () => void;
}

export function PlusMenu(props: { chat: ConversationSummary; actions: PlusActions }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { actions } = props;
  const items: MenuItem[] = [
    { label: 'Files & folders', onSelect: actions.pickFiles },
    { label: 'Photos & screenshots', onSelect: actions.pickImages },
    ...(can('secrets.capture') && actions.secret ? [{ label: 'Secret', onSelect: actions.secret }] : []),
    ...(can('tasks.create') ? [{ label: 'Task', onSelect: actions.makeTask }] : []),
  ];
  return (
    <>
      <button ref={ref} type="button" class="icon-button composer-plus" aria-label="Add" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" size={20} />
      </button>
      <Menu anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="top-start" width={260} label="Add"
        sections={[...(actions.discardDictation ? [{ items: [discardDictationItem(actions.discardDictation)] }] : []), { items }, { items: sendMenuItems(actions) }]} />
    </>
  );
}
