-- Track application-owned R2 bytes for storage quota enforcement and monitoring.
ALTER TABLE users ADD COLUMN avatar_size_bytes INTEGER;
