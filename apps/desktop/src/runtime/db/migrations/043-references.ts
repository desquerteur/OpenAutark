// Migration 43 (F-52): references of a person's words, reasons and corrections (runtime/references/*).
// The text and its versions live in `knowledge` (scope and kind 'reference', scope id = subject;
// bi-temporal: an edit supersedes, a revoke expires, a forget deletes the chain); these tables hold
// what knowledge rows cannot: the stable reference id and its metadata, the capture policy, the
// per-principal rights and the representation requests a correction can point at.
// reference_items: one row per reference; `knowledge_id` = its current version; `kind` example |
//   reason | goal | exception | style | correction; `origin` authored | explained | approved | inferred;
//   `status` active | proposed | revoked; `sphere` business | brand | private; `via` remember | agent |
//   auto | manual | import; `corrects` the reference a correction answers; `applies_to` JSON scope
//   {audience, situation, sphere}; `message_id`/`conversation_id` the source (a deleted message or chat
//   takes its references with it); `draft_id` the representation request a correction answers.
// reference_policies: one row per subject – capture `level` off | explicit | selected and the explicit
//   lists of chats, spaces and agents (JSON arrays; never a wildcard); `auto_capture` 1 = each own new
//   message in a selected source becomes an example.
// reference_grants: rights (JSON: capture, retrieve, draft, export, delete) and spheres per principal
//   ('agent:<id>'; 'member:<id>' later) on one subject's references.
// reference_drafts: representation requests (question, situation, audience, cited references and
//   corrections, uncertainty) – the draft text itself stays in its chat message.
// Never: secret values (texts are redacted by the knowledge store), vectors (they stay on the knowledge
// rows), or a row granting anything by default.

export const sql = /* sql */ `
CREATE TABLE reference_items (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  sphere TEXT NOT NULL,
  situation TEXT,
  audience TEXT,
  occurred_at INTEGER NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  draft_id TEXT,
  imported TEXT,
  via TEXT NOT NULL,
  captured_by TEXT NOT NULL,
  corrects TEXT,
  applies_to TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT
) STRICT;
CREATE UNIQUE INDEX reference_items_knowledge ON reference_items(knowledge_id);
CREATE INDEX reference_items_subject ON reference_items(subject, status, kind, occurred_at);
CREATE UNIQUE INDEX reference_items_message ON reference_items(subject, message_id, kind) WHERE message_id IS NOT NULL AND kind <> 'correction' AND status <> 'revoked';
CREATE INDEX reference_items_message_any ON reference_items(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX reference_items_chat ON reference_items(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX reference_items_corrects ON reference_items(corrects) WHERE corrects IS NOT NULL;

CREATE TABLE reference_policies (
  subject TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  chats TEXT NOT NULL DEFAULT '[]',
  spaces TEXT NOT NULL DEFAULT '[]',
  agents TEXT NOT NULL DEFAULT '[]',
  auto_capture INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE TABLE reference_grants (
  subject TEXT NOT NULL,
  principal TEXT NOT NULL,
  rights TEXT NOT NULL,
  spheres TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (subject, principal)
) STRICT;

CREATE TABLE reference_drafts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  asked_by TEXT NOT NULL,
  conversation_id TEXT,
  question TEXT NOT NULL,
  situation TEXT,
  audience TEXT,
  sphere TEXT NOT NULL,
  cited TEXT NOT NULL DEFAULT '[]',
  corrections TEXT NOT NULL DEFAULT '[]',
  uncertainty TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX reference_drafts_recent ON reference_drafts(subject, created_at);
`;
