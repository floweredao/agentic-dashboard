/** Pre-migration DDL from v0.4.0, deliberately independent of the new schema builder. */
export const LEGACY_CORE = `
CREATE TABLE principals(id TEXT PRIMARY KEY, source TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 created_at TEXT, revoked_at TEXT, last_used_at TEXT);
CREATE TABLE sessions(hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), created_by TEXT NOT NULL REFERENCES principals(id),
 project_id TEXT REFERENCES records(id), task_id TEXT REFERENCES records(id));
CREATE TABLE evidence(task_id TEXT NOT NULL REFERENCES records(id), record_id TEXT NOT NULL REFERENCES records(id), PRIMARY KEY(task_id,record_id));
CREATE TABLE requests(principal_id TEXT NOT NULL REFERENCES principals(id), request_id TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
 PRIMARY KEY(principal_id,request_id));
CREATE TABLE trash(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), created_by TEXT NOT NULL REFERENCES principals(id), deleted_at TEXT NOT NULL);
CREATE TABLE comments(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, author TEXT NOT NULL REFERENCES principals(id),
 source TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT REFERENCES comments(id), status TEXT, created_at TEXT NOT NULL,
 seen_at TEXT, seen_by TEXT, done_at TEXT, done_by TEXT, request_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(author,request_id));
CREATE INDEX records_project ON records(project_id);
CREATE INDEX records_task ON records(task_id);
CREATE INDEX comments_record ON comments(record_id,created_at);
`;
export const LEGACY_EXTRA = `
CREATE TABLE documents(record_id TEXT PRIMARY KEY, html TEXT NOT NULL, bytes INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE agent_invites(code_hash TEXT PRIMARY KEY, agent TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE digests(id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL, scheduled_at TEXT NOT NULL,
 sections TEXT NOT NULL CHECK(json_valid(sections)), created_by TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, version INTEGER NOT NULL, articles_read_at TEXT, messages_read_at TEXT, UNIQUE(date,slot));
CREATE TABLE digest_reactions(digest_id TEXT NOT NULL REFERENCES digests(id), section TEXT NOT NULL, article_key TEXT NOT NULL,
 reaction TEXT NOT NULL CHECK(reaction IN ('like','dislike','seen')), title TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL,
 updated_at TEXT NOT NULL, PRIMARY KEY(digest_id,section,article_key));
CREATE TABLE narrations(record_id TEXT PRIMARY KEY, status TEXT NOT NULL, job_hash TEXT NOT NULL, requested_by TEXT NOT NULL,
 requested_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
 progress_done INTEGER, progress_total INTEGER, script TEXT, script_hash TEXT, audio_file TEXT, audio_hash TEXT, audio_mime TEXT,
 audio_bytes INTEGER, audio_ms INTEGER, audio_model TEXT, audio_voice TEXT, audio_at TEXT);
ALTER TABLE narrations ADD COLUMN style TEXT NOT NULL DEFAULT 'read';
ALTER TABLE narrations ADD COLUMN script_style TEXT NOT NULL DEFAULT 'read';
ALTER TABLE narrations ADD COLUMN audio_style TEXT NOT NULL DEFAULT 'read';
ALTER TABLE narrations ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
ALTER TABLE narrations ADD COLUMN audio_scope TEXT NOT NULL DEFAULT 'full';
CREATE TABLE narration_runs(record_id TEXT NOT NULL, started_at TEXT NOT NULL);
CREATE TABLE narration_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL);
CREATE TABLE narration_auto(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL);
CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
 kinds TEXT NOT NULL CHECK(json_valid(kinds)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, locale TEXT);
CREATE TABLE shares(code TEXT PRIMARY KEY, record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE INDEX digests_scheduled ON digests(scheduled_at);
CREATE INDEX digest_reactions_updated ON digest_reactions(updated_at);
CREATE INDEX narration_runs_started ON narration_runs(started_at);
`;
/** The single-user predecessor's news and mail briefings, kept beside LEGACY_EXTRA's other tables instead of digests. */
export const LEGACY_BRIEFINGS = LEGACY_EXTRA.replace(/CREATE TABLE digests[\s\S]*?UNIQUE\(date,slot\)\);\n/, "")
  .replace(/CREATE TABLE digest_reactions[\s\S]*?PRIMARY KEY\(digest_id,section,article_key\)\);\n/, "")
  .replace(/CREATE INDEX digest[^\n]*\n/g, "") + `
CREATE TABLE briefings(id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL, scheduled_at TEXT NOT NULL,
 sections TEXT NOT NULL CHECK(json_valid(sections)), created_by TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, version INTEGER NOT NULL, news_read_at TEXT, mail_read_at TEXT, UNIQUE(date, slot));
CREATE INDEX briefings_scheduled ON briefings(scheduled_at);
CREATE TABLE briefing_reactions(briefing_id TEXT NOT NULL REFERENCES briefings(id), section TEXT NOT NULL, article_key TEXT NOT NULL,
 reaction TEXT NOT NULL CHECK(reaction IN ('like','dislike','seen')), title TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL,
 updated_at TEXT NOT NULL, PRIMARY KEY(briefing_id, section, article_key));
CREATE INDEX briefing_reactions_updated ON briefing_reactions(updated_at);
`;
