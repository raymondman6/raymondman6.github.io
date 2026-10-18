PRAGMA foreign_keys = ON;
CREATE TABLE threads (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 category TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 last_human_id INTEGER NOT NULL DEFAULT 0,
 answered_through_id INTEGER NOT NULL DEFAULT 0,
 next_status TEXT NOT NULL DEFAULT 'replied'
);
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 thread_id TEXT NOT NULL REFERENCES threads(id),
 role TEXT NOT NULL CHECK(role IN ('student','owner','assistant')),
 body TEXT NOT NULL,
 created_at TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,
 answered_through_id INTEGER
);
CREATE INDEX messages_thread ON messages(thread_id,id);
CREATE TABLE attachments (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 uploader TEXT NOT NULL,
 message_id INTEGER REFERENCES messages(id),
 created_at TEXT NOT NULL
);
CREATE TABLE invitations (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role='student'),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE TABLE sync_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reply_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
 thread_id TEXT NOT NULL REFERENCES threads(id),
 title TEXT NOT NULL,
 question_text TEXT NOT NULL,
 question_messages TEXT NOT NULL,
 answer_text TEXT NOT NULL,
 created_at TEXT NOT NULL,
 notified_at TEXT,
 delivery_reference TEXT
);
CREATE TABLE settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
