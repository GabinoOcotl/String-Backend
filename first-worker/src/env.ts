// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;
  // BUCKET: R2Bucket; // re-enable with r2_buckets in wrangler.jsonc
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
}
