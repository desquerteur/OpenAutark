// Migration 68 (B-041 My day): ONE migration for every track of the build.
// tasks: the estimate and where it came from, focus-timer time, when it can be done (window JSON), an agent's
// preparation (prep JSON) and "Only me" (private). task_routes: a split dictation (parts JSON array of task ids on
// the original, split_from on each part, split 'pending' | 'done' | 'none'). calendar_events: the members' local
// calendar and mirrored rows of connected sources – a task's block goes with its task (ON DELETE CASCADE) and has
// no title. calendar_sources: connected calendars with a vault id instead of an ICS address or a refresh token.
// task_estimates: learned minutes as counters under a hash of the short task key (no task text). day_briefings:
// the morning briefing per member and local date. `window` is quoted (an SQL keyword).
// Owns: this schema. Never: data rows, secrets, task text outside tasks, or edits of shipped migrations.

export const sql = /* sql */ `
ALTER TABLE tasks ADD COLUMN estimate_min INTEGER;
ALTER TABLE tasks ADD COLUMN estimate_source TEXT;
ALTER TABLE tasks ADD COLUMN spent_ms INTEGER;
ALTER TABLE tasks ADD COLUMN timer_started_at INTEGER;
ALTER TABLE tasks ADD COLUMN "window" TEXT;
ALTER TABLE tasks ADD COLUMN prep TEXT;
ALTER TABLE tasks ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_routes ADD COLUMN parts TEXT;
ALTER TABLE task_routes ADD COLUMN split_from TEXT;
ALTER TABLE task_routes ADD COLUMN split TEXT;
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT,
  notes TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  source_id TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  etag TEXT,
  set_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned',
  read_only INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX calendar_events_owner_start ON calendar_events(owner_id, start_at);
CREATE INDEX calendar_events_task ON calendar_events(task_id);
CREATE UNIQUE INDEX calendar_events_external ON calendar_events(source_id, external_id);
CREATE TABLE calendar_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  writable INTEGER NOT NULL DEFAULT 0,
  secret_id TEXT,
  write_calendar_id TEXT,
  sync_token TEXT,
  pc_device_id TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX calendar_sources_owner ON calendar_sources(owner_id);
CREATE TABLE task_estimates (
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  category TEXT,
  minutes INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  person_set INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key_hash)
) STRICT;
CREATE TABLE day_briefings (
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, date)
) STRICT;
`;
