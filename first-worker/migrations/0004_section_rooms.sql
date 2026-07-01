-- Section-scoped chat rooms keyed by enrollment package identity
ALTER TABLE rooms ADD COLUMN term_code TEXT;
ALTER TABLE rooms ADD COLUMN subject_code TEXT;
ALTER TABLE rooms ADD COLUMN course_id TEXT;
ALTER TABLE rooms ADD COLUMN enrollment_class_number INTEGER;
ALTER TABLE rooms ADD COLUMN course_designation TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_section
  ON rooms(term_code, subject_code, course_id, enrollment_class_number);

ALTER TABLE room_members ADD COLUMN source TEXT DEFAULT 'schedule';
