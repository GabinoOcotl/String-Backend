import { ensureUser } from "./users";

export interface EnrichedMessage {
  id: string;
  room_id: string;
  user_id: string;
  text: string;
  created_at: string;
  sender_name: string;
  is_own: boolean;
}

type MessageRow = {
  id: string;
  room_id: string;
  user_id: string;
  text: string;
  created_at: string;
  sender_name: string;
};

export async function getRoomMessages(
  db: D1Database,
  roomId: string,
  viewerId: string,
): Promise<EnrichedMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT
         m.id,
         m.room_id,
         m.user_id,
         m.text,
         m.created_at,
         COALESCE(u.name, u.email) AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ?
       ORDER BY m.created_at ASC`,
    )
    .bind(roomId)
    .all<MessageRow>();

  return results.map((row) => ({
    id: row.id,
    room_id: row.room_id,
    user_id: row.user_id,
    text: row.text,
    created_at: row.created_at,
    sender_name: row.sender_name,
    is_own: row.user_id === viewerId,
  }));
}

export async function createMessage(
  db: D1Database,
  user: { id: string; email?: string },
  roomId: string,
  text: string,
): Promise<EnrichedMessage> {
  await ensureUser(db, { id: user.id, email: user.email });

  const row = await db
    .prepare(
      `INSERT INTO messages (room_id, user_id, text) VALUES (?, ?, ?)
       RETURNING id, room_id, user_id, text, created_at`,
    )
    .bind(roomId, user.id, text)
    .first<Omit<EnrichedMessage, "sender_name" | "is_own">>();

  if (!row) {
    throw new Error("Failed to create message");
  }

  const sender = await db
    .prepare("SELECT COALESCE(name, email) AS sender_name FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ sender_name: string }>();

  return {
    ...row,
    sender_name: sender?.sender_name ?? user.email ?? user.id,
    is_own: true,
  };
}
