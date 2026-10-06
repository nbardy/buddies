-- The Buddies store schema as main fda9fa3 leaves a file after open (2026-10-06), the shape of
-- the live ~/.buddies/buddies-v3.sqlite before the delivery rebuild. Frozen from that commit's
-- schema.rs (DDL, run_table!, THREAD_FOLLOW, thread_read, the on-open index lists and the post
-- search index); never edit it to match newer code: it is the migration's input.
CREATE TABLE workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  legacy TEXT) STRICT;

CREATE TABLE buddy (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
  slug TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  manager_id TEXT REFERENCES buddy(id),
  provider TEXT, model TEXT, reasoning_effort TEXT, soul_path TEXT,
  max_active_runs INTEGER NOT NULL DEFAULT 5 CHECK(max_active_runs > 0),
  created_at TEXT NOT NULL, legacy TEXT,
  UNIQUE(workspace_id, slug)) STRICT;
CREATE INDEX buddy_manager ON buddy(manager_id) WHERE manager_id IS NOT NULL;

CREATE TABLE task (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
  owner_id TEXT NOT NULL REFERENCES buddy(id), parent_id TEXT REFERENCES task(id),
  title TEXT NOT NULL, done_criteria TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','review','done','cancelled')),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), epoch INTEGER NOT NULL DEFAULT 1,
  next_action TEXT, blocked_reason TEXT, evidence TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, legacy TEXT,
  pin INTEGER NOT NULL DEFAULT 0 CHECK(pin >= 0)) STRICT;
CREATE INDEX task_owner ON task(owner_id, updated_at);
CREATE INDEX task_workspace ON task(workspace_id, updated_at);
CREATE INDEX task_parent ON task(parent_id, position) WHERE parent_id IS NOT NULL;

CREATE TABLE channel (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK(kind IN ('public','direct','task')),
  name TEXT COLLATE NOCASE, purpose TEXT, member_key TEXT UNIQUE, task_id TEXT UNIQUE REFERENCES task(id),
  created_by TEXT REFERENCES buddy(id), created_at TEXT NOT NULL, archived_at TEXT,
  CHECK((kind = 'public') = (name IS NOT NULL AND purpose IS NOT NULL)),
  CHECK((kind = 'direct') = (member_key IS NOT NULL)),
  CHECK((kind = 'task') = (task_id IS NOT NULL)),
  UNIQUE(workspace_id, name)) STRICT;
CREATE TABLE channel_member (
  channel_id TEXT NOT NULL REFERENCES channel(id), member TEXT NOT NULL,
  PRIMARY KEY(channel_id, member)) STRICT, WITHOUT ROWID;
CREATE INDEX channel_member_by_member ON channel_member(member, channel_id);

CREATE TABLE post (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channel(id),
  author_id TEXT REFERENCES buddy(id),
  root_id TEXT REFERENCES post(id), reply_to_id TEXT REFERENCES post(id),
  task_id TEXT REFERENCES task(id),
  purpose TEXT, body TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]',
  request TEXT CHECK(request IN ('awaiting','answered','cancelled','failed')),
  answer_id TEXT REFERENCES post(id),
  conversation_id TEXT, return_conversation_id TEXT, created_at TEXT NOT NULL, legacy TEXT,
  ord TEXT NOT NULL UNIQUE, broadcast INTEGER NOT NULL DEFAULT 0 CHECK(broadcast IN (0,1)),
  CHECK((request IS 'answered') = (answer_id IS NOT NULL))) STRICT;
CREATE INDEX post_channel ON post(channel_id, ord);
CREATE INDEX post_root ON post(root_id, ord) WHERE root_id IS NOT NULL;
CREATE INDEX post_awaiting ON post(channel_id, created_at) WHERE request = 'awaiting';
CREATE INDEX post_awaiting_author ON post(author_id, created_at) WHERE request = 'awaiting';

CREATE TABLE post_read (
  reader TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channel(id),
  last_post_id TEXT NOT NULL, last_post_at TEXT NOT NULL, last_ord TEXT NOT NULL,
  updated_at TEXT NOT NULL, legacy TEXT,
  PRIMARY KEY(reader, channel_id)) STRICT;

CREATE TABLE doc (
  id TEXT PRIMARY KEY, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('buddy','workspace')), scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('soul','working','long_term','shared')), name TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL CHECK(revision > 0), content TEXT NOT NULL, updated_at TEXT NOT NULL, legacy TEXT,
  UNIQUE(buddy_id, scope_kind, scope_id, kind, name)) STRICT;
CREATE TABLE doc_revision (
  doc_id TEXT NOT NULL REFERENCES doc(id), revision INTEGER NOT NULL, content TEXT NOT NULL,
  reason TEXT NOT NULL, author TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '{}',
  sha256 TEXT NOT NULL, created_at TEXT NOT NULL, legacy TEXT,
  PRIMARY KEY(doc_id, revision)) STRICT;

CREATE TABLE schedule (
  id TEXT PRIMARY KEY, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  task_id TEXT REFERENCES task(id), name TEXT NOT NULL,
  cron TEXT NOT NULL, timezone TEXT NOT NULL, prompt TEXT NOT NULL, limits TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run_at TEXT, archived_at TEXT,
  created_at TEXT NOT NULL, legacy TEXT) STRICT;
CREATE INDEX schedule_due ON schedule(next_run_at) WHERE enabled = 1 AND archived_at IS NULL;
CREATE INDEX schedule_buddy ON schedule(buddy_id);
CREATE TABLE run (
  id TEXT PRIMARY KEY, input_key TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  input_kind TEXT NOT NULL CHECK(input_kind IN ('chat','post','reply','schedule','failure_notice','follow')),
  input_id TEXT NOT NULL, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  conversation_id TEXT, task_id TEXT, task_epoch INTEGER, after_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','complete','failed','cancelled')),
  lease_token TEXT, lease_expires_at TEXT, deadline TEXT,
  snapshot TEXT, outcome TEXT, error_code TEXT, error TEXT,
  ready_at TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, legacy TEXT,
  config TEXT,
  UNIQUE(input_key, attempt)) STRICT;
CREATE UNIQUE INDEX run_live_input ON run(input_key) WHERE status IN ('queued','running','cancel_requested');
CREATE UNIQUE INDEX run_conversation_slot ON run(conversation_id)
  WHERE conversation_id IS NOT NULL AND status IN ('running','cancel_requested');
CREATE INDEX run_queue ON run(ready_at, id) WHERE status = 'queued';
CREATE INDEX run_lease ON run(lease_expires_at) WHERE status IN ('running','cancel_requested');
CREATE INDEX run_active_buddy ON run(buddy_id) WHERE status IN ('running','cancel_requested');
CREATE INDEX run_buddy ON run(buddy_id, status, created_at);
CREATE INDEX run_conversation ON run(conversation_id, created_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX run_task ON run(task_id, status) WHERE task_id IS NOT NULL;
CREATE INDEX run_follow_queued ON run(input_id) WHERE input_kind = 'follow' AND status = 'queued';
CREATE TABLE conversation (
  id TEXT PRIMARY KEY, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  task_id TEXT, created_at TEXT NOT NULL, legacy TEXT) STRICT;
CREATE INDEX conversation_buddy ON conversation(buddy_id, created_at);

CREATE TABLE event (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, workspace_id TEXT NOT NULL,
  buddy_id TEXT, task_id TEXT, op TEXT NOT NULL, payload TEXT NOT NULL,
  idem_key TEXT, payload_hash TEXT, result_ref TEXT, legacy TEXT,
  UNIQUE(actor, workspace_id, idem_key)) STRICT;
CREATE INDEX event_at ON event(at);
CREATE INDEX event_buddy ON event(buddy_id, seq) WHERE buddy_id IS NOT NULL;
CREATE TABLE thread_read (
  reader TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES post(id),
  last_ord TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(reader, root_id)) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS thread_follow (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES post(id), buddy_id TEXT NOT NULL REFERENCES buddy(id),
  conversation_id TEXT NOT NULL, through_ord TEXT NOT NULL, until TEXT NOT NULL, delivered_through TEXT,
  created_at TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS thread_follow_root ON thread_follow(root_id, conversation_id);
CREATE INDEX IF NOT EXISTS post_reply_to ON post(reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_answer ON post(answer_id) WHERE answer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_task ON post(task_id, ord) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thread_read_root ON thread_read(root_id);
CREATE INDEX IF NOT EXISTS task_live ON task(workspace_id, owner_id, status)
  WHERE parent_id IS NULL AND status IN ('open','in_progress','blocked','review');
CREATE INDEX IF NOT EXISTS schedule_task ON schedule(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedule_workspace ON schedule(workspace_id);
CREATE INDEX IF NOT EXISTS run_workspace_live ON run(workspace_id, status, created_at)
  WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX IF NOT EXISTS run_workspace_ended ON run(workspace_id, ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_active_buddy ON run(buddy_id) WHERE status IN ('running','cancel_requested');
CREATE INDEX IF NOT EXISTS run_follow_queued ON run(input_id) WHERE input_kind = 'follow' AND status = 'queued';
CREATE VIRTUAL TABLE post_search USING fts5(body, content='post', content_rowid='rowid', tokenize='porter unicode61');
CREATE VIRTUAL TABLE post_search_vocab USING fts5vocab(post_search, 'row');
CREATE TRIGGER post_search_insert AFTER INSERT ON post BEGIN
  INSERT INTO post_search(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER post_search_delete AFTER DELETE ON post BEGIN
  INSERT INTO post_search(post_search, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER post_search_update AFTER UPDATE OF body ON post BEGIN
  INSERT INTO post_search(post_search, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO post_search(rowid, body) VALUES (new.rowid, new.body);
END;
INSERT INTO post_search(post_search) VALUES ('rebuild');
