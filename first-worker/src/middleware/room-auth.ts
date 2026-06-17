import type { Context } from "hono";
import type { Env } from "../env";
import type { AuthUser } from "./auth";

type RoomAuthContext = Context<{
  Bindings: Env;
  Variables: { user: AuthUser };
}>;

/**
 * Ensures the authenticated user belongs to an existing room.
 * Returns a response to send when access is denied, or null when allowed.
 */
export async function assertRoomMember(
  c: RoomAuthContext,
  roomId: string,
): Promise<Response | null> {
  const room = await c.env.DB.prepare("SELECT id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first();

  if (!room) {
    return c.json({ error: "Room not found" }, 404);
  }

  const member = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?",
  )
    .bind(roomId, c.get("user").sub)
    .first();

  if (!member) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return null;
}
