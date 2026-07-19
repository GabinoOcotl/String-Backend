CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email                TEXT UNIQUE NOT NULL,
  name                 TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  avatar_key           TEXT,
  avatar_content_type  TEXT,
  avatar_updated_at    TEXT,
  avatar_size_bytes    INTEGER
);

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);