// B-053 track D: the fixed tool list of a mail connection – what listTools() returns – with honest annotations
// (reading is readOnly; send/reply reach people; delete is destructive). Schemas are small and strict.
// Owns: names, schemas, annotations. Never: behaviour (actions.ts).

import type { McpToolDef } from '../types.ts';

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const addresses = (description: string) => ({
  description,
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 100 }],
});
const ID = str('A message id from search (folder/uidvalidity/uid).');

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const MAIL_TOOLS: McpToolDef[] = [
  {
    name: 'search', title: 'Search mail',
    description: 'Finds messages in a folder (default INBOX), newest first. All filters are optional and combine; without any, the newest messages. Returns ids for read, reply, move, mark and delete.',
    inputSchema: object({
      query: str('Words anywhere in the message (Gmail search syntax works on Gmail).'),
      from: str('Sender address or name contains.'), to: str('Recipient contains.'), subject: str('Subject contains.'),
      unread: { type: 'boolean', description: 'true: only unread; false: only read.' },
      flagged: { type: 'boolean', description: 'true: only flagged (starred).' },
      since: str('On or after this date (YYYY-MM-DD).'), before: str('Before this date (YYYY-MM-DD).'),
      folder: str('Folder name or "sent", "drafts", "trash", "spam", "archive" (default INBOX).'),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many (default 20, at most 50).' },
    }),
    annotations: { title: 'Search mail', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'read', title: 'Read a message',
    description: 'The full text of one message (up to 50 KB; HTML mail as plain text) with its headers and the list of attachments (name, type, size).',
    inputSchema: object({ id: ID }, ['id']),
    annotations: { title: 'Read a message', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'folders', title: 'List folders',
    description: 'The mailbox folders with their role (inbox, sent, drafts, trash, junk, archive).',
    inputSchema: object({}),
    annotations: { title: 'List folders', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'draft', title: 'Save a draft',
    description: 'Saves a message in Drafts without sending it. replyTo (a message id) makes it a reply in that thread.',
    inputSchema: object({ to: addresses('Recipient address(es).'), cc: addresses('Copy to.'), subject: str('Subject.'), text: str('Plain text body.'), replyTo: ID }, ['to', 'subject', 'text']),
    annotations: { title: 'Save a draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'send', title: 'Send a message',
    description: 'Sends a new message from this mailbox and keeps a copy in Sent. replyTo (a message id) threads it as a reply.',
    inputSchema: object({ to: addresses('Recipient address(es).'), cc: addresses('Copy to.'), bcc: addresses('Blind copy to.'), subject: str('Subject.'), text: str('Plain text body.'), replyTo: ID }, ['to', 'subject', 'text']),
    annotations: { title: 'Send a message', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'reply', title: 'Reply to a message',
    description: 'Sends a reply to a message (to its sender, or with all: true to everyone on it), quoting the original, in the same thread.',
    inputSchema: object({ id: ID, text: str('My reply (plain text).'), all: { type: 'boolean', description: 'Reply to all recipients.' } }, ['id', 'text']),
    annotations: { title: 'Reply to a message', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'move', title: 'Move a message',
    description: 'Moves a message to another folder (a name, or "archive", "spam", "inbox" …). Returns its new id.',
    inputSchema: object({ id: ID, folder: str('Target folder.') }, ['id', 'folder']),
    annotations: { title: 'Move a message', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'mark', title: 'Mark a message',
    description: 'Marks a message read or unread, flagged or not.',
    inputSchema: object({ id: ID, read: { type: 'boolean' }, flagged: { type: 'boolean' } }, ['id']),
    annotations: { title: 'Mark a message', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_folder', title: 'Create a folder',
    description: 'Creates a folder ("Projects" or "Projects/Client A" for one inside another).',
    inputSchema: object({ name: str('Folder name.') }, ['name']),
    annotations: { title: 'Create a folder', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'delete', title: 'Delete a message',
    description: 'Moves a message to Trash. A message already in Trash is deleted for good.',
    inputSchema: object({ id: ID }, ['id']),
    annotations: { title: 'Delete a message', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

