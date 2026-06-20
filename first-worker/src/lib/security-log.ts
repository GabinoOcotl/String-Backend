import type { Context } from "hono";
import type { AuthUser } from "../middleware/auth";

export type SecurityEventType =
  | "auth_denied"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "sections_refresh"
  | "sync_failed";

interface SecurityLogBase {
  event: "security";
  type: SecurityEventType;
  timestamp: string;
}

export interface RequestSecurityEvent extends SecurityLogBase {
  method: string;
  path: string;
  status: number;
  ip: string;
  userId?: string;
  reason?: string;
  rayId?: string;
}

export interface SyncFailedSecurityEvent extends SecurityLogBase {
  termCode: string;
  error: string;
  trigger: "scheduled" | "manual";
}

export type SecurityLogEvent = RequestSecurityEvent | SyncFailedSecurityEvent;

function clientIp(c: Context): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function requestSecurityContext(
  c: Context,
  fields: Omit<RequestSecurityEvent, "event" | "timestamp" | "method" | "path" | "ip" | "rayId"> &
    Partial<Pick<RequestSecurityEvent, "method" | "path" | "ip" | "rayId" | "userId">>,
): RequestSecurityEvent {
  return {
    event: "security",
    timestamp: new Date().toISOString(),
    method: fields.method ?? c.req.method,
    path: fields.path ?? c.req.path,
    ip: fields.ip ?? clientIp(c),
    rayId: fields.rayId ?? c.req.header("CF-Ray"),
    userId: fields.userId ?? optionalUserId(c),
    type: fields.type,
    status: fields.status,
    reason: fields.reason,
  };
}

function optionalUserId(c: Context): string | undefined {
  try {
    const user = c.get("user" as never) as AuthUser | undefined;
    return user?.sub;
  } catch {
    return undefined;
  }
}

export function logSecurityEvent(event: SecurityLogEvent): void {
  console.log(JSON.stringify(event));
}

const OBSERVED_STATUSES = new Set([401, 403, 429]);

export function isObservedSecurityStatus(status: number): boolean {
  return OBSERVED_STATUSES.has(status) || status >= 500;
}

export function statusToSecurityType(status: number): SecurityEventType {
  if (status === 401) return "auth_denied";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "server_error";
}
