-- Owns: private server-side feedback, delivery receipts, rate counts and encrypted app setup.
-- Never: grants a submitter SELECT access or stores provider tokens in client data.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received', url TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
