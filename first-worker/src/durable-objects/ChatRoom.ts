import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export type ChatMessagePayload = {
  id: string;
  room_id: string;
  user_id: string;
  text: string;
  created_at: string;
  sender_name: string;
};

export type ChatBroadcastEvent = {
  type: "message";
  payload: ChatMessagePayload;
};

const PING = JSON.stringify({ type: "ping" });
const PONG = JSON.stringify({ type: "pong" });

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const event = await request.json<ChatBroadcastEvent>();
      if (event.type !== "message" || !event.payload) {
        return new Response("Invalid broadcast payload", { status: 400 });
      }
      this.broadcast(event);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    let parsed: { type?: string };
    try {
      parsed = JSON.parse(text) as { type?: string };
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (parsed.type === "ping") {
      ws.send(PONG);
      return;
    }

    ws.send(
      JSON.stringify({
        type: "error",
        message: "Send messages via POST /messages",
      }),
    );
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("ChatRoom WebSocket error", error);
    ws.close(1011, "WebSocket error");
  }

  private broadcast(event: ChatBroadcastEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Dead socket — runtime will clean up on next event.
      }
    }
  }
}
