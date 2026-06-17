export const MAX_SEARCH_QUERY_LENGTH = 100;
export const MAX_SUBJECT_LENGTH = 20;
export const MAX_COURSE_ID_LENGTH = 20;
export const MAX_PAGE = 200;
export const MAX_MESSAGE_TEXT_LENGTH = 2000;

const SUBJECT_COURSE_ID_REGEX = /^[A-Za-z0-9.-]+$/;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Escape `%`, `_`, and `\` so user input cannot broaden LIKE matches. */
export function escapeLikeWildcards(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export function validateSearchQuery(
  q: string | undefined,
): ValidationResult<string> {
  const trimmed = q?.trim() ?? "";
  if (!trimmed || trimmed === "*") {
    return { ok: true, value: "" };
  }
  if (trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
    return {
      ok: false,
      error: `Search query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`,
    };
  }
  return { ok: true, value: escapeLikeWildcards(trimmed) };
}

export function validateSubject(value: string): ValidationResult<string> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "subject is required" };
  }
  if (trimmed.length > MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      error: `subject must be at most ${MAX_SUBJECT_LENGTH} characters`,
    };
  }
  if (!SUBJECT_COURSE_ID_REGEX.test(trimmed)) {
    return { ok: false, error: "subject contains invalid characters" };
  }
  return { ok: true, value: trimmed };
}

export function validateCourseId(value: string): ValidationResult<string> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "courseId is required" };
  }
  if (trimmed.length > MAX_COURSE_ID_LENGTH) {
    return {
      ok: false,
      error: `courseId must be at most ${MAX_COURSE_ID_LENGTH} characters`,
    };
  }
  if (!SUBJECT_COURSE_ID_REGEX.test(trimmed)) {
    return { ok: false, error: "courseId contains invalid characters" };
  }
  return { ok: true, value: trimmed };
}

export function parsePage(value: string | undefined): ValidationResult<number> {
  const page = Number.parseInt(value ?? "1", 10);
  if (!Number.isFinite(page) || page < 1) {
    return { ok: true, value: 1 };
  }
  if (page > MAX_PAGE) {
    return {
      ok: false,
      error: `page must be at most ${MAX_PAGE}`,
    };
  }
  return { ok: true, value: page };
}

export function validateMessageText(
  text: string | undefined,
): ValidationResult<string> {
  if (text === undefined || text === null || text === "") {
    return { ok: false, error: "text is required" };
  }
  if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
    return {
      ok: false,
      error: `text must be at most ${MAX_MESSAGE_TEXT_LENGTH} characters`,
    };
  }
  return { ok: true, value: text };
}
