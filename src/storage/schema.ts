export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_spaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_space
ON conversations(memory_space_id, started_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  external_message_id TEXT,
  speaker_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_order
ON messages(conversation_id, message_index);
CREATE INDEX IF NOT EXISTS idx_messages_time
ON messages(memory_space_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
ON messages(memory_space_id, external_message_id)
WHERE external_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entities_name
ON entities(memory_space_id, name);
CREATE INDEX IF NOT EXISTS idx_entities_type
ON entities(memory_space_id, type);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_aliases_unique
ON entity_aliases(memory_space_id, alias);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
ON entity_aliases(entity_id);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_value TEXT,
  object_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from INTEGER,
  valid_until INTEGER,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (object_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_claims_subject
ON claims(memory_space_id, subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_claims_status
ON claims(memory_space_id, status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  occurred_at INTEGER,
  time_precision TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_time
ON events(memory_space_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type
ON events(memory_space_id, type);

CREATE TABLE IF NOT EXISTS event_participants (
  event_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (event_id, entity_id, role),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_event_participants_entity
ON event_participants(entity_id);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  extractor_version TEXT,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_unique
ON annotations(message_id, target_type, target_id, role);
CREATE INDEX IF NOT EXISTS idx_annotations_target
ON annotations(target_type, target_id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  content_snapshot TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_source
ON evidence(memory_space_id, source_type, source_id, evidence_type);
CREATE INDEX IF NOT EXISTS idx_evidence_source_id
ON evidence(source_type, source_id);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_type TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (memory_type, memory_id, evidence_id),
  FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory
ON memory_evidence(memory_type, memory_id);

CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_unique
ON memory_links(source_type, source_id, relation, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_source
ON memory_links(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target
ON memory_links(target_type, target_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  first_message_index INTEGER NOT NULL,
  last_message_index INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  participants TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_conversation
ON chunks(conversation_id, ordinal);

CREATE TABLE IF NOT EXISTS chunk_messages (
  chunk_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, message_id),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunk_messages_message
ON chunk_messages(message_id);

CREATE TABLE IF NOT EXISTS embedding_documents (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_type, source_id, model_name),
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_embedding_documents_space
ON embedding_documents(memory_space_id, source_type);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  memory_space_id TEXT NOT NULL,
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_jobs_status
ON jobs(status, run_after);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_documents USING fts5(
  document_key UNINDEXED,
  memory_space_id UNINDEXED,
  kind UNINDEXED,
  source_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`
