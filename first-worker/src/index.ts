import { Hono } from "hono";
import type { Env } from "./env";
import { requireAuth, requireSelf, type AuthUser } from "./middleware/auth";
import { assertRoomMember } from "./middleware/room-auth";
import { strictCors } from "./middleware/cors";
import { globalRateLimit } from "./middleware/rate-limit";
import { securityObservability } from "./middleware/security-observability";
import { broadcastRoomMessage } from "./lib/notify-chat-room";
import { validateMessageText } from "./lib/validation";
import { adminRoutes, classesRoutes } from "./routes/classes";
import { roomsRoutes } from "./routes/rooms";
import { runClassSync } from "./services/class-sync";
import { createMessage, getRoomMessages } from "./services/message-service";

export type { Env } from "./env";
export { ChatRoom } from "./durable-objects/ChatRoom";

// ─── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

app.use("*", strictCors());
app.use("*", globalRateLimit);
app.use("*", securityObservability);

// Health check
app.get("/", (c) => c.json({ status: "ok" }));

// ─── Auth (login/signup live in the app via Supabase client) ─────────────────
const auth = app.basePath("/auth");

/** Confirms the Bearer token is valid; use from the app after login. */
auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

// ─── User routes (protected) ──────────────────────────────────────────────────
const users = app.basePath("/users");
users.use(requireAuth);

users.get("/:id", requireSelf, async (c) => {
  const id = c.req.param("id");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first();
  return c.json(user ?? { error: "User not found" });
});

// ─── Messages routes (protected) ───────────────────────────────────────────────
const messages = app.basePath("/messages");
messages.use(requireAuth);

messages.get("/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const denied = await assertRoomMember(c, roomId);
  if (denied) return denied;

  const user = c.get("user");
  const results = await getRoomMessages(c.env.DB, roomId, user.sub);
  return c.json(results);
});

messages.post("/", async (c) => {
  const { roomId, text } = await c.req.json<{ roomId?: string; text?: string }>();
  if (!roomId) {
    return c.json({ error: "roomId is required" }, 400);
  }
  const textResult = validateMessageText(text);
  if (!textResult.ok) {
    return c.json({ error: textResult.error }, 400);
  }

  const denied = await assertRoomMember(c, roomId);
  if (denied) return denied;

  const user = c.get("user");
  const message = await createMessage(
    c.env.DB,
    { id: user.sub, email: user.email },
    roomId,
    textResult.value,
  );

  c.executionCtx.waitUntil(
    broadcastRoomMessage(c.env, roomId, message).catch((err) => {
      console.error("Failed to broadcast message to ChatRoom", err);
    }),
  );

  return c.json(message);
});

// ─── Chat (Durable Object) routes (protected) ─────────────────────────────────
const chat = app.basePath("/chat");
chat.use(requireAuth);

chat.get("/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const denied = await assertRoomMember(c, roomId);
  if (denied) return denied;

  const stub = c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(roomId));
  return stub.fetch(c.req.raw);
});

// ─── File upload routes (R2, protected) — disabled until R2 is configured ───
// const files = app.basePath("/files");
// files.use(requireAuth);
//
// files.put("/:filename", async (c) => {
//   const filename = c.req.param("filename");
//   const body = await c.req.arrayBuffer();
//   await c.env.BUCKET.put(filename, body);
//   return c.json({ success: true, filename });
// });
//
// files.get("/:filename", async (c) => {
//   const filename = c.req.param("filename");
//   const object = await c.env.BUCKET.get(filename);
//   if (!object) return c.json({ error: "File not found" }, 404);
//   return new Response(object.body);
// });

// ─── Rooms routes (protected) ─────────────────────────────────────────────────
app.route("/rooms", roomsRoutes);

// ─── Classes routes (protected) ───────────────────────────────────────────────
app.route("/classes", classesRoutes);
app.route("/admin", adminRoutes);

// ─── Export ───────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runClassSync(env));
  },
};