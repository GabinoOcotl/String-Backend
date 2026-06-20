import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { AuthUser } from "./auth";
import {
  isObservedSecurityStatus,
  logSecurityEvent,
  requestSecurityContext,
  statusToSecurityType,
} from "../lib/security-log";

/**
 * Emits structured JSON logs for 401, 403, 429, and 5xx responses so they can
 * be filtered in Workers Observability / Query Builder (`event = "security"`).
 */
export const securityObservability = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser };
}>(async (c, next) => {
  await next();

  const status = c.res.status;
  if (!isObservedSecurityStatus(status) || status === 429) {
    return;
  }

  logSecurityEvent(
    requestSecurityContext(c, {
      type: statusToSecurityType(status),
      status,
    }),
  );
});
