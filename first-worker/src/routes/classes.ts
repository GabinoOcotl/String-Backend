import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth, type AuthUser } from "../middleware/auth";
import {
  adminSyncRateLimit,
  sectionsRefreshRateLimit,
} from "../middleware/rate-limit";
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

function parsePage(value: string | undefined): number {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

function parsePageSize(value: string | undefined): number {
  const size = Number.parseInt(value ?? String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(size) || size < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

function normalizeQuery(q: string | undefined): string {
  const trimmed = q?.trim() ?? "";
  if (!trimmed || trimmed === "*") return "";
  return trimmed;
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

  const query = normalizeQuery(c.req.query("q"));
  const page = parsePage(c.req.query("page"));
  const pageSize = parsePageSize(c.req.query("pageSize"));
  const offset = (page - 1) * pageSize;

  const searchClause = query
    ? `AND (
         course_designation LIKE ? OR
         title LIKE ? OR
         catalog_number LIKE ? OR
         subject_description LIKE ? OR
         subject_code LIKE ?
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

  const subject = c.req.param("subject").trim();
  const courseId = c.req.param("courseId").trim();

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
    const subject = c.req.param("subject");
    const courseId = c.req.param("courseId");
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
adminRoutes.post("/sync/classes", adminSyncRateLimit, async (c) => {
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
