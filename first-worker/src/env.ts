// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  CHAT_ROOM: DurableObjectNamespace;
  SUPABASE_JWT_SECRET: string;
  RESEND_API_KEY: string;
}
