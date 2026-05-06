import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";

// ─── Env bindings (must match wrangler.jsonc) ────────────────────────────────
export interface Env {
  DB: D1Database;                          // Cloudflare D1
  BUCKET: R2Bucket;                        // Cloudflare R2
  CHAT_ROOM: DurableObjectNamespace;       // Durable Object for realtime chat
  SUPABASE_JWT_SECRET: string;             // Supabase Auth secret (env var)
  RESEND_API_KEY: string;                  // Resend email (env var)
}

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
const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// Health check
app.get("/", (c) => c.json({ status: "ok" }));

// ─── Auth routes ──────────────────────────────────────────────────────────────
const auth = app.basePath("/auth");

auth.post("/register", async (c) => {
  // Supabase Auth handles registration — call their API here later
  return c.json({ message: "register placeholder" });
});

auth.post("/login", async (c) => {
  return c.json({ message: "login placeholder" });
});

// ─── User routes ──────────────────────────────────────────────────────────────
const users = app.basePath("/users");

users.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first();
  return c.json(user ?? { error: "User not found" });
});

// ─── Messages routes ──────────────────────────────────────────────────────────
const messages = app.basePath("/messages");

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
  const { roomId, userId, text } = await c.req.json();
  await c.env.DB.prepare(
    "INSERT INTO messages (room_id, user_id, text) VALUES (?, ?, ?)"
  )
    .bind(roomId, userId, text)
    .run();
  return c.json({ success: true });
});

// ─── Chat (Durable Object) routes ─────────────────────────────────────────────
const chat = app.basePath("/chat");

chat.get("/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const stub = c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(roomId));
  return stub.fetch(c.req.raw);
});

// ─── File upload routes (R2) ──────────────────────────────────────────────────
const files = app.basePath("/files");

files.put("/:filename", async (c) => {
  const filename = c.req.param("filename");
  const body = await c.req.arrayBuffer();
  await c.env.BUCKET.put(filename, body);
  return c.json({ success: true, filename });
});

files.get("/:filename", async (c) => {
  const filename = c.req.param("filename");
  const object = await c.env.BUCKET.get(filename);
  if (!object) return c.json({ error: "File not found" }, 404);
  return new Response(object.body);
});

// ─── Export ───────────────────────────────────────────────────────────────────
export default app;