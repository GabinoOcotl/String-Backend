// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  CHAT_ROOM: DurableObjectNamespace;
  SUPABASE_JWT_SECRET: string;
  RESEND_API_KEY: string;
  /** Verified sender in Resend; optional in dev (test route defaults to onboarding@resend.dev). */
  RESEND_FROM_EMAIL?: string;
}
