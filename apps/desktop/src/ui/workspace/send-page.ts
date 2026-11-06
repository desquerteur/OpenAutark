// "Send page to chat" (the page's right-click menu, main/workspace-page-menu.ts, and the pane's menu): the page's address
// goes into the open chat's message field and a picture of the visible page (main's capture) is
// attached to it – the person sends the message. Without a picture the address goes alone. Mark a region
// (RegionDialog.tsx) and Comment at (VideoView.tsx) put their part into the message field through the same steps.
// Owns: that hand-over. Never: sends a message or reads the page beyond its picture.

import { draftFor, updateDraft } from '../chat/composer/draft.ts';
import { uploadFile } from '../lib/files.ts';
import { bridge } from '../lib/platform.ts';
import { activeConversationId } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { hostOf } from './browser-model.ts';
import { browserPages } from './pages.ts';

function jpeg(dataUrl: string): Blob {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

/** The page of tab `id` into the open chat's message field. */
export async function sendPageToChat(id: string): Promise<void> {
  const page = browserPages.peek().find((item) => item.id === id);
  const chatId = activeConversationId.peek();
  if (!page?.url) return;
  if (!chatId) { pushToast({ title: 'Open a chat to send the page to', tone: 'info' }); return; }
  let attachment;
  try {
    const shot = await bridge!.workspaceBrowser!.capture(id);
    attachment = await uploadFile(jpeg(shot.dataUrl), `${hostOf(page.url) || 'page'}.jpg`, { conversationId: chatId });
  } catch { /* the address alone */ }
  const draft = draftFor(chatId).peek();
  updateDraft(chatId, { text: withLine(draft.text, page.url), attachments: attachment ? [...draft.attachments, attachment] : draft.attachments });
  focusComposer();
}

/** The draft's text with `line` added: alone, after trailing whitespace, else on a new line; the caret goes behind it. */
function withLine(text: string, line: string): string {
  return text ? `${text}${/\s$/.test(text) ? '' : '\n'}${line} ` : `${line} `;
}

/** The keyboard into the open chat's message field, behind its text. */
export function focusComposer(): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('.composer-input');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

/** A picture into the message field of chat `chatId`, with the page's address when it has one. */
export async function putIntoDraft(chatId: string, picture: Blob, name: string, address?: string): Promise<void> {
  const attachment = await uploadFile(picture, name, { conversationId: chatId });
  const draft = draftFor(chatId).peek();
  updateDraft(chatId, { text: address ? withLine(draft.text, address) : draft.text, attachments: [...draft.attachments, attachment] });
  focusComposer();
}
