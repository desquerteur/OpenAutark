// AF-016 – the Send button's split: a small caret right of the round Send/Stop cell (data-tour="composer-queue"). Its menu
// sends the draft now (it reaches a running agent at once, as Send always did) or lines it up in the chat's queue (it
// goes out once the agent is done), each with its key (Enter for the default, Ctrl+Enter for the other); below, which of
// the two Enter does while an agent works – the person's default (preferences.whileWorking, also in settings.json).
// With nothing to send the menu holds only that choice (no entry is greyed out). The caret is always there, so nothing
// in the action row moves; in schedule mode it rests (a schedule has no queue).
// Owns: the caret and its menu. Never: sends or queues itself (callbacks do).

import { useRef, useState } from 'preact/hooks';
import type { SendWhileWorking } from '../../../shared/model/prompt-queue.ts';
import { Icon, Menu } from '../../lib/ui.tsx';
import type { MenuItem } from '../../lib/ui.tsx';
import { comboLabel } from '../../lib/hotkeys.ts';

export interface SendSplitActions {
  /** Sends the draft now / lines it up; undefined while there is nothing to send. */
  sendNow?: () => void;
  queue?: () => void;
  preferred: SendWhileWorking;
  setPreferred: (mode: SendWhileWorking) => void;
  /** Enter sends (preferences.enterSends): the default is Enter, the other Ctrl+Enter; else Ctrl+Enter and Ctrl+Shift+Enter. */
  enterSends: boolean;
  scheduling?: boolean;
}

/** The keys of the default and of the other send (shown as hints). */
export function sendKeys(enterSends: boolean): { main: string; other: string } {
  return enterSends ? { main: 'Enter', other: comboLabel('mod+Enter') } : { main: comboLabel('mod+Enter'), other: comboLabel('mod+shift+Enter') };
}

export function SendSplit(props: { actions: SendSplitActions }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { actions } = props;
  const keys = sendKeys(actions.enterSends);
  const key = (mode: SendWhileWorking) => (mode === actions.preferred ? keys.main : keys.other);
  const send: MenuItem[] = [
    ...(actions.sendNow ? [{ label: 'Send now', description: 'Reaches a working agent at once', hint: key('now'), onSelect: actions.sendNow }] : []),
    ...(actions.queue ? [{ label: 'Add to queue', description: 'Goes out when the agent is done', hint: key('queue'), onSelect: actions.queue }] : []),
  ];
  const choice: MenuItem[] = [
    { label: 'Send now', checked: actions.preferred === 'now', onSelect: () => actions.setPreferred('now') },
    { label: 'Add to queue', checked: actions.preferred === 'queue', onSelect: () => actions.setPreferred('queue') },
  ];
  return (
    <>
      <button ref={ref} type="button" class="icon-button send-split" aria-label="More ways to send" title="Send now or add to queue"
        aria-haspopup="menu" aria-expanded={open} data-tour="composer-queue" disabled={actions.scheduling} onClick={() => setOpen(!open)}>
        <Icon name="caret-down" size={14} />
      </button>
      <Menu anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="top-end" width={280} label="Send options"
        sections={[...(send.length ? [{ items: send }] : []), { title: `${keys.main} while an agent works`, items: choice }]} />
    </>
  );
}
