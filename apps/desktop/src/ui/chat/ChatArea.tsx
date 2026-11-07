// A chat's area: the chat's own tabs (websites with the logins made in them, its notes, media, video, files, the screen …)
// in one workspace surface (workspace/WorkspacePane.tsx on chatSpace(id)), shared by everyone in the chat. Part of the
// chat, not of the frame: the chat's colour, rounded tabs, one line to the messages (chat-area.css), while the person's
// own pane at the frame's right keeps its Chrome look. The header's Chat tabs cell opens and closes it (ChatHeader.tsx),
// per chat. AF-010: it docks where settings.json › appearance.chatDock says (lib/appearance.ts) – right of the
// messages by default, like a side panel, else left, at the bottom, at the top, or floating as a window of its own over
// the chat – with a grip on its inner edge (the floating window: its right and bottom edges and the corner) to size it.
// Its grip cell at the strip's end – or the strip's empty room – drags it: a guide over the chat shows where it lands
// (an edge docks there, anywhere else it floats); a click on the cell opens the same choices as a menu. Position and
// size are saved for the person, so they stay after a restart. The phone and full view keep it above the messages.
// Owns: that section, its grips and its drag. Never: tab logic (workspace/pages.ts) or whether it is open (lib/shell-state.ts).

import { useLayoutEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { createPortal } from 'preact/compat';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { chatSpace } from '../../shared/api/workspace-browser.ts';
import {
  CHAT_MIN, DEFAULT_CHAT_DOCK, DOCK_LABELS, DOCK_LIMITS, DOCK_PLACES, dockPlaceAt, fitFloat, previewBox,
  type Box, type ChatDock, type DockPlace, type Size,
} from '../../shared/model/appearance.ts';
import { chatDock, dockAt, dockLive, resetDock, saveDock, setDockDragging, surfacesMoved } from '../lib/appearance.ts';
import { openContextMenu } from '../lib/context-menu.tsx';
import { setChatArea } from '../lib/shell-state.ts';
import { toastError } from '../lib/toasts.ts';
import { IconButton, type MenuSection } from '../lib/ui.tsx';
import { WorkspacePane } from '../workspace/WorkspacePane.tsx';
import { DockResize } from './DockResize.tsx';

/** Where a drag would put the chat's tabs: the place and its box in the chat body's px. */
interface Guide { place: DockPlace; box: Box }

/** The choices of the grip cell's menu (and its right click). */
export function dockMenu(conversationId: string, place: DockPlace): MenuSection[] {
  return [
    { title: 'Chat tabs', items: DOCK_PLACES.map((each) => ({ label: DOCK_LABELS[each], checked: each === place, onSelect: () => dockAt(each) })) },
    { items: [
      { label: 'Reset position and size', onSelect: resetDock },
      { label: 'Close chat tabs', onSelect: () => setChatArea(conversationId, false) },
    ] },
  ];
}

const sizeOf = (element: Element | null | undefined): Size => {
  const rect = element?.getBoundingClientRect();
  return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
};

export function ChatArea(props: { chat: ConversationSummary; place: DockPlace }) {
  const { chat, place } = props;
  const dock = chatDock.value;
  const section = useRef<HTMLElement>(null);
  /** The chat body (the room the tabs dock or float in) and its size. */
  const body = useSignal<HTMLElement | null>(null);
  const room = useSignal<Size>({ width: 0, height: 0 });
  const guide = useSignal<Guide | null>(null);
  const dragged = useRef(false); // the last press on the grip cell was a drag: its click opens no menu

  useLayoutEffect(() => {
    const element = section.current?.closest<HTMLElement>('.chat-body') ?? null;
    body.value = element;
    if (!element) return;
    const measure = () => { room.value = sizeOf(element); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [place]);

  const float = fitFloat(dock, room.value);
  // a move that resizes nothing (a floating window dragged, a dock changing sides) still moves the native page
  useLayoutEffect(() => { surfacesMoved(); }, [place, float.x, float.y, float.width, float.height]);

  const live = (patch: Partial<ChatDock> | null) => { dockLive.value = patch; };
  const save = (patch: Partial<ChatDock>) => saveDock(patch);

  /** A press on the grip cell or the strip's empty room: a drag past 5 px shows the guide, letting go docks or floats. */
  const startDrag = (event: PointerEvent) => {
    const host = body.peek();
    const own = section.current;
    if (event.button !== 0 || !host || !own) return;
    const handle = event.currentTarget as HTMLElement;
    const from = own.getBoundingClientRect();
    const begin = { x: event.clientX, y: event.clientY };
    // where the pointer holds the window: inside its title room, at most the floating window's size
    const hold = { x: Math.min(event.clientX - from.left, dock.floatWidth - 48), y: Math.min(event.clientY - from.top, 30) };
    let moving = false;
    dragged.current = false;
    handle.setPointerCapture(event.pointerId);
    const at = (point: PointerEvent): Guide | null => {
      const rect = host.getBoundingClientRect();
      const target = dockPlaceAt({ x: point.clientX, y: point.clientY }, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      if (!target) return null;
      const size = { width: rect.width, height: rect.height };
      const floated = fitFloat({ ...dock, floatX: point.clientX - rect.left - hold.x, floatY: point.clientY - rect.top - hold.y }, size);
      return { place: target, box: previewBox(target, dock, size, floated) };
    };
    const move = (next: PointerEvent) => {
      if (!moving && Math.hypot(next.clientX - begin.x, next.clientY - begin.y) < 5) return;
      if (!moving) { moving = true; dragged.current = true; setDockDragging(true); }
      guide.value = at(next);
    };
    const stop = (last: PointerEvent, cancel: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', abort);
      const landing = cancel || !moving ? null : at(last);
      guide.value = null;
      if (moving) setDockDragging(false);
      if (!landing) return;
      const patch: Partial<ChatDock> = { place: landing.place };
      if (landing.place === 'float') { patch.floatX = landing.box.x; patch.floatY = landing.box.y; }
      void save(patch).catch((error) => toastError(error, 'Could not move the chat tabs'));
    };
    const up = (last: PointerEvent) => stop(last, false);
    const abort = (last: PointerEvent) => stop(last, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', abort);
  };

  /** The strip's own empty room starts the same drag (like a window's title bar); its tabs, buttons and fields do not. */
  const onStripDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.browser-strip') || target.closest('button, a, input, [role=tab], .browser-strip-tab, .dock-resize')) return;
    startDrag(event);
  };

  const menuAt = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    openContextMenu(rect.right, rect.bottom + 4, dockMenu(chat.id, place));
  };

  const width = Math.min(dock.width, Math.max(240, room.value.width - CHAT_MIN.width));
  const style = place === 'float'
    ? { left: `${float.x}px`, top: `${float.y}px`, width: `${float.width}px`, height: `${float.height}px` }
    : { '--chat-dock-w': `${dock.width}px`, '--chat-dock-h': `${dock.height}px` };
  const sideways = place === 'right' || place === 'left';
  const host = body.value;
  return (
    <section ref={section} class={`chat-area dock-${place}`} aria-label="Chat tabs" data-tour="side-panel" data-dock={place} style={style}
      onPointerDown={onStripDown}>
      {place !== 'float' && (
        <DockResize label="Resize chat tabs" class="dock-edge" axis={sideways ? 'x' : 'y'} sign={place === 'right' || place === 'bottom' ? -1 : 1}
          value={sideways ? width : dock.height} min={sideways ? 240 : DOCK_LIMITS.height[0]}
          max={sideways ? Math.max(240, room.value.width - CHAT_MIN.width) : Math.max(DOCK_LIMITS.height[0], room.value.height - CHAT_MIN.height)}
          defaultValue={sideways ? DEFAULT_CHAT_DOCK.width : DEFAULT_CHAT_DOCK.height}
          measure={() => (sideways ? sizeOf(section.current).width : sizeOf(section.current).height)}
          onLive={(value) => live(value === null ? null : sideways ? { width: value } : { height: value })}
          onSave={(value) => save(sideways ? { width: value } : { height: value })} />
      )}
      <WorkspacePane key={chat.id} space={chatSpace(chat.id)} />
      <IconButton icon="dots-six-vertical" label="Move chat tabs" title="Drag to dock elsewhere or float · click for choices" size="small" class="dock-grip"
        aria-haspopup="menu" onPointerDown={startDrag}
        onClick={(event) => { if (dragged.current) { dragged.current = false; return; } menuAt(event.currentTarget as HTMLElement); }}
        onContextMenu={(event) => { event.preventDefault(); menuAt(event.currentTarget as HTMLElement); }} />
      {place === 'float' && <>
        <DockResize label="Resize the chat tabs' width" class="float-edge-x" axis="x" sign={1} value={float.width}
          min={DOCK_LIMITS.floatWidth[0]} max={Math.max(DOCK_LIMITS.floatWidth[0], room.value.width - float.x)} defaultValue={DEFAULT_CHAT_DOCK.floatWidth}
          measure={() => sizeOf(section.current).width} onLive={(value) => live(value === null ? null : { floatWidth: value })} onSave={(value) => save({ floatWidth: value })} />
        <DockResize label="Resize the chat tabs' height" class="float-edge-y" axis="y" sign={1} value={float.height}
          min={DOCK_LIMITS.floatHeight[0]} max={Math.max(DOCK_LIMITS.floatHeight[0], room.value.height - float.y)} defaultValue={DEFAULT_CHAT_DOCK.floatHeight}
          measure={() => sizeOf(section.current).height} onLive={(value) => live(value === null ? null : { floatHeight: value })} onSave={(value) => save({ floatHeight: value })} />
      </>}
      {host && guide.value && createPortal(
        <div class="dock-guide" aria-hidden="true">
          <div class={`dock-guide-box dock-guide-${guide.value.place}`}
            style={{ left: `${guide.value.box.x}px`, top: `${guide.value.box.y}px`, width: `${guide.value.box.width}px`, height: `${guide.value.box.height}px` }}>
            <span>{DOCK_LABELS[guide.value.place]}</span>
          </div>
        </div>,
        host,
      )}
    </section>
  );
}
