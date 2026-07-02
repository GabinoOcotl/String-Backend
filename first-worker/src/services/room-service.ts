import {
  validateCourseId,
  validateSubject,
  type ValidationResult,
} from "../lib/validation";
import { ensureUser } from "./users";

const MAX_COURSE_DESIGNATION_LENGTH = 200;

export interface JoinSectionRoomInput {
  subjectCode: string;
  courseId: string;
  enrollmentClassNumber: number;
  courseDesignation: string;
}

export interface JoinSectionRoomResult {
  roomId: string;
  name: string;
  joined: true;
}

export interface RoomThread {
  id: string;
  name: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

export function sectionRoomId(
  subjectCode: string,
  courseId: string,
  enrollmentClassNumber: number,
): string {
  return `${subjectCode}-${courseId}-${enrollmentClassNumber}`;
}

export function validateJoinSectionRoomInput(
  body: Partial<JoinSectionRoomInput> & Record<string, unknown>,
): ValidationResult<JoinSectionRoomInput> {
  const subjectResult = validateSubject(String(body.subjectCode ?? ""));
  if (!subjectResult.ok) {
    return { ok: false, error: "subjectCode is required" };
  }

  const courseIdResult = validateCourseId(String(body.courseId ?? ""));
  if (!courseIdResult.ok) {
    return { ok: false, error: "courseId is required" };
  }

  const enrollmentClassNumber = body.enrollmentClassNumber;
  if (
    typeof enrollmentClassNumber !== "number" ||
    !Number.isInteger(enrollmentClassNumber) ||
    enrollmentClassNumber < 1
  ) {
    return {
      ok: false,
      error: "enrollmentClassNumber must be a positive integer",
    };
  }

  const courseDesignation = String(body.courseDesignation ?? "").trim();
  if (!courseDesignation) {
    return { ok: false, error: "courseDesignation is required" };
  }
  if (courseDesignation.length > MAX_COURSE_DESIGNATION_LENGTH) {
    return {
      ok: false,
      error: `courseDesignation must be at most ${MAX_COURSE_DESIGNATION_LENGTH} characters`,
    };
  }

  return {
    ok: true,
    value: {
      subjectCode: subjectResult.value,
      courseId: courseIdResult.value,
      enrollmentClassNumber,
      courseDesignation,
    },
  };
}

export async function joinSectionRoom(
  db: D1Database,
  termCode: string,
  user: { id: string; email?: string },
  input: JoinSectionRoomInput,
): Promise<JoinSectionRoomResult> {
  await ensureUser(db, { id: user.id, email: user.email });

  const roomId = sectionRoomId(
    input.subjectCode,
    input.courseId,
    input.enrollmentClassNumber,
  );
  const name = input.courseDesignation;

  await db
    .prepare(
      `INSERT OR IGNORE INTO rooms (
         id, name, term_code, subject_code, course_id,
         enrollment_class_number, course_designation
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      roomId,
      name,
      termCode,
      input.subjectCode,
      input.courseId,
      input.enrollmentClassNumber,
      name,
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO room_members (room_id, user_id, source)
       VALUES (?, ?, 'schedule')`,
    )
    .bind(roomId, user.id)
    .run();

  const room = await db
    .prepare("SELECT name FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ name: string }>();

  return {
    roomId,
    name: room?.name ?? name,
    joined: true,
  };
}

export async function listUserRooms(
  db: D1Database,
  userId: string,
): Promise<RoomThread[]> {
  const { results } = await db
    .prepare(
      `SELECT
         r.id,
         r.name,
         (
           SELECT text FROM messages
           WHERE room_id = r.id
           ORDER BY created_at DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT created_at FROM messages
           WHERE room_id = r.id
           ORDER BY created_at DESC
           LIMIT 1
         ) AS last_message_at
       FROM room_members rm
       JOIN rooms r ON r.id = rm.room_id
       WHERE rm.user_id = ?
       ORDER BY COALESCE(
         (
           SELECT created_at FROM messages
           WHERE room_id = r.id
           ORDER BY created_at DESC
           LIMIT 1
         ),
         r.created_at
       ) DESC`,
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      last_message: string | null;
      last_message_at: string | null;
    }>();

  return results.map((row) => ({
    id: row.id,
    name: row.name,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
  }));
}
