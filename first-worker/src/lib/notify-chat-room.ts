import type { Env } from "../env";
import type { ChatBroadcastEvent } from "../durable-objects/ChatRoom";
import type { EnrichedMessage } from "../services/message-service";

export async function broadcastRoomMessage(
  env: Env,
  roomId: string,
  message: EnrichedMessage,
): Promise<void> {
  const { is_own: _isOwn, ...payload } = message;
  const event: ChatBroadcastEvent = { type: "message", payload };

  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
  const response = await stub.fetch(
    new Request("http://chat-room/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }),
  );

  if (!response.ok) {
    throw new Error(`ChatRoom broadcast failed: ${response.status}`);
  }
}
