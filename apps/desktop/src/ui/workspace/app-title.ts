// What an app tab of the pane shows, in words (the strip and the tab list): the chat's title for Notes and
// Video, the file's name for Media (the word itself for the library), "This PC" for Screen, the agent's name for its browser, the word itself
// for My day, Work and Activity, the last part of the path for a file or folder.
// Owns: that naming. Never: loads anything.

import { agentName, conversationMap } from '../lib/store.ts';
import { APP_KIND_LABEL, type AppEntry } from './browser-model.ts';

export function appTitle(entry: AppEntry): string {
  if (entry.kind === 'day' || entry.kind === 'work' || entry.kind === 'activity') return APP_KIND_LABEL[entry.kind];
  if (entry.kind === 'agent') return `${agentName(entry.agentId)}'s browser`;
  if (entry.kind === 'notes' || entry.kind === 'video') return conversationMap.value.get(entry.conversationId)?.title || 'Chat';
  if (entry.kind === 'media') return entry.name || entry.path?.split(/[\\/]/).pop() || (entry.fileId ? 'File' : APP_KIND_LABEL.media);
  if (entry.kind === 'file' || entry.kind === 'folder') return entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path;
  if (entry.kind === 'page') return entry.name;
  return 'This PC';
}
