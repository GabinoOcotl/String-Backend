-- Profile photo metadata (R2 object key + content type); bytes live in R2
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN avatar_content_type TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;
