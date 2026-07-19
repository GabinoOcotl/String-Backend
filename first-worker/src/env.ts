// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;
  /** R2 bucket storing user profile photos (avatars). */
  PROFILE_PHOTOS: R2Bucket;
  /** Application-level profile photo storage cap in bytes (defaults to 8 GiB). */
  PROFILE_PHOTO_STORAGE_QUOTA_BYTES?: string;
  CHAT_ROOM: DurableObjectNamespace;
  RATE_LIMIT_GLOBAL: RateLimit;
  RATE_LIMIT_KV: KVNamespace;
  SUPABASE_JWT_SECRET?: string;
  /** Supabase project URL — enables ES256 JWT verification via JWKS. */
  SUPABASE_URL?: string;
  ENROLLMENT_TERM_CODE: string;
  /** Comma-separated Supabase user IDs allowed to call admin routes. */
  ADMIN_USER_IDS?: string;
  /** Comma-separated admin emails allowed to call admin routes. */
  ADMIN_EMAILS?: string;
  /** Comma-separated browser origins allowed for CORS (e.g. https://app.example.com). */
  ALLOWED_ORIGINS?: string;
  /** OpenRouteService API key for campus walking directions (secret). */
  OPENROUTESERVICE_API_KEY?: string;
}
