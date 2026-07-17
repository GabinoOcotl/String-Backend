import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../env";
import { logSecurityEvent, requestSecurityContext } from "../lib/security-log";
import type { AuthUser } from "./auth";

type RateLimitEnv = { Bindings: Env; Variables: { user: AuthUser } };

const HOUR_SEC = 3600;

interface WindowBucket {
  count: number;
  start: number;
}

function clientIp(c: Context): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function checkFixedWindowLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await kv.get<WindowBucket>(key, "json");

  if (!existing || now - existing.start >= windowSec) {
    await kv.put(key, JSON.stringify({ count: 1, start: now }), {
      expirationTtl: windowSec,
    });
    return { allowed: true };
  }

  if (existing.count >= limit) {
    return { allowed: false, retryAfter: windowSec - (now - existing.start) };
  }

  await kv.put(
    key,
    JSON.stringify({ count: existing.count + 1, start: existing.start }),
    { expirationTtl: Math.max(1, windowSec - (now - existing.start)) },
  );
  return { allowed: true };
}

function tooManyRequests(c: Context, retryAfter?: number) {
  const headers = retryAfter ? { "Retry-After": String(retryAfter) } : undefined;
  return c.json({ error: "Too many requests" }, 429, headers);
}

/** Global limit: 100 requests/minute per client IP. */
export const globalRateLimit = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const { success } = await c.env.RATE_LIMIT_GLOBAL.limit({
      key: clientIp(c),
    });
    if (!success) {
      logSecurityEvent(
        requestSecurityContext(c, {
          type: "rate_limited",
          status: 429,
          reason: "global",
        }),
      );
      return tooManyRequests(c, 60);
    }
    await next();
  },
);

/** Strict limit: 5 section cache refreshes/hour per authenticated user. */
export const sectionsRefreshRateLimit = createMiddleware<RateLimitEnv>(
  async (c, next) => {
    if (c.req.query("refresh") !== "true") {
      await next();
      return;
    }

    const { allowed, retryAfter } = await checkFixedWindowLimit(
      c.env.RATE_LIMIT_KV,
      `sections-refresh:${c.get("user").sub}`,
      5,
      HOUR_SEC,
    );
    if (!allowed) {
      logSecurityEvent(
        requestSecurityContext(c, {
          type: "rate_limited",
          status: 429,
          reason: "sections_refresh",
        }),
      );
      return tooManyRequests(c, retryAfter);
    }

    await next();
    logSecurityEvent(
      requestSecurityContext(c, {
        type: "sections_refresh",
        status: c.res.status,
        reason: "refresh=true",
      }),
    );
  },
);

/** Strict limit: 3 manual class syncs/hour per authenticated user. */
export const adminSyncRateLimit = createMiddleware<RateLimitEnv>(
  async (c, next) => {
    const { allowed, retryAfter } = await checkFixedWindowLimit(
      c.env.RATE_LIMIT_KV,
      `admin-sync:${c.get("user").sub}`,
      3,
      HOUR_SEC,
    );
    if (!allowed) {
      logSecurityEvent(
        requestSecurityContext(c, {
          type: "rate_limited",
          status: 429,
          reason: "admin_sync",
        }),
      );
      return tooManyRequests(c, retryAfter);
    }
    await next();
  },
);

/** Soft limit: 40 walking-route requests/hour per user (ORS free tier is 2k/day). */
export const walkingRouteRateLimit = createMiddleware<RateLimitEnv>(
  async (c, next) => {
    const { allowed, retryAfter } = await checkFixedWindowLimit(
      c.env.RATE_LIMIT_KV,
      `walking-route:${c.get("user").sub}`,
      40,
      HOUR_SEC,
    );
    if (!allowed) {
      logSecurityEvent(
        requestSecurityContext(c, {
          type: "rate_limited",
          status: 429,
          reason: "walking_route",
        }),
      );
      return tooManyRequests(c, retryAfter);
    }
    await next();
  },
);
