import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { sendEmail, ResendError, type SendEmailParams } from "./lib/resend";
import { requireAuth, type AuthUser } from "./middleware/auth";

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

// ─── File upload routes (R2, protected) ───────────────────────────────────────
const files = app.basePath("/files");
files.use(requireAuth);

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

// ─── Email (Resend, protected) ───────────────────────────────────────────────
const email = app.basePath("/email");
email.use(requireAuth);

/** Sends a test message via Resend to confirm API key and sender config. */
email.post("/test", async (c) => {
  const { to, subject } = await c.req.json<{ to?: string; subject?: string }>();
  if (!to) {
    return c.json({ error: "to is required" }, 400);
  }

  const apiKey = c.env.RESEND_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Server misconfigured" }, 500);
  }

  const from = c.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

  try {
    const params: SendEmailParams = {
      from,
      to,
      subject: subject ?? "String test email",
      html: "<p>This is a test email from your String Worker.</p>",
      text: "This is a test email from your String Worker.",
    };
    
    const result = await sendEmail(apiKey, params);
    return c.json({ success: true, id: result.id });
  } catch (err) {
    if (err instanceof ResendError) {
      return c.json({ error: err.message }, 502);
    }
    return c.json({ error: "Failed to send email" }, 500);
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────
export default app;