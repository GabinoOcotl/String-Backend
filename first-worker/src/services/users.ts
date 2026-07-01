export interface EnsureUserInput {
  id: string;
  email?: string;
  name?: string;
}

function placeholderEmail(userId: string): string {
  return `${userId}@users.internal`;
}

/**
 * Upserts a D1 user row using the Supabase JWT `sub` as `users.id`.
 * Call before any write that references `user_id` to satisfy FK constraints.
 */
export async function ensureUser(
  db: D1Database,
  input: EnsureUserInput,
): Promise<void> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("user id is required");
  }

  const email = input.email?.trim();
  const name = input.name?.trim() ?? null;
  const insertEmail = email ?? placeholderEmail(id);
  const updateEmail = email ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = CASE WHEN ? = 1 THEN excluded.email ELSE users.email END,
         name = COALESCE(excluded.name, users.name)`,
    )
    .bind(id, insertEmail, name, updateEmail)
    .run();
}
