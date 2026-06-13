// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;
  // BUCKET: R2Bucket; // re-enable with r2_buckets in wrangler.jsonc
  CHAT_ROOM: DurableObjectNamespace;
  SUPABASE_JWT_SECRET: string;
  ENROLLMENT_TERM_CODE: string;
}
