import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import type { Env } from "../env";

/** Claims we expose after verifying a Supabase access token. */
export type AuthUser = {
  sub: string;
  email?: string;
  role?: string;
};

type AuthEnv = { Bindings: Env; Variables: { user: AuthUser } };

/**
 * Verifies `Authorization: Bearer <access_token>` using Supabase JWT secret (HS256).
 * On success, sets `c.set("user", { sub, email?, role? })`.
 *
 * Applied via `.use(requireAuth)` on `/users`, `/messages`, `/chat`, `/files`
 * and on `GET /auth/me`. Public: `GET /` only.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization"); // get tocken that the frontend sned
  if (!header?.startsWith("Bearer ")) { 
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const secret = c.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    return c.json({ error: "Server misconfigured" }, 500);
  }

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { // verify token with JOSE
      algorithms: ["HS256"],
    });

    const sub = payload.sub;
    if (!sub || typeof sub !== "string") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("user", {
      sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      role: typeof payload.role === "string" ? payload.role : undefined,
    });

    await next(); // initates the next thing todo
  } catch {
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
