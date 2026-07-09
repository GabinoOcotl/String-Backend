import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Env } from "../env";

/** Claims we expose after verifying a Supabase access token. */
export type AuthUser = {
  sub: string;
  email?: string;
  role?: string;
};

type AuthEnv = { Bindings: Env; Variables: { user: AuthUser } };

const jwksBySupabaseUrl = new Map<string, JWTVerifyGetKey>();

function getSupabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  const base = supabaseUrl.replace(/\/$/, "");
  const cached = jwksBySupabaseUrl.get(base);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(
    new URL(`${base}/auth/v1/.well-known/jwks.json`),
  );
  jwksBySupabaseUrl.set(base, jwks);
  return jwks;
}

async function verifySupabaseAccessToken(token: string, env: Env) {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  if (supabaseUrl) {
    return jwtVerify(token, getSupabaseJwks(supabaseUrl));
  }

  const secret = env.SUPABASE_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("missing_supabase_auth_config");
  }

  return jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
  });
}

/**
 * Verifies `Authorization: Bearer <access_token>` using Supabase JWKS (ES256)
 * when `SUPABASE_URL` is set, otherwise HS256 via `SUPABASE_JWT_SECRET`.
 * On success, sets `c.set("user", { sub, email?, role? })`.
 */
function extractAccessToken(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | null {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const queryToken = c.req.query("token")?.trim();
  return queryToken || null;
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = extractAccessToken(c);
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!c.env.SUPABASE_URL?.trim() && !c.env.SUPABASE_JWT_SECRET?.trim()) {
    return c.json({ error: "Server misconfigured" }, 500);
  }

  try {
    const { payload } = await verifySupabaseAccessToken(token, c.env);

    const sub = payload.sub;
    if (!sub || typeof sub !== "string") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("user", {
      sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      role: typeof payload.role === "string" ? payload.role : undefined,
    });

    await next();
  } catch (err) {
    if (err instanceof Error && err.message === "missing_supabase_auth_config") {
      return c.json({ error: "Server misconfigured" }, 500);
    }
    return c.json({ error: "Unauthorized" }, 401);
  }
});

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean));
}

function parseEmailAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isAdminUser(user: AuthUser, env: Env): boolean {
  if (parseAllowlist(env.ADMIN_USER_IDS).has(user.sub)) {
    return true;
  }

  const email = user.email?.trim().toLowerCase();
  return email ? parseEmailAllowlist(env.ADMIN_EMAILS).has(email) : false;
}

/**
 * Requires an authenticated user whose `sub` or `email` appears in
 * `ADMIN_USER_IDS` / `ADMIN_EMAILS`. Must run after `requireAuth`.
 */
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  if (!c.env.ADMIN_USER_IDS?.trim() && !c.env.ADMIN_EMAILS?.trim()) {
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (!isAdminUser(c.get("user"), c.env)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
});

/**
 * Requires the `:id` route param to match the authenticated user's `sub`.
 * Must run after `requireAuth`.
 */
export const requireSelf = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.req.param("id") !== c.get("user").sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
});
