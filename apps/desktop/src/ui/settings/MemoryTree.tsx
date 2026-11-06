// The memory tree on Settings › Skills & memory: the folders of <data>/memory, each opening under itself when clicked, and
// the Markdown files, each opening in the pane's file tab. A right click offers the system's own app.
// Owns: the tree's rows and which folders are open. Never: reads or changes a memory (the file tab does).

import { useEffect, useState } from 'preact/hooks';
import type { PathEntry, PathList } from '../../shared/api/methods-files.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { errorText, rpc } from '../lib/rpc.ts';
import { Icon } from '../lib/ui.tsx';
import { openFileTab, pathMenu } from '../workspace/file-tabs.ts';
import { Note, Row } from './controls.tsx';

function Entry(props: { entry: PathEntry; depth: number }) {
  const { entry, depth } = props;
  const [open, setOpen] = useState(false);
  const menu = useContextMenu(() => pathMenu(entry.path));
  const click = () => { if (entry.folder) setOpen(!open); else openFileTab(entry.path); };
  return (
    <li>
      <button type="button" class="file-tree-row" style={{ '--depth': depth }} aria-expanded={entry.folder ? open : undefined} {...menu} onClick={click}>
        <span class="file-tree-icon" aria-hidden="true"><Icon name={entry.folder ? (open ? 'caret-down' : 'caret-right') : 'file'} size={14} /></span>
        <span class="file-tree-name">{entry.name}</span>
      </button>
      {open && <Branch path={entry.path} depth={depth + 1} />}
    </li>
  );
}

function Branch(props: { path: string; depth: number }) {
  const [list, setList] = useState<PathList | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let alive = true;
    rpc.call('files.listPath', { path: props.path }).then((next) => { if (alive) setList(next); }, (error: unknown) => { if (alive) setFailed(errorText(error)); });
    return () => { alive = false; };
  }, [props.path]);
  if (failed) return <Row label="Unavailable" hint={failed} reserve />;
  if (!list) return null;
  if (!list.entries.length) return props.depth ? null : <Row label={<Note>No memories yet.</Note>} reserve />;
  return <ul class="file-tree">{list.entries.map((entry) => <Entry key={entry.path} entry={entry} depth={props.depth} />)}</ul>;
}

export function MemoryTree(props: { root: string }) {
  return <Branch path={props.root} depth={0} />;
}
