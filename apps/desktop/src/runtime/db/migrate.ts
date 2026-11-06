// Schema migrations: ordered, forward-only, each in its own transaction.
// An entry is SQL, or a `run(db)` step for one that must read the schema first (082 copies the indexes and
// triggers of the table it rebuilds). `foreignKeysOff` (B-054): a table rebuild runs with foreign keys OFF – the
// pragma is a no-op inside a transaction, so it is set before it – and must leave no new foreign_key_check row.
// Owns: the migration list, the `meta.schema` version and that runner flag. Never: data imports (see import-v7.ts).

import type { Db } from './database.ts';
import { sql as initial } from './migrations/001-initial.ts';
import { sql as media } from './migrations/002-media.ts';
import { sql as agentBasedOn } from './migrations/003-agent-based-on.ts';
import { sql as bridges } from './migrations/004-bridges.ts';
import { sql as sessionRenewal } from './migrations/005-session-renewal.ts';
import { sql as deviceConsent } from './migrations/006-device-consent.ts';
import { sql as agentVoice } from './migrations/007-agent-voice.ts';
import { sql as sessionPromptKey } from './migrations/008-session-prompt-key.ts';
import { sql as taskAssignedBy } from './migrations/009-task-assigned-by.ts';
import { sql as messageFiles } from './migrations/020-message-files.ts';
import { sql as runCost } from './migrations/024-run-cost.ts';
import { sql as bridgeOwner } from './migrations/028-bridge-owner.ts';
import { sql as accountEnvVar } from './migrations/029-account-env-var.ts';
import { sql as agentRevisions } from './migrations/030-agent-revisions.ts';
import { sql as mediaFacts } from './migrations/031-media-facts.ts';
import { sql as skillVersions } from './migrations/032-skill-versions.ts';
import { sql as secretGroups } from './migrations/033-secret-groups.ts';
import { sql as agentVariant } from './migrations/034-agent-variant.ts';
import { sql as secretDiscovery } from './migrations/035-secret-discovery.ts';
import { sql as taskRoutes } from './migrations/039-task-routes.ts';
import { sql as taskSubscriptions } from './migrations/040-task-subscriptions.ts';
import { sql as people } from './migrations/041-people.ts';
import { sql as agentPersonManager } from './migrations/042-agent-person-manager.ts';
import { sql as references } from './migrations/043-references.ts';
import { sql as teamPatterns } from './migrations/044-team-patterns-companions.ts';
import { sql as knowledgeSources } from './migrations/045-knowledge-sources.ts';
import { sql as sourceChunksLayout } from './migrations/046-source-chunks-layout.ts';
import { sql as knowledgeChecks } from './migrations/047-knowledge-checks.ts';
import { sql as secretAreas } from './migrations/048-secret-areas.ts';
import { sql as calls } from './migrations/049-calls.ts';
import { sql as mediaSegments } from './migrations/050-media-segments.ts';
import { sql as settingsCleanup } from './migrations/055-settings-cleanup.ts';
import { sql as skillLifecycle } from './migrations/061-skill-lifecycle-native-history.ts';
import { sql as knowledgeAudience } from './migrations/058-knowledge-audience.ts';
import { sql as peopleWork } from './migrations/059-people-work.ts';
import { sql as callUsageSegmentReview } from './migrations/060-call-usage-segment-review.ts';
import { sql as territories } from './migrations/065-territories.ts';
import { sql as chatNotes } from './migrations/067-chat-notes.ts';
import { sql as dayCalendar } from './migrations/068-day-calendar.ts';
import { sql as settingsCleanupB044 } from './migrations/069-settings-cleanup-b044.ts';
import { sql as telecodingRemoval } from './migrations/071-telecoding-removal.ts';
import { sql as opencodeRemoval } from './migrations/072-opencode-removal.ts';
import { sql as knowledgeLeftovers } from './migrations/073-knowledge-leftovers-b044.ts';
import { sql as secretAreasLeftovers } from './migrations/074-secret-areas-leftovers-b044.ts';
import { sql as settingsLeftovers } from './migrations/075-settings-leftovers-b044.ts';
import { sql as managerEffort } from './migrations/076-manager-effort-b047.ts';
import { sql as contextLedger } from './migrations/077-context-ledger.ts';
import { sql as chatVectors } from './migrations/078-chat-vectors.ts';
import { sql as secretSource } from './migrations/079-secret-source.ts';
import { sql as secretNoBinding } from './migrations/080-secret-no-binding.ts';
import { sql as secretCatalog } from './migrations/081-secret-catalog.ts';
import { run as tasksOwn } from './migrations/082-tasks-own.ts';
import { sql as agentSplits } from './migrations/084-agent-splits.ts';
import { sql as noPermissionGate } from './migrations/085-no-permission-gate.ts';
import { sql as knowledgePeopleSimple } from './migrations/086-knowledge-people-simple.ts';
import { sql as simpleLeftovers } from './migrations/087-simple-leftovers.ts';
import { sql as vectorChunks } from './migrations/088-vector-chunks.ts';
import { sql as contextItems } from './migrations/089-context-items.ts';
import { sql as memoryOldIds } from './migrations/090-memory-old-ids.ts';
import { sql as messagesStreaming } from './migrations/091-messages-streaming.ts';

/**
 * Versions are applied in list order: keep the list in ascending version order and never edit a
 * shipped entry. Only the highest applied version is recorded (`meta.schema`), and a listed version
 * at or below a profile's recorded one is never applied there – so a new migration always takes a
 * number above the highest one used so far (91 now), never a number in a gap. The gaps in the
 * numbering (e.g. 51–54, 56, 57, 62–64, 66, 70) were reserved by parallel packages and never used; they
 * stay unused. 83 was reserved by a parallel package (B-057 took 84 meanwhile): a later 83 would be skipped
 * on every profile already at 84, so that step takes a number above 84 instead.
 */
interface Migration {
  version: number;
  name: string;
  sql?: string;
  /** Runs after `sql`, in the same transaction. */
  run?: (db: Db) => void;
  /** Table rebuilds: foreign keys OFF around the transaction (else a DROP cascades), checked before COMMIT. */
  foreignKeysOff?: boolean;
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial', sql: initial },
  { version: 2, name: 'media', sql: media },
  { version: 3, name: 'agent-based-on', sql: agentBasedOn },
  { version: 4, name: 'bridges', sql: bridges },
  { version: 5, name: 'session-renewal', sql: sessionRenewal },
  { version: 6, name: 'device-consent', sql: deviceConsent },
  { version: 7, name: 'agent-voice', sql: agentVoice },
  { version: 8, name: 'session-prompt-key', sql: sessionPromptKey },
  { version: 9, name: 'task-assigned-by', sql: taskAssignedBy },
  { version: 20, name: 'message-files', sql: messageFiles },
  { version: 24, name: 'run-cost', sql: runCost },
  { version: 28, name: 'bridge-owner', sql: bridgeOwner },
  { version: 29, name: 'account-env-var', sql: accountEnvVar },
  { version: 30, name: 'agent-revisions', sql: agentRevisions },
  { version: 31, name: 'media-facts', sql: mediaFacts },
  { version: 32, name: 'skill-versions', sql: skillVersions },
  { version: 33, name: 'secret-groups', sql: secretGroups },
  { version: 34, name: 'agent-variant', sql: agentVariant },
  { version: 35, name: 'secret-discovery', sql: secretDiscovery },
  { version: 39, name: 'task-routes', sql: taskRoutes }, // task center: routing record per quick/submitted task
  { version: 40, name: 'task-subscriptions', sql: taskSubscriptions }, // task center: event subscriptions and pending task news
  { version: 41, name: 'people', sql: people }, // F-52: people of the organisation, their audit (tokens in `tokens`)
  { version: 42, name: 'agent-person-manager', sql: agentPersonManager }, // F-52: an agent reporting to a person
  { version: 43, name: 'references', sql: references }, // F-52: references, capture policy, rights, representation requests
  { version: 44, name: 'team-patterns-companions', sql: teamPatterns }, // F-51: saved/imported team patterns, companions (counter-role)
  { version: 45, name: 'knowledge-sources', sql: knowledgeSources }, // KS1: source corpus, areas, embedding jobs
  { version: 46, name: 'source-chunks-layout', sql: sourceChunksLayout }, // KS1 review: chunk set id, BLOB last, covering index, FTS secure-delete
  { version: 47, name: 'knowledge-checks', sql: knowledgeChecks }, // LIFECYCLE: check state of changeable knowledge (review policies; unused since B-044)
  { version: 48, name: 'secret-areas', sql: secretAreas }, // LIFECYCLE: described (also empty) secret areas, grant audit (unused since B-044)
  { version: 49, name: 'calls', sql: calls }, // live calls: one history row per call of a chat
  { version: 50, name: 'media-segments', sql: mediaSegments }, // media segments: regions/time spans + FTS, media text vectors
  { version: 55, name: 'settings-cleanup', sql: settingsCleanup }, // settings audit: one global cost mode, legacy feedback fields removed
  { version: 58, name: 'knowledge-audience', sql: knowledgeAudience }, // F-52: chat-scoped memory boundary (who may meet a note learned with people), shares
  { version: 59, name: 'people-work', sql: peopleWork }, // F-52 wave 2: a person's own settings, uploads into their chats
  { version: 60, name: 'call-usage-segment-review', sql: callUsageSegmentReview }, // wave 2: realtime voice usage per session, carried media segments (review mark)
  { version: 61, name: 'skill-lifecycle-native-history', sql: skillLifecycle }, // wave 2: skill origins/audience/loads, provider history deletions
  { version: 65, name: 'territories', sql: territories }, // wave 3 TERRITORY: work territories, their routes and focus (unused since B-044 – tables kept, nothing reads them)
  { version: 67, name: 'chat-notes', sql: chatNotes }, // wave 3: a chat's shared notes and their versions
  { version: 68, name: 'day-calendar', sql: dayCalendar }, // B-041 My day: task estimate/window/prep/private, route parts, calendar, sources, estimates, briefings (ONE migration for all tracks)
  { version: 69, name: 'settings-cleanup-b044', sql: settingsCleanupB044 }, // B-044: stored values of the removed settings go, a completed (or already sent) onboarding reads step 'done'
  { version: 71, name: 'telecoding-removal', sql: telecodingRemoval }, // B-044: TeleCoding's kv rows and connection devices go (70 stays unused: OpenCode became 72)
  { version: 72, name: 'opencode-removal', sql: opencodeRemoval }, // B-044: OpenCode's accounts, listings, catalog rows, sessions, 'opencode:' routing settings and model pins go
  { version: 73, name: 'knowledge-leftovers-b044', sql: knowledgeLeftovers }, // B-044: X04 wishes (kv), review check rows and marks, reference capture policies go (tables stay)
  { version: 74, name: 'secret-areas-leftovers-b044', sql: secretAreasLeftovers }, // B-044: stale 'branch:' access entries, secret area rows and the grant audit go (tables stay)
  { version: 75, name: 'settings-leftovers-b044', sql: settingsLeftovers }, // B-044: voice.markUncertain, a person's motion/density and the Models library's strength corrections go
  { version: 76, name: 'manager-effort-b047', sql: managerEffort }, // B-047 D12: the seeded Manager's fixed high effort goes (manager.md dropped it)
  { version: 77, name: 'context-ledger', sql: contextLedger }, // B-048 E1: the context ledger (context_items) – ids, marks, originals' retention
  { version: 78, name: 'chat-vectors', sql: chatVectors }, // B-048 E5: chat lines' and condensed/hidden ledger texts' vectors (knowledge/chat-vectors.ts)
  { version: 79, name: 'secret-source', sql: secretSource }, // 29.10.2026: secrets usable everywhere – a secret's/group's source site, agents' automatic bindings become it
  { version: 80, name: 'secret-no-binding', sql: secretNoBinding }, // owner correction 29.10.2026: no site restriction at all ('Only on' gone) – only card data keeps its binding
  { version: 81, name: 'secret-catalog', sql: secretCatalog }, // owner 29.10.2026: a catalog like a skill – route + tags, no binding at all (cards included)
  { version: 82, name: 'tasks-own', run: tasksOwn, foreignKeysOff: true }, // B-054: a task is its own row (chat optional), stand-in rows detached, wake/run origin
  { version: 84, name: 'agent-splits', sql: agentSplits }, // B-057: split groups and splits (an agent split into parallel workers), runs.split_id
  { version: 85, name: 'no-permission-gate', sql: noPermissionGate }, // Umbau Einfachheit: approvals, the gate's kv rows, permission settings and open approval to-dos go
  { version: 86, name: 'knowledge-people-simple', sql: knowledgePeopleSimple }, // Umbau Einfachheit: tables and kv of the removed knowledge/people/reference/source/recipe/privacy/worktree machinery go
  { version: 87, name: 'simple-leftovers', sql: simpleLeftovers }, // Umbau Einfachheit: tables and kv the removed ledger, task center, companions, skill history, calls, media segments and overlay left behind go
  { version: 88, name: 'vector-chunks', sql: vectorChunks }, // the vector system's files and chunks (runtime/vectors)
  { version: 89, name: 'context-items', sql: contextItems }, // the context ledger, back after 087 (context/ledger)
  { version: 90, name: 'memory-old-ids', sql: memoryOldIds }, // the old-id map of a state before 0.2.9 into one meta row per id (knowledge/memory-migrate.ts)
  { version: 91, name: 'messages-streaming', sql: messagesStreaming }, // B-075: the rows of runs at work by chat (chat/message-repo.ts liveRows)
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** `until` (tests): stop after that version, to build the schema an older app left behind. */
export function migrate(db: Db, options: { until?: number } = {}): { from: number; to: number } {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`);
  const from = row ? Number(row.value) : 0;
  if (from > SCHEMA_VERSION) {
    throw new Error(`Database schema ${from} is newer than this app (${SCHEMA_VERSION}). Update the app.`);
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    if (options.until !== undefined && migration.version > options.until) break;
    if (migration.foreignKeysOff) withForeignKeysOff(db, () => apply(db, migration));
    else apply(db, migration);
  }
  return { from, to: SCHEMA_VERSION };
}

function apply(db: Db, migration: Migration): void {
  db.tx(() => {
    // The initial migration recreates meta; drop the bootstrap table first.
    if (migration.version === 1) db.exec('DROP TABLE IF EXISTS meta;');
    // A rebuild must not add a dangling reference; ones the profile already had (checked before) do not block it.
    const known = migration.foreignKeysOff ? new Set(violations(db)) : undefined;
    if (migration.sql) db.exec(migration.sql);
    migration.run?.(db);
    if (known) {
      const added = violations(db).filter((row) => !known.has(row));
      if (added.length) throw new Error(`Migration ${migration.version} left ${added.length} broken references (first: ${added[0]}).`);
    }
    db.run(`INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(migration.version)]);
  });
}

/** `PRAGMA foreign_keys` only takes effect outside a transaction: OFF before it, back ON in any case. */
function withForeignKeysOff(db: Db, fn: () => void): void {
  const wasOn = Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys ?? 0) === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  try { fn(); } finally { if (wasOn) db.exec('PRAGMA foreign_keys = ON'); }
}

/** foreign_key_check rows as stable keys (table, rowid, parent, constraint). */
function violations(db: Db): string[] {
  return db.all<{ table: string; rowid: number | null; parent: string; fkid: number }>('PRAGMA foreign_key_check')
    .map((row) => `${row.table}#${row.rowid ?? ''}->${row.parent}/${row.fkid}`);
}
