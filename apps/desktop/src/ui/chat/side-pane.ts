// The chat's ways into its own area (ChatArea.tsx, the tabs above its messages; workspace/pages.ts opens the tab): the
// chat's notes (Chat details › Notes), an image or file in a message (a media tab) and a video (its video tab). Each
// opens the chat's tab and its area, on the desktop and the phone alike.
// Owns: these three calls. Never: tab logic (pages.ts) or what a tab shows.

import { chatSpace } from '../../shared/api/workspace-browser.ts';
import { setChatArea } from '../lib/shell-state.ts';
import { openMedia, openNotes, openVideo } from '../workspace/pages.ts';

/** The chat's shared notes in its area. */
export function showNotes(conversationId: string): void {
  openNotes(conversationId, chatSpace(conversationId));
  setChatArea(conversationId, true);
}

/** A stored file of a message (image, audio, document) in the chat's area. */
export function showMedia(conversationId: string, file: { fileId: string; name?: string }): void {
  openMedia({ fileId: file.fileId, ...(file.name ? { name: file.name } : {}) }, chatSpace(conversationId));
  setChatArea(conversationId, true);
}

/** A video file of a message in the chat's area, its video tab. */
export function showVideo(conversationId: string, file: { fileId: string }): void {
  openVideo({ conversationId, fileId: file.fileId }, chatSpace(conversationId));
  setChatArea(conversationId, true);
}
