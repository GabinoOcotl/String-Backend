// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;
  // BUCKET: R2Bucket; // re-enable with r2_buckets in wrangler.jsonc
  CHAT_ROOM: DurableObjectNamespace;
  RATE_LIMIT_GLOBAL: RateLimit;
  RATE_LIMIT_KV: KVNamespace;
  SUPABASE_JWT_SECRET: string;
  ENROLLMENT_TERM_CODE: string;
  /** Comma-separated Supabase user IDs allowed to call admin routes. */
  ADMIN_USER_IDS?: string;
  /** Comma-separated admin emails allowed to call admin routes. */
  ADMIN_EMAILS?: string;
}
