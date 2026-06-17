import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdmin, requireAuth, type AuthUser } from "../middleware/auth";
import {
  adminSyncRateLimit,
  sectionsRefreshRateLimit,
} from "../middleware/rate-limit";
import {
  parsePage,
  validateCourseId,
  validateSearchQuery,
  validateSubject,
} from "../lib/validation";
import { runClassSync } from "../services/class-sync";
import { EnrollmentApiError } from "../services/enrollment-api";
import {
  getCourseSections,
  SectionCacheError,
} from "../services/section-cache";
import type { CourseSearchHit } from "../types/enrollment";

type ClassesEnv = Env & { ENROLLMENT_TERM_CODE?: string };

type AppEnv = {
  Bindings: ClassesEnv;
  Variables: { user: AuthUser };
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface CourseRow {
  data_json: string;
}

function getTermCode(env: ClassesEnv): string | null {
  const termCode = env.ENROLLMENT_TERM_CODE?.trim();
  return termCode || null;
}

function parsePageSize(value: string | undefined): number {
  const size = Number.parseInt(value ?? String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(size) || size < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

function likePattern(query: string): string {
  return `%${query}%`;
}

function parseCourseHit(row: CourseRow): CourseSearchHit {
  return JSON.parse(row.data_json) as CourseSearchHit;
}

export const classesRoutes = new Hono<AppEnv>();

classesRoutes.use(requireAuth);

/** Search cached catalog: ?q=, ?page=, ?pageSize= */
classesRoutes.get("/", async (c) => {
  const termCode = getTermCode(c.env);
  if (!termCode) {
    return c.json({ error: "ENROLLMENT_TERM_CODE is not configured" }, 500);
  }

  const queryResult = validateSearchQuery(c.req.query("q"));
  if (!queryResult.ok) {
    return c.json({ error: queryResult.error }, 400);
  }
  const pageResult = parsePage(c.req.query("page"));
  if (!pageResult.ok) {
    return c.json({ error: pageResult.error }, 400);
  }

  const query = queryResult.value;
  const page = pageResult.value;
  const pageSize = parsePageSize(c.req.query("pageSize"));
  const offset = (page - 1) * pageSize;

  const searchClause = query
    ? `AND (
         course_designation LIKE ? ESCAPE '\\' OR
         title LIKE ? ESCAPE '\\' OR
         catalog_number LIKE ? ESCAPE '\\' OR
         subject_description LIKE ? ESCAPE '\\' OR
         subject_code LIKE ? ESCAPE '\\'
       )`
    : "";

  const searchBinds = query
    ? [
        likePattern(query),
        likePattern(query),
        likePattern(query),
        likePattern(query),
        likePattern(query),
      ]
    : [];

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM courses
     WHERE term_code = ? ${searchClause}`,
  )
    .bind(termCode, ...searchBinds)
    .first<{ count: number }>();

  const found = countRow?.count ?? 0;

  const { results } = await c.env.DB.prepare(
    `SELECT data_json FROM courses
     WHERE term_code = ? ${searchClause}
     ORDER BY course_designation ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(termCode, ...searchBinds, pageSize, offset)
    .all<CourseRow>();

  const hits = results.map(parseCourseHit);

  return c.json({ found, page, pageSize, hits });
});

/** Single course from D1 for the configured term. */
classesRoutes.get("/:subject/:courseId", async (c) => {
  const termCode = getTermCode(c.env);
  if (!termCode) {
    return c.json({ error: "ENROLLMENT_TERM_CODE is not configured" }, 500);
  }

  const subjectResult = validateSubject(c.req.param("subject"));
  if (!subjectResult.ok) {
    return c.json({ error: subjectResult.error }, 400);
  }
  const courseIdResult = validateCourseId(c.req.param("courseId"));
  if (!courseIdResult.ok) {
    return c.json({ error: courseIdResult.error }, 400);
  }

  const subject = subjectResult.value;
  const courseId = courseIdResult.value;

  const row = await c.env.DB.prepare(
    `SELECT data_json FROM courses
     WHERE term_code = ? AND subject_code = ? AND course_id = ?`,
  )
    .bind(termCode, subject, courseId)
    .first<CourseRow>();

  if (!row) {
    return c.json({ error: "Course not found" }, 404);
  }

  return c.json(parseCourseHit(row));
});

/** Cache-through section details (1h TTL; ?refresh=true bypasses cache). */
classesRoutes.get(
  "/:subject/:courseId/sections",
  sectionsRefreshRateLimit,
  async (c) => {
    const subjectResult = validateSubject(c.req.param("subject"));
    if (!subjectResult.ok) {
      return c.json({ error: subjectResult.error }, 400);
    }
    const courseIdResult = validateCourseId(c.req.param("courseId"));
    if (!courseIdResult.ok) {
      return c.json({ error: courseIdResult.error }, 400);
    }

    const subject = subjectResult.value;
    const courseId = courseIdResult.value;
    const forceRefresh = c.req.query("refresh") === "true";

    try {
      const result = await getCourseSections(c.env, subject, courseId, {
        forceRefresh,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof SectionCacheError) {
        const status = error.message.includes("not configured") ? 500 : 400;
        return c.json({ error: error.message }, status);
      }
      if (error instanceof EnrollmentApiError) {
        return c.json({ error: error.message }, 502);
      }
      throw error;
    }
  },
);

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use(requireAuth);

/** Manual catalog sync trigger for dev/testing. */
adminRoutes.post("/sync/classes", requireAdmin, adminSyncRateLimit, async (c) => {
  try {
    const result = await runClassSync(c.env);
    return c.json(result);
  } catch (error) {
    const message =
      error instanceof EnrollmentApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Class sync failed";
    return c.json({ error: message }, 500);
  }
});
