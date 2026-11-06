// The text of <data>/chats/README.md (B-050 K8): what the chat folders are, that the database stays
// the original, the file format and how chats come back in (wf import / chats.import).
// Owns: that text. Never: names a token, a path outside the data folder or a chat's content.

import { CHAT_FORMAT, CHAT_FORMAT_VERSION } from './format.ts';

export const CHATS_README = [
  '# Chats',
  '',
  'A readable copy of your chats, one folder per chat. The app writes it from its database (workforce.db),',
  'which stays the original: editing or deleting files here changes no chat. An edit is lost when the app',
  'next writes that file; a deleted chat folder comes back with the chat\'s next message or at the next start,',
  'a deleted month file with the next message of that month. To change chats, use the app or import below.',
  'Reading and copying them is safe. The chats of people of your organisation that you have not joined and',
  'the app\'s own chats (the to-do anchor and similar) are left out.',
  '',
  '## Layout',
  '',
  '- `<title>-<id8>/` – a chat; the folder follows the chat\'s title, the last 8 characters of its id stay.',
  `- \`<title>-<id8>/chat.json\` – format "${CHAT_FORMAT}" version ${CHAT_FORMAT_VERSION}: id, title, members (id, kind, name, role, joinedAt, leftAt), settings, origin.`,
  '- `<title>-<id8>/messages/YYYY-MM.jsonl` – one JSON object per line and finished message of that month (UTC):',
  '  id, seq, author {id, kind, name}, kind, level (normal, important or silent), body, attachments (file ids',
  '  are sha256 hashes), mentions, replyTo, taskId, state (failed or stopped; absent when final),',
  '  meta (model, modelHint, status, imported, importNote), createdAt and editedAt in milliseconds since 1970.',
  '  The notes that tell agents about an edit or a delete are left out, as in the app.',
  '',
  '## Taking chats to another PC',
  '',
  '`wf export <chat…>` (or Export in a chat’s menu) writes chat folders with their files to a folder; on the other PC the AI',
  'reads them like any folder. This folder has no files: attachments stay references until an export brings them.',
  '',
  '## Merging folders',
  '',
  'Two folders of one chat (the same id in chat.json, say from two PCs) merge into one by these rules. Message ids are unique:',
  'keep each line once, the later editedAt winning. Order by createdAt, put each line in the file of its UTC month, and number',
  'seq anew from 1, since each PC counted its own. Members join by id, with the earliest joinedAt and the latest leftAt.',
  'An export\'s files/ folders join by name, as the names are the content\'s sha256. Take chat.json\'s other fields from the newer folder.',
  'The result reads like any chat folder; write it outside chats/, which the app keeps writing from its database.',
  '',
].join('\n');
