// The one composer: auto-growing field (to ~40 % of the window), Enter sends (setting), per-chat drafts,
// attachments (Plus menu, drag/drop, paste), @mentions and /commands, dictation into the caret (the
// waveform sits in the action row's spacer) and one primary button: Send, disabled without content.
// Action row, fixed cells: [+] [spacer] [Ultra] [Model] [Mic] [Send] – nothing in it moves on a click.
// How a message goes out: /important, /silent, or the Plus menu's and the Send button's right-click menu's "Send as important",
// "Send silently" (with nothing to send yet: the draft's level) and "Schedule…": that switches the composer into schedule
// mode (composer/ScheduleBar.tsx above the text, the field taller, Send = Schedule; Esc or × leaves; text only – a draft
// with files cannot be scheduled and says so). Plus › Secret opens the secret mode the same way (settings/SecretRows.tsx
// ChatSecretBar above the text: each row becomes a chip).
// A reply shows its quote chip above the field (X or Esc cancels it) and goes out as `replyTo`.
// A one-shot fill ("/task ") goes only into an empty composer – it never overwrites the person's draft.
// Owns: input handling and when to send (the send itself: composer/send.ts). Never: message rendering or chat settings UI.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ConversationSummary, MessageLevel } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { chatPartner, chatTitle, memberName } from '../lib/chat-face.tsx';
import { isMobile, preferences } from '../lib/store.ts';
import { bridge } from '../lib/platform.ts';
import { toAttachment, uploadFile } from '../lib/files.ts';
import { COMPOSER_BUSY, composerFill, composerFillText } from '../lib/shell-state.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { ComposerAttachments } from './Attachments.tsx';
import { SecretAttachments } from './SecretAttachments.tsx';
import { ChatSecretBar } from '../settings/SecretRows.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';
import { draftFor, flushDraft, setReply, updateDraft } from './composer/draft.ts';
import { sendDraft } from './composer/send.ts';
import { createTaskFromText, parseSlash, runSlash, sendMenuItems } from './composer/slash.ts';
import { findToken, suggestionsFor, SuggestionList, useSuggestions } from './composer/Suggestions.tsx';
import type { Suggestion } from './composer/Suggestions.tsx';
import { ModelChip } from './composer/ModelChip.tsx';
import { PlusMenu } from './composer/PlusMenu.tsx';
import { ScheduleBar } from './composer/ScheduleBar.tsx';
import { leaveScheduleMode, openScheduleMode, scheduleDraft, scheduleModeFor } from './composer/schedule-mode.ts';
import { scheduleSpec } from './composer/schedule-form.ts';
import { useNextRun } from './composer/schedule-next.ts';
import { UltraCell, ultraOffered } from './composer/UltraCell.tsx';
import { cancelDictation, clearDraftSpeech, dictateIntoDraft, dictating, transcribing } from './composer/voice.ts';
import { MicButton, useDictationField, waveState } from './composer/MicButton.tsx';
import { DictationWave } from './composer/DictationWave.tsx';
import { mentionsIn, targetAgent } from './composer/target.ts';
import { composerControls } from './composer/controls.ts';

export function Composer(props: { chat: ConversationSummary }) {
  const { chat } = props;
  const draft = draftFor(chat.id);
  const { text, attachments, level, replyTo, secrets = [], ultra = false } = draft.value;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [uploading, setUploading] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [modelSignal, setModelSignal] = useState(0);
  const mode = scheduleModeFor(chat.id).value; // schedule mode (null = a normal composer)
  const scheduling = mode !== null;
  const suggest = useSuggestions();
  const isDictating = dictating.value === chat.id;
  const transcribingHere = transcribing.value.has(chat.id); // the stopped take's text is still on its way
  const hasContent = text.trim().length > 0 || attachments.length > 0 || secrets.length > 0;

  const setText = (value: string) => updateDraft(chat.id, { text: value });
  useDictationField(chat.id, fieldRef, setCaret); // D13: the caret after a dictated take

  // Auto-grow up to ~40 % of the viewport, then scroll (schedule mode: from a taller minimum, composer.css).
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [text, scheduling]);
  useEffect(() => { if (scheduling) fieldRef.current?.focus(); }, [scheduling]); // opened from a menu: write the message

  useEffect(() => {
    if (!isMobile.value) fieldRef.current?.focus();
    return () => flushDraft(chat.id);
  }, [chat.id]);
  useEffect(() => { if (replyTo) fieldRef.current?.focus(); }, [replyTo]); // Reply on a message: write it here

  // An emptied draft (sent, turned into a task, cleared) was not dictated any more; reads the draft as it
  // is now, so a failed send that gave the speech back with the text keeps it.
  useEffect(() => { if (!draft.peek().text.trim()) clearDraftSpeech(chat.id); }, [chat.id, text]);

  // One-shot fills ("/task " from the palette and the task panel): only into an empty composer; a
  // draft stays as it is – the field takes the focus and a toast says why nothing was inserted.
  useEffect(() => {
    const fill = composerFill.value;
    if (!fill || fill.conversationId !== chat.id) return;
    composerFill.value = null;
    const next = composerFillText(text, fill.text); // never over the person's draft
    if (next === null) pushToast({ title: COMPOSER_BUSY, tone: 'info' }, 4000);
    else setText(next);
    requestAnimationFrame(() => { const field = fieldRef.current; field?.focus({ preventScroll: true }); field?.setSelectionRange(field.value.length, field.value.length); });
  }, [composerFill.value]);

  const token = findToken(text, caret);
  const items = suggestionsFor(chat, token);
  const visibleItems = suggest.dismissed === items.map((item) => item.key).join() ? [] : items;

  const accept = (item: Suggestion) => {
    if (!token) return;
    const next = text.slice(0, token.start) + item.insert + text.slice(caret);
    setText(next);
    const position = token.start + item.insert.length;
    requestAnimationFrame(() => { fieldRef.current?.setSelectionRange(position, position); setCaret(position); });
  };

  const addFiles = async (list: File[]) => {
    if (!list.length) return;
    setUploading((current) => [...current, ...list.map((file) => file.name)]);
    for (const file of list) {
      try {
        const attachment = await uploadFile(file, undefined, { conversationId: chat.id }); // F-52: a person's file goes into this chat
        updateDraft(chat.id, { attachments: [...draft.value.attachments, attachment] });
      } catch (error) { toastError(error, 'Upload failed'); }
      setUploading((current) => { const index = current.indexOf(file.name); return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)]; });
    }
  };

  const pickFiles = async (images: boolean) => {
    if (bridge) {
      // Desktop: the native dialog; main uploads the choice by path (no bytes through here).
      try {
        const refs = await bridge.files.pick(images ? 'images' : 'files');
        if (refs.length) updateDraft(chat.id, { attachments: [...draft.value.attachments, ...refs.map(toAttachment)] });
      } catch (error) { toastError(error, 'Upload failed'); }
      return;
    }
    (images ? imageRef : fileRef).current?.click();
  };

  // The whole draft goes out – files, secrets, reply – also at another level (composer/send.ts).
  const sendAs = (body: string, sentLevel: MessageLevel) => sendDraft({ conversationId: chat.id, body, level: sentLevel, mentions: (sent) => mentionsIn(sent, chat), ultraOffered: ultraOffered(chat) });

  /** `sentLevel`: the Plus menu's "Send as important" / "Send silently" (no slash command then). */
  const send = async (sentLevel?: MessageLevel) => {
    if (sending || transcribing.peek().has(chat.id)) return; // never sends without the dictated words
    setSending(true); // also while a dictation is transcribed first (a second tap sends nothing twice)
    try {
      // A take that came back as a recording or failed stays in the draft: the person sees it (and the toast) first.
      if (isDictating && !(await dictateIntoDraft())) return;
      const body = draft.value.text;
      if (!body.trim() && !draft.value.attachments.length && !draft.value.secrets?.length) return;
      const slash = sentLevel ? null : parseSlash(body);
      if (slash) {
        const clear = await runSlash(slash, {
          chat,
          openModelMenu: () => setModelSignal(Date.now()),
          setLevel: (next) => updateDraft(chat.id, { level: next }),
          send: (rest, options) => sendAs(rest, options?.level ?? draft.peek().level),
        });
        if (clear) updateDraft(chat.id, { text: '' }); // a sent command's draft is already fresh (sendDraft)
        return;
      }
      await sendAs(body, sentLevel ?? draft.value.level);
    } finally {
      setSending(false);
      fieldRef.current?.focus();
    }
  };

  /** Schedule mode's Send: posts the draft at the settings' time(s) – also at another level (the right-click menu). */
  const scheduleNow = async (sentLevel?: MessageLevel) => {
    if (sending || transcribing.peek().has(chat.id)) return;
    setSending(true);
    try {
      if (isDictating && !(await dictateIntoDraft())) return;
      if (sentLevel) updateDraft(chat.id, { level: sentLevel });
      await scheduleDraft(chat, draft.peek().ultra === true && ultraOffered(chat));
    } finally {
      setSending(false);
      fieldRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (suggest.onKeyDown(event, visibleItems, accept)) { event.preventDefault(); return; }
    if (event.key === 'Escape' && scheduling) { event.preventDefault(); leaveScheduleMode(chat.id); return; }
    if (event.key === 'Escape' && draft.peek().replyTo) { event.preventDefault(); setReply(chat.id, null); return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const enterSends = preferences.value.enterSends && !isMobile.value;
    if ((enterSends && !event.shiftKey && !mod) || (!enterSends && mod)) { event.preventDefault(); void (scheduling ? scheduleNow() : send()); }
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) { event.preventDefault(); void addFiles(files); }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void addFiles(files);
  };

  const makeTask = async () => {
    const body = draft.value.text.trim();
    if (!body) composerFill.value = { conversationId: chat.id, text: '/task ' }; // an empty field: write the task there
    else if (await createTaskFromText(chat.id, body)) updateDraft(chat.id, { text: '', replyTo: undefined });
  };

  const agentId = targetAgent(text, chat, replyTo);
  const partner = chatPartner(chat);
  const placeholder = `${scheduling ? 'Scheduled message for' : 'Message'} ${(partner && memberName(partner.memberId)) || chatTitle(chat)}`;

  const controls = composerControls({ hasContent, transcribing: transcribingHere });
  // A scheduled message is text only: files and secrets in the draft would be left behind, so the mode says so (note)
  const heavy = [attachments.length ? 'files' : '', secrets.length ? 'secrets' : ''].filter(Boolean).join(' and ');
  const note = scheduling && heavy ? `A scheduled message is text only – remove the ${heavy} to schedule it.` : undefined;
  const built = mode ? scheduleSpec(mode.form, Date.now()) : null;
  const next = useNextRun(built && 'spec' in built ? built.spec : null);
  const scheduleReady = !!built && 'spec' in built && !next.error && !note && !!text.trim();
  const sendActions = {
    sendAs: scheduling ? (scheduleReady ? (sentLevel: MessageLevel) => void scheduleNow(sentLevel) : undefined) : hasContent ? (sentLevel: MessageLevel) => void send(sentLevel) : undefined,
    level, setLevel: (next: MessageLevel) => updateDraft(chat.id, { level: next }),
    schedule: () => openScheduleMode(chat.id),
    scheduling,
  };
  const sendMenu = useContextMenu(() => [{ items: sendMenuItems(sendActions) }]);
  // Schedule mode: the same round cell with a clock (a wider label would move Ultra, the model and the mic)
  const primary = <button type="button" class="send-button" aria-label={scheduling ? 'Schedule' : 'Send'} title={scheduling ? 'Schedule' : undefined} {...sendMenu}
    disabled={(scheduling ? !scheduleReady || transcribingHere : controls.primary === 'send-disabled') || sending || uploading.length > 0}
    onClick={() => void (scheduling ? scheduleNow() : send())}><Icon name={scheduling ? 'clock' : 'arrow-up'} size={19} /></button>;

  return (
    <div class="composer-area">
      <div class={`composer${dragOver ? ' drag-over' : ''}${level === 'important' ? ' important' : ''}${scheduling ? ' scheduling' : ''}`}
        onDragOver={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <SuggestionList items={visibleItems} active={suggest.active} onPick={accept} onHover={suggest.setActive} />
        {mode && <ScheduleBar conversationId={chat.id} mode={mode} next={next} note={note} onLeave={() => leaveScheduleMode(chat.id)} />}
        {secretOpen && <ChatSecretBar key={chat.id} conversationId={chat.id} room={20 - secrets.length} onLeave={() => { setSecretOpen(false); fieldRef.current?.focus(); }}
          onAttach={(id) => updateDraft(chat.id, { secrets: [...(draft.peek().secrets ?? []), id] })} />}
        {replyTo && <ReplyQuote conversationId={chat.id} messageId={replyTo} onCancel={() => { setReply(chat.id, null); fieldRef.current?.focus(); }} />}
        <SecretAttachments ids={secrets} onRemove={id => updateDraft(chat.id, { secrets: secrets.filter(entry => entry !== id) })} />
        <ComposerAttachments attachments={attachments} uploading={uploading}
          onRemove={(fileId) => updateDraft(chat.id, { attachments: draft.value.attachments.filter((entry) => entry.fileId !== fileId) })} />
        <div class="composer-field">
          <textarea
            ref={fieldRef}
            class="composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onInput={(event) => { const field = event.target as HTMLTextAreaElement; setText(field.value); setCaret(field.selectionStart); suggest.dismiss(null); }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
            onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
            onPaste={onPaste}
          />
        </div>
        <div class="composer-actions">
          <PlusMenu chat={chat} actions={{
            discardDictation: isDictating ? () => void cancelDictation() : undefined,
            pickFiles: () => void pickFiles(false),
            pickImages: () => void pickFiles(true),
            secret: secrets.length < 20 ? () => setSecretOpen(true) : undefined,
            makeTask: () => void makeTask(),
            ...sendActions,
          }} />
          <div class="composer-spacer"><DictationWave state={waveState(chat.id)} /></div>
          <UltraCell chat={chat} on={ultra} onToggle={(next) => updateDraft(chat.id, { ultra: next || undefined })} />
          <ModelChip chat={chat} agentId={agentId} openSignal={modelSignal} />
          <MicButton draftKey={chat.id} field={fieldRef} onStop={() => void dictateIntoDraft()} />
          {primary}
        </div>
      </div>
      <input ref={fileRef} type="file" multiple hidden onChange={(event) => { const input = event.target as HTMLInputElement; void addFiles([...(input.files ?? [])]); input.value = ''; }} />
      <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={(event) => { const input = event.target as HTMLInputElement; void addFiles([...(input.files ?? [])]); input.value = ''; }} />
    </div>
  );
}
