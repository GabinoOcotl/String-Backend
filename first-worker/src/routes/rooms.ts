import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth, type AuthUser } from "../middleware/auth";
import {
  joinSectionRoom,
  leaveSectionRoom,
  listUserRooms,
  validateJoinSectionRoomInput,
} from "../services/room-service";

type RoomsEnv = Env & { ENROLLMENT_TERM_CODE?: string };

type AppEnv = {
  Bindings: RoomsEnv;
  Variables: { user: AuthUser };
};

function getTermCode(env: RoomsEnv): string | null {
  const termCode = env.ENROLLMENT_TERM_CODE?.trim();
  return termCode || null;
}

export const roomsRoutes = new Hono<AppEnv>();

roomsRoutes.use(requireAuth);

/** Join (or re-join) the groupchat for a schedule section. Idempotent. */
roomsRoutes.post("/join", async (c) => {
  const termCode = getTermCode(c.env);
  if (!termCode) {
    return c.json({ error: "ENROLLMENT_TERM_CODE is not configured" }, 500);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const inputResult = validateJoinSectionRoomInput(
    (body ?? {}) as Parameters<typeof validateJoinSectionRoomInput>[0],
  );
  if (!inputResult.ok) {
    return c.json({ error: inputResult.error }, 400);
  }

  const user = c.get("user");
  const result = await joinSectionRoom(
    c.env.DB,
    termCode,
    { id: user.sub, email: user.email },
    inputResult.value,
  );

  return c.json(result);
});

/** List chat threads for the authenticated user. */
roomsRoutes.get("/", async (c) => {
  const rooms = await listUserRooms(c.env.DB, c.get("user").sub);
  return c.json(rooms);
});

/** Leave a section room (schedule removal). Idempotent — returns 204 even if not a member. */
roomsRoutes.delete("/:roomId/membership", async (c) => {
  const user = c.get("user");
  await leaveSectionRoom(
    c.env.DB,
    { id: user.sub, email: user.email },
    c.req.param("roomId"),
  );
  return c.body(null, 204);
});
