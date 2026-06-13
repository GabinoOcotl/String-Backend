import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { requireAuth, type AuthUser } from "./middleware/auth";
import { adminRoutes, classesRoutes } from "./routes/classes";
import { runClassSync } from "./services/class-sync";

export type { Env } from "./env";

// ─── Durable Object (realtime chat — logic coming later) ─────────────────────
export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // WebSocket and chat logic will go here
  async fetch(request: Request): Promise<Response> {
    return new Response("ChatRoom placeholder", { status: 200 });
  }
}

// ─── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

app.use("*", cors());

// Health check
app.get("/", (c) => c.json({ status: "ok" }));

// ─── Auth (login/signup live in the app via Supabase client) ─────────────────
const auth = app.basePath("/auth");

/** Confirms the Bearer token is valid; use from the app after login. */
auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

// ─── User routes (protected) ──────────────────────────────────────────────────
const users = app.basePath("/users");
users.use(requireAuth);

users.get("/:id", async (c) => {
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
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC"
  )
    .bind(roomId)
    .all();
  return c.json(results);
});

messages.post("/", async (c) => {
  const { roomId, text } = await c.req.json<{ roomId?: string; text?: string }>();
  if (!roomId || !text) {
    return c.json({ error: "roomId and text are required" }, 400);
  }
  const userId = c.get("user").sub;
  await c.env.DB.prepare(
    "INSERT INTO messages (room_id, user_id, text) VALUES (?, ?, ?)"
  )
    .bind(roomId, userId, text)
    .run();
  return c.json({ success: true });
});

// ─── Chat (Durable Object) routes (protected) ─────────────────────────────────
const chat = app.basePath("/chat");
chat.use(requireAuth);

chat.get("/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
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