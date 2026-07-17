import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth, type AuthUser } from "../middleware/auth";
import { walkingRouteRateLimit } from "../middleware/rate-limit";
import {
  getWalkingRoute,
  normalizeStops,
  WalkingRouteError,
} from "../services/walking-route";

type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser };
};

export const routesRoutes = new Hono<AppEnv>();

routesRoutes.use(requireAuth);

/**
 * POST /routes/walking
 * Body: { stops: [{ latitude, longitude }, ...] } (time-ordered class buildings)
 * Returns a polyline for the Route map (ORS walking when configured; else straight).
 */
routesRoutes.post("/walking", walkingRouteRateLimit, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const stopsRaw =
    body && typeof body === "object"
      ? (body as { stops?: unknown }).stops
      : undefined;

  try {
    const stops = normalizeStops(stopsRaw);
    const result = await getWalkingRoute(c.env, stops);
    return c.json(result);
  } catch (error) {
    if (error instanceof WalkingRouteError) {
      return c.json({ error: error.message }, error.status as 400 | 502);
    }
    throw error;
  }
});
