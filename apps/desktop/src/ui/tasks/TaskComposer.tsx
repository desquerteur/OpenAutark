// The task center's quick composer (Work view): chat-like – an auto-growing field, files (Plus › Files, a folder
// on the desktop, photos and screenshots, a screenshot of the screen on the desktop; paste and drop), dictation
// with the chat's microphone path – and nothing that has to be chosen first: no mode, no model, no permissions.
// B-078: who does it is optional and lives in the Plus menu's "Send to…" section (RecipientMenu.tsx; Auto by default:
// the decision model picks the owner); a small removable chip names it only while one is picked. Enter posts (the chat's Enter setting) and the field is free for the next task at
// once (quick-post.ts shows the post as "Sending…" until the runtime answers). In the owner's session the
// recipients include the active people (F-52): her task goes straight to her (no routing). "Me" puts every part
// of the post on My day.
// The draft is kept under a fixed local key (quick-post.ts QUICK_DRAFT_KEY): text and files survive navigation
// in this window. Dictation never outlives the composer: leaving Work stops it into the draft, and Escape stops
// a running dictation first (the text stays). D13: the chat composer's mic (MicButton: the take goes to the
// caret, starting state at once), its level waveform in the spacer, and a take is discarded only from the Plus menu
// (Plus never turns into a one-click X).
// Owns: the composer's input handling. Never: routes or picks an owner (the runtime does), or offers a
// conversation mode here (the owner's chat has it once someone works on the task).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../../shared/model/chat.ts';
import { Icon, Menu } from '../lib/ui.tsx';
import type { MenuItem, MenuSection } from '../lib/ui.tsx';
import { agents, isMobile, preferences } from '../lib/store.ts';
import { people } from '../lib/people.ts';
import { bridge } from '../lib/platform.ts';
import { MAX_FILES, toAttachment, uploadFile } from '../lib/files.ts';
import { toastError } from '../lib/toasts.ts';
import { ComposerAttachments } from '../chat/Attachments.tsx';
import { clearDraft, draftFor, updateDraft } from '../chat/composer/draft.ts';
import { cancelDictation, clearDraftSpeech, dictateIntoDraft, dictating, transcribing } from '../chat/composer/voice.ts';
import { MicButton, useDictationField, waveState } from '../chat/composer/MicButton.tsx';
import { DictationWave } from '../chat/composer/DictationWave.tsx';
import { discardDictationItem } from '../chat/composer/PlusMenu.tsx';
import { dataUrlToBlob, screenshotName } from '../feedback/bridge.ts';
import { targetLabel } from './center-model.ts';
import { QUICK_DRAFT_KEY, composerTarget, postQuickTask, quickParams } from './quick-post.ts';
import { RecipientChip, recipientPeople, recipientSections } from './RecipientMenu.tsx';

const canScreenshot = () => typeof bridge?.capture?.screen === 'function';

function PlusMenu(props: { pick: (kind: 'files' | 'folder' | 'images') => void; screenshot?: () => void; discard?: () => void; sendTo: () => MenuSection[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const add: MenuItem[] = [
    { label: 'Files', onSelect: () => props.pick('files') },
    ...(bridge ? [{ label: 'Folder', onSelect: () => props.pick('folder') }] : []),
    { label: 'Photos & screenshots', onSelect: () => props.pick('images') },
    ...(props.screenshot ? [{ label: 'Take screenshot', onSelect: props.screenshot }] : []),
  ];
  return (
    <>
      <button ref={ref} type="button" class="icon-button composer-plus" aria-label="Add" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" size={20} />
      </button>
      <Menu anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="top-start" width={280} label="Add" class="recipient-list"
        sections={open ? [...(props.discard ? [{ items: [discardDictationItem(props.discard)] }] : []), { items: add }, ...props.sendTo()] : []} />
    </>
  );
}

function Body(props: { autoFocus: boolean }) {
  const key = QUICK_DRAFT_KEY;
  const draft = draftFor(key);
  const { text, attachments } = draft.value;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const isDictating = dictating.value === key;
  const transcribingHere = transcribing.value.has(key);
  const target = composerTarget.value;
  const hasContent = text.trim().length > 0 || attachments.length > 0;
  useDictationField(key, fieldRef); // D13: the caret after a dictated take
  const setText = (value: string) => updateDraft(key, { text: value });

  // A recipient that left (archived agent, emptied team, removed person) goes back to Auto.
  useEffect(() => { if (target && targetLabel(target, agents.value, recipientPeople(true)) === undefined) composerTarget.value = undefined; }, [agents.value, people.value, target]);
  useEffect(() => { if (props.autoFocus && !isMobile.value) fieldRef.current?.focus(); }, []);
  // The microphone never outlives the composer (Work left): the take goes into the draft.
  useEffect(() => () => { if (dictating.peek() === key) void dictateIntoDraft(); }, [key]);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, Math.round(innerHeight * 0.35))}px`;
  }, [text]);

  const room = () => MAX_FILES - draft.peek().attachments.length - uploading.length;
  const attach = (list: Attachment[]) => updateDraft(key, { attachments: [...draft.peek().attachments, ...list] });
  const addFiles = async (files: File[]) => {
    const list = files.slice(0, Math.max(0, room()));
    if (list.length < files.length) toastError(new Error(`Up to ${MAX_FILES} files per task.`), 'Not all files attached');
    setUploading((current) => [...current, ...list.map((file) => file.name)]);
    for (const file of list) {
      try { attach([await uploadFile(file)]); } catch (error) { toastError(error, 'Upload failed'); }
      setUploading((current) => { const index = current.indexOf(file.name); return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)]; });
    }
  };
  const pick = async (kind: 'files' | 'folder' | 'images') => {
    if (!bridge) { (kind === 'images' ? imageRef : fileRef).current?.click(); return; }
    try {
      const refs = await bridge.files.pick(kind); // main uploads the choice by path
      const fits = refs.slice(0, Math.max(0, room()));
      if (fits.length < refs.length) toastError(new Error(`Up to ${MAX_FILES} files per task.`), 'Not all files attached');
      if (fits.length) attach(fits.map(toAttachment));
    } catch (error) { toastError(error, 'Upload failed'); }
  };
  const screenshot = async () => {
    if (room() <= 0) { toastError(new Error(`Up to ${MAX_FILES} files per task.`), 'Not attached'); return; }
    setUploading((current) => [...current, 'Screenshot']);
    try {
      const url = await bridge!.capture.screen();
      attach([await uploadFile(dataUrlToBlob(url), screenshotName(url))]);
    } catch (error) { toastError(error, 'Screenshot failed'); } finally {
      setUploading((current) => { const index = current.indexOf('Screenshot'); return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)]; });
    }
  };

  const post = async () => {
    if (posting || uploading.length || transcribing.peek().has(key)) return;
    setPosting(true);
    try {
      if (dictating.peek() === key && !(await dictateIntoDraft())) return; // a take that came back as a recording stays for a look first
      const current = draft.peek();
      if (!current.text.trim() && !current.attachments.length) return;
      const params = quickParams({ text: current.text, attachments: current.attachments, target: composerTarget.peek() });
      clearDraft(key); // the field is free for the next task at once
      clearDraftSpeech(key);
      void postQuickTask(params, { files: current.attachments });
    } finally {
      setPosting(false);
      fieldRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && dictating.peek() === key) { event.preventDefault(); void dictateIntoDraft(); return; } // first Escape: stop dictating
    if (event.key !== 'Enter' || event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const enterSends = preferences.value.enterSends && !isMobile.value;
    if ((enterSends && !event.shiftKey && !mod) || (!enterSends && mod)) { event.preventDefault(); void post(); }
  };

  return (
    <div class={`composer task-composer${dragOver ? ' drag-over' : ''}`}
      onDragOver={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => { event.preventDefault(); setDragOver(false); const files = [...(event.dataTransfer?.files ?? [])]; if (files.length) void addFiles(files); }}>
      <ComposerAttachments attachments={attachments} uploading={uploading}
        onRemove={(fileId) => updateDraft(key, { attachments: draft.peek().attachments.filter((entry) => entry.fileId !== fileId) })} />
      <div class="composer-field">
        <textarea ref={fieldRef} class="composer-input task-composer-input" rows={1} value={text} placeholder="New task" aria-label="New task"
          onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length) { event.preventDefault(); void addFiles(files); } }} />
      </div>
      <div class="composer-actions">
        <PlusMenu pick={(kind) => void pick(kind)} screenshot={canScreenshot() ? () => void screenshot() : undefined}
          discard={isDictating ? () => void cancelDictation() : undefined}
          sendTo={() => recipientSections({ value: composerTarget.peek(), people: true, me: true, onPick: (next) => { composerTarget.value = next; } })} />
        <RecipientChip value={target} people onClear={() => { composerTarget.value = undefined; }} />
        <div class="composer-spacer"><DictationWave state={waveState(key)} /></div>
        <MicButton draftKey={key} field={fieldRef} onStop={() => void dictateIntoDraft()} />
        <button type="button" class="send-button" aria-label="Post task" title="Post task"
          disabled={(!hasContent && !isDictating) || uploading.length > 0 || transcribingHere || posting} onClick={() => void post()}>
          <Icon name="arrow-up" size={19} />
        </button>
      </div>
      <input ref={fileRef} type="file" multiple hidden onChange={(event) => { const input = event.currentTarget as HTMLInputElement; void addFiles([...(input.files ?? [])]); input.value = ''; }} />
      <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={(event) => { const input = event.currentTarget as HTMLInputElement; void addFiles([...(input.files ?? [])]); input.value = ''; }} />
    </div>
  );
}

/** The quick composer on its fixed local draft (no chat to wait for: it shows at once). */
/** `autoFocus` false: the side pane's Work tab does not take the keyboard from the chat beside it. */
export function TaskComposer(props: { autoFocus?: boolean }) {
  return <Body autoFocus={props.autoFocus !== false} />;
}
