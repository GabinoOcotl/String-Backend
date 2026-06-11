CREATE TABLE IF NOT EXISTS courses (
  term_code            TEXT NOT NULL,
  subject_code         TEXT NOT NULL,
  course_id            TEXT NOT NULL,
  course_designation   TEXT NOT NULL,
  title                TEXT NOT NULL,
  catalog_number       TEXT,
  subject_description  TEXT,
  data_json            TEXT NOT NULL,
  synced_at            TEXT NOT NULL,
  PRIMARY KEY (term_code, subject_code, course_id)
);

CREATE INDEX IF NOT EXISTS idx_courses_term_designation
  ON courses (term_code, course_designation);

CREATE INDEX IF NOT EXISTS idx_courses_term_title
  ON courses (term_code, title);

CREATE TABLE IF NOT EXISTS course_sections_cache (
  term_code    TEXT NOT NULL,
  subject_code TEXT NOT NULL,
  course_id    TEXT NOT NULL,
  data_json    TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (term_code, subject_code, course_id)
);

CREATE TABLE IF NOT EXISTS class_sync_state (
  term_code    TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'idle',
  current_page INTEGER NOT NULL DEFAULT 0,
  total_found  INTEGER,
  last_error   TEXT,
  started_at   TEXT,
  completed_at TEXT
);
