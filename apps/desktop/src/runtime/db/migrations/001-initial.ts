// Initial schema. Mirrors src/shared/model/*. JSON columns hold nested plain data.
// Times are epoch milliseconds (INTEGER). Booleans are 0/1. Tables are STRICT.
// Rule: chat text lives only in `messages`; tasks/knowledge/runs reference it by id.

export const sql = /* sql */ `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;

CREATE TABLE spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, color TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, archived_at INTEGER
) STRICT;

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id), manager_id TEXT REFERENCES agents(id), team TEXT,
  instructions TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'general', skills TEXT NOT NULL DEFAULT '[]',
  model_policy TEXT NOT NULL DEFAULT '{}', permissions TEXT NOT NULL DEFAULT '{}', budget TEXT NOT NULL DEFAULT '{}',
  device_id TEXT, status TEXT NOT NULL DEFAULT 'idle', status_note TEXT, template TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
) STRICT;
CREATE INDEX agents_manager ON agents(manager_id);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, title_named INTEGER NOT NULL DEFAULT 0, space_id TEXT,
  created_by TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}',
  last_message_at INTEGER, last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
) STRICT;
CREATE INDEX conversations_recent ON conversations(archived_at, pinned, last_message_at);

CREATE TABLE members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  read_seq INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, left_at INTEGER,
  PRIMARY KEY (conversation_id, member_id)
) STRICT;
CREATE INDEX members_member ON members(member_id, left_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, author_id TEXT NOT NULL, author_kind TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'normal', reply_to TEXT, run_id TEXT, task_id TEXT,
  state TEXT NOT NULL DEFAULT 'final', silent INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}',
  client_id TEXT, created_at INTEGER NOT NULL, edited_at INTEGER,
  UNIQUE (conversation_id, seq)
) STRICT;
CREATE UNIQUE INDEX messages_client ON messages(conversation_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX messages_task ON messages(task_id) WHERE task_id IS NOT NULL;

-- Full-text index over normalized (German-folded) text; maintained by the message repository.
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE drafts (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT, parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  assignee_kind TEXT NOT NULL DEFAULT 'team', assignee_id TEXT, created_by TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, due_at INTEGER, depends_on TEXT NOT NULL DEFAULT '[]',
  goal TEXT, done_when TEXT, mode TEXT, widget TEXT, human_reason TEXT, waiting_on TEXT, result TEXT,
  ledger TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0, client_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
) STRICT;
CREATE INDEX tasks_board ON tasks(status, assignee_kind, due_at);
CREATE INDEX tasks_conversation ON tasks(conversation_id, parent_id);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE VIRTUAL TABLE tasks_fts USING fts5(task_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE schedules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, kind TEXT NOT NULL,
  title TEXT NOT NULL, spec TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', next_at INTEGER, last_at INTEGER,
  runs INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, lease TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX schedules_due ON schedules(active, next_at);

-- Durable agent wake queue (event wakes are due immediately; retries/backoff are due later).
CREATE TABLE wakes (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, reason TEXT NOT NULL,
  note TEXT, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX wakes_due ON wakes(claimed_at, due_at);
CREATE INDEX wakes_agent ON wakes(agent_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, trigger TEXT NOT NULL,
  engine TEXT, model TEXT, effort TEXT, account_id TEXT, device_id TEXT, status TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
  error TEXT, summary TEXT, route TEXT
) STRICT;
CREATE INDEX runs_agent ON runs(agent_id, started_at);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE run_items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, name TEXT, data TEXT NOT NULL, effect_status TEXT, idem_key TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX run_items_run ON run_items(run_id, seq);
CREATE UNIQUE INDEX run_items_idem ON run_items(idem_key) WHERE idem_key IS NOT NULL;

-- Native engine session per (agent, conversation, engine): resume instead of re-sending history.
CREATE TABLE engine_sessions (
  agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, engine TEXT NOT NULL, account_id TEXT,
  session_ref TEXT NOT NULL, cursor_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER, model TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id, engine)
) STRICT;

CREATE TABLE knowledge (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.7, pinned INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER, valid_to INTEGER, recorded_at INTEGER NOT NULL, expired_at INTEGER, supersedes TEXT,
  created_by TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  embedding BLOB, embedding_profile TEXT
) STRICT;
CREATE INDEX knowledge_scope ON knowledge(scope, scope_id, expired_at);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, auth TEXT NOT NULL, home TEXT, base_url TEXT,
  secret_id TEXT, state TEXT NOT NULL DEFAULT 'unknown', plan TEXT, email TEXT, limits TEXT, cooling_until INTEGER,
  priority INTEGER NOT NULL DEFAULT 0, rotation INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  detected INTEGER NOT NULL DEFAULT 0, device_id TEXT, created_at INTEGER NOT NULL, checked_at INTEGER
) STRICT;

CREATE TABLE models (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL,
  efforts TEXT NOT NULL DEFAULT '[]', default_effort TEXT, caps TEXT NOT NULL DEFAULT '{}', scores TEXT,
  tier TEXT NOT NULL DEFAULT 'strong', strengths TEXT NOT NULL DEFAULT '{}', accounts TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE model_outcomes (
  model_id TEXT NOT NULL, category TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, ms REAL NOT NULL DEFAULT 0, rating_sum REAL NOT NULL DEFAULT 0, ratings INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (model_id, category)
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, run_id TEXT, task_id TEXT, conversation_id TEXT, action TEXT NOT NULL,
  summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', risk TEXT NOT NULL, amount REAL, currency TEXT,
  reversible INTEGER NOT NULL DEFAULT 1, requires TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT, reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
) STRICT;
CREATE INDEX approvals_status ON approvals(status, created_at);

CREATE TABLE spend (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL,
  ref TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX spend_agent ON spend(agent_id, created_at);

CREATE TABLE secrets (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, cipher BLOB, hint TEXT, agents TEXT NOT NULL DEFAULT '[]',
  domains TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used_at INTEGER
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, fingerprint TEXT NOT NULL,
  public_key TEXT, addresses TEXT NOT NULL DEFAULT '[]', caps TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'offline',
  self INTEGER NOT NULL DEFAULT 0, paired_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER
) STRICT;

-- Access tokens for PWA/phone clients and peers (only the hash is stored).
CREATE TABLE tokens (
  id TEXT PRIMARY KEY, device_id TEXT, kind TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
  name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
) STRICT;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY, device_id TEXT, endpoint TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
  text_preview TEXT, width INTEGER, height INTEGER, duration_ms INTEGER, refs INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE feedback (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, screenshot_file_id TEXT,
  annotation_file_id TEXT, context TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, url TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER
) STRICT;

CREATE TABLE customizations (
  id TEXT PRIMARY KEY, request TEXT NOT NULL, requested_by TEXT NOT NULL, agent_id TEXT, task_id TEXT, status TEXT NOT NULL,
  version INTEGER, summary TEXT, created_at INTEGER NOT NULL, applied_at INTEGER
) STRICT;

-- Cached action sequences per app/site (computer & browser use replay with self-heal).
CREATE TABLE macros (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, intent TEXT NOT NULL, steps TEXT NOT NULL, successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX macros_target ON macros(target);
`;
