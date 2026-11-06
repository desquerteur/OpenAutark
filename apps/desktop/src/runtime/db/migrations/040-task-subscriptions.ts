// Migration 40 (task center): agents' task event subscriptions and the pending task news they
// produced (shown in the agent's next turn, then deleted). News rows hold ids and states only –
// the task's title is read when the news is shown, never copied.
// Owns: the tables. Never: task or chat text.

export const sql = /* sql */ `
CREATE TABLE task_subscriptions (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, events TEXT NOT NULL,
  delivery TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_subscriptions_agent ON task_subscriptions(agent_id);

CREATE TABLE task_news (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, status TEXT, by TEXT, source TEXT NOT NULL, at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_news_agent ON task_news(agent_id, id);
CREATE INDEX task_news_task ON task_news(task_id);
`;
