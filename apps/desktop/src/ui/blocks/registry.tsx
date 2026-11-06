// Block registry: maps every catalog type to its renderer. Display blocks render as plain
// typography inside the message; ask widgets render inside AskBlock's calm shell.
// Owns: DISPLAY_BLOCKS, ASK_WIDGETS (the catalog's ask types) and <DisplayBlock> (unknown or broken →
// collapsed source).
// Never: renders raw HTML or lets an unknown type through as live UI.

import type { ComponentType } from 'preact';
import type { AskBlockType, DisplayBlockType, UiBlock } from '../../shared/blocks/catalog.ts';
import { Boundary } from './Boundary.tsx';
import { SourceFallback } from './CodeBlock.tsx';
import type { AskWidgetProps } from './ui/ask-types.ts';
import { Approve } from './ui/Approve.tsx';
import { Callout } from './ui/Callout.tsx';
import { Cards } from './ui/Cards.tsx';
import { Chart } from './ui/Chart.tsx';
import { Checklist } from './ui/Checklist.tsx';
import { Choice } from './ui/Choice.tsx';
import { Compare } from './ui/Compare.tsx';
import { Confirm } from './ui/Confirm.tsx';
import { FileBlock } from './ui/FileBlock.tsx';
import { Form } from './ui/Form.tsx';
import { Media } from './ui/Media.tsx';
import { Progress } from './ui/Progress.tsx';
import { RecordWidget } from './ui/Record.tsx';
import { Review } from './ui/Review.tsx';
import { Stats } from './ui/Stats.tsx';
import { Steps } from './ui/Steps.tsx';
import { Table } from './ui/Table.tsx';
import { Tabs } from './ui/Tabs.tsx';
import { Timeline } from './ui/Timeline.tsx';
import { Timer } from './ui/Timer.tsx';
import { Upload } from './ui/Upload.tsx';

export type DisplayBlockProps = { block: UiBlock };

/** All 12 display types of the catalog. */
export const DISPLAY_BLOCKS: Record<DisplayBlockType, ComponentType<DisplayBlockProps>> = {
  callout: Callout,
  steps: Steps,
  table: Table,
  stats: Stats,
  chart: Chart,
  timeline: Timeline,
  compare: Compare,
  cards: Cards,
  media: Media,
  file: FileBlock,
  progress: Progress,
  tabs: Tabs,
};

/** All 9 ask types of the catalog (AskBlock looks them up by `block.type`). */
export const ASK_WIDGETS: Record<string, ComponentType<AskWidgetProps>> = {
  choice: Choice,
  form: Form,
  approve: Approve,
  checklist: Checklist,
  timer: Timer,
  record: RecordWidget,
  upload: Upload,
  confirm: Confirm,
  review: Review,
} satisfies Record<AskBlockType, ComponentType<AskWidgetProps>>;

function sourceOf(block: UiBlock): string {
  try { return JSON.stringify(block, null, 2) ?? ''; } catch { return ''; }
}

/** One display block. Unknown types and render errors show the source collapsed. */
export function DisplayBlock(props: { block: UiBlock }) {
  const { block } = props;
  const View = (DISPLAY_BLOCKS as Record<string, ComponentType<DisplayBlockProps> | undefined>)[block.type];
  if (!View) return <SourceFallback label="Couldn't display" source={sourceOf(block)} lang="ui" />;
  return (
    <Boundary fallback={() => <SourceFallback label="Couldn't display" source={sourceOf(block)} lang="ui" />}>
      <View block={block} />
    </Boundary>
  );
}
