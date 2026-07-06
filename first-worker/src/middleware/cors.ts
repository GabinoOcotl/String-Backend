import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

function parseAllowedOrigins(origins: string | undefined): string[] {
  if (!origins?.trim()) return [];
  return origins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Restrict cross-origin browser access to configured origins. */
export function strictCors(): MiddlewareHandler<{ Bindings: Env }> {
  return cors({
    origin: (origin, c) => {
      const allowed = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
      if (!origin) return null;
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });
}
