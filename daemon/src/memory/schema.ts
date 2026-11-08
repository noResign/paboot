/**
 * `memory.db` schema. Independent from the main database: no cross-database
 * foreign keys, only id references (see docs/local/paboot_memory/data-model.md).
 * The full M0 schema is created up front so M1/M2 can add behavior without a
 * destructive migration.
 */
export const MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS mem_sources (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  workspace_id  TEXT,
  end_id        TEXT,
  kind          TEXT NOT NULL,
  source_table  TEXT,
  session_id    TEXT,
  run_id        TEXT,
  message_id    INTEGER,
  occurred_at   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  sensitivity   TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_sources_key
  ON mem_sources(scope, COALESCE(end_id, ''), COALESCE(session_id, ''), COALESCE(source_table, ''),
                 COALESCE(CAST(message_id AS TEXT), content_hash));
CREATE INDEX IF NOT EXISTS ix_mem_sources_scope_status
  ON mem_sources(scope, end_id, status, occurred_at);

CREATE TABLE IF NOT EXISTS mem_observations (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL,
  end_id              TEXT,
  session_id          TEXT,
  run_id              TEXT,
  source_id           TEXT,
  kind                TEXT NOT NULL,
  type                TEXT NOT NULL,
  title               TEXT NOT NULL,
  subtitle            TEXT,
  facts_json          TEXT NOT NULL DEFAULT '[]',
  narrative           TEXT,
  concepts_json       TEXT NOT NULL DEFAULT '[]',
  files_read_json     TEXT NOT NULL DEFAULT '[]',
  files_modified_json TEXT NOT NULL DEFAULT '[]',
  evidence_json       TEXT NOT NULL DEFAULT '[]',
  content_hash        TEXT NOT NULL,
  sensitivity         TEXT NOT NULL DEFAULT 'normal',
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mem_observations_scope
  ON mem_observations(scope, end_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mem_observations_type
  ON mem_observations(scope, type, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mem_observations_hash
  ON mem_observations(scope, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_observations_key
  ON mem_observations(scope, COALESCE(source_id, ''), content_hash);

CREATE TABLE IF NOT EXISTS mem_session_summaries (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  end_id            TEXT,
  session_id        TEXT NOT NULL,
  run_id            TEXT,
  request           TEXT NOT NULL DEFAULT '',
  investigated      TEXT NOT NULL DEFAULT '',
  learned           TEXT NOT NULL DEFAULT '',
  completed         TEXT NOT NULL DEFAULT '',
  next_steps        TEXT NOT NULL DEFAULT '',
  notes             TEXT,
  files_read_json   TEXT NOT NULL DEFAULT '[]',
  files_edited_json TEXT NOT NULL DEFAULT '[]',
  sensitivity       TEXT NOT NULL DEFAULT 'normal',
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mem_session_summaries_scope
  ON mem_session_summaries(scope, end_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mem_session_summaries_session
  ON mem_session_summaries(session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_session_summaries_run
  ON mem_session_summaries(session_id, run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mem_entities (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  aliases_json    TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  importance      REAL NOT NULL DEFAULT 0.5,
  sensitivity     TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'active',
  merged_into     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_entities_name
  ON mem_entities(scope, kind, canonical_name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS mem_entity_links (
  entity_a   TEXT NOT NULL,
  entity_b   TEXT NOT NULL,
  relation   TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_a, entity_b),
  CHECK (entity_a < entity_b)
);

CREATE TABLE IF NOT EXISTS mem_claims (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  end_id           TEXT,
  entity_id        TEXT,
  predicate        TEXT NOT NULL,
  object_text      TEXT,
  object_entity_id TEXT,
  kind             TEXT NOT NULL,
  summary          TEXT NOT NULL,
  authority        TEXT NOT NULL DEFAULT 'derived'
                   CHECK (authority IN ('derived', 'user_confirmed')),
  share_class      TEXT
                   CHECK (
                     (scope = 'user' AND share_class IN ('portable', 'personal', 'life_only'))
                     OR (scope <> 'user' AND share_class IS NULL)
                   ),
  promoted_from    TEXT,
  valid_from       INTEGER,
  valid_to         INTEGER,
  time_precision   TEXT NOT NULL DEFAULT 'day',
  confidence       REAL NOT NULL,
  importance       REAL NOT NULL,
  reinforcement_dates TEXT NOT NULL DEFAULT '[]',
  dedup_key        TEXT,
  sensitivity      TEXT NOT NULL DEFAULT 'normal',
  status           TEXT NOT NULL DEFAULT 'active',
  superseded_by    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mem_claims_entity ON mem_claims(entity_id, status);
CREATE INDEX IF NOT EXISTS ix_mem_claims_scope
  ON mem_claims(scope, end_id, status, updated_at);
CREATE INDEX IF NOT EXISTS ix_mem_claims_dedup
  ON mem_claims(scope, COALESCE(end_id, ''), dedup_key, status);

CREATE TABLE IF NOT EXISTS mem_claim_evidence (
  claim_id  TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation  TEXT NOT NULL,
  quote     TEXT,
  PRIMARY KEY (claim_id, source_id, relation)
);

CREATE TABLE IF NOT EXISTS mem_claim_duplicates (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  duplicate_of TEXT NOT NULL,
  scope        TEXT NOT NULL,
  method       TEXT NOT NULL,
  score        REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  UNIQUE (claim_id, duplicate_of)
);
CREATE INDEX IF NOT EXISTS ix_mem_claim_duplicates_target
  ON mem_claim_duplicates(duplicate_of, status);

CREATE TABLE IF NOT EXISTS mem_episodes (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  end_id        TEXT,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  occurred_from INTEGER NOT NULL,
  occurred_to   INTEGER,
  place         TEXT,
  emotion       TEXT,
  importance    REAL NOT NULL,
  sensitivity   TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mem_episodes_scope ON mem_episodes(scope, end_id, occurred_from DESC);

CREATE TABLE IF NOT EXISTS mem_episode_entities (
  episode_id TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity_id)
);

CREATE TABLE IF NOT EXISTS mem_loops (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  end_id      TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  due_at      INTEGER,
  remind_json TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  source_id   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mem_loops_scope ON mem_loops(scope, end_id, status, due_at);

CREATE TABLE IF NOT EXISTS mem_narratives (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  period          TEXT NOT NULL,
  summary_md      TEXT NOT NULL,
  highlights_json TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  UNIQUE(scope, period)
);

CREATE TABLE IF NOT EXISTS mem_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  note        TEXT,
  session_id  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_tombstones (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  end_id       TEXT,
  content_hash TEXT NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mem_tombstones_key
  ON mem_tombstones(scope, COALESCE(end_id, ''), content_hash);

CREATE TABLE IF NOT EXISTS mem_ops (
  id           TEXT PRIMARY KEY,
  batch_key    TEXT NOT NULL,
  op           TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_mutes (
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  until       INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS mem_documents (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  end_id         TEXT,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  tags_json      TEXT NOT NULL DEFAULT '[]',
  path           TEXT NOT NULL,
  origin         TEXT NOT NULL,
  authority      TEXT NOT NULL DEFAULT 'derived'
                 CHECK (authority IN ('curated', 'derived')),
  weight         REAL NOT NULL DEFAULT 1.0,
  review_status  TEXT NOT NULL DEFAULT 'pending'
                 CHECK (review_status IN ('pending', 'confirmed', 'rejected', 'missing')),
  extractable    INTEGER NOT NULL DEFAULT 0,
  sensitivity    TEXT NOT NULL DEFAULT 'normal',
  content_hash   TEXT NOT NULL,
  last_edited_by TEXT NOT NULL DEFAULT 'user',
  updated_at     INTEGER NOT NULL,
  CHECK (authority <> 'curated' OR review_status = 'confirmed')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_documents_path
  ON mem_documents(scope, path);

CREATE TABLE IF NOT EXISTS mem_document_links (
  document_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  PRIMARY KEY (document_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS mem_document_chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  chunk_no     INTEGER NOT NULL,
  text         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(document_id, chunk_no)
);
CREATE INDEX IF NOT EXISTS ix_mem_document_chunks_doc
  ON mem_document_chunks(document_id, chunk_no);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_search USING fts5(
  scope UNINDEXED,
  end_id UNINDEXED,
  kind UNINDEXED,
  ref_id UNINDEXED,
  document_id UNINDEXED,
  chunk_no,
  authority UNINDEXED,
  text,
  tokenize = 'trigram'
);
`;
