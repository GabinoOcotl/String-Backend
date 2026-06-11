import type { Env } from "../env";
import type { EnrollmentPackage } from "../types/enrollment";
import { fetchEnrollmentPackages } from "./enrollment-api";

const CACHE_TTL_MS = 60 * 60 * 1000;

type SectionCacheEnv = Env & { ENROLLMENT_TERM_CODE?: string };

interface SectionsCacheRow {
  term_code: string;
  subject_code: string;
  course_id: string;
  data_json: string;
  fetched_at: string;
  expires_at: string;
}

export interface CourseSectionsResult {
  packages: EnrollmentPackage[];
  cached: boolean;
  fetchedAt: string;
  expiresAt: string;
}

export class SectionCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionCacheError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAtIso(fromMs = Date.now()): string {
  return new Date(fromMs + CACHE_TTL_MS).toISOString();
}

function getTermCode(env: SectionCacheEnv): string | null {
  const termCode = env.ENROLLMENT_TERM_CODE?.trim();
  return termCode || null;
}

async function loadCacheRow(
  db: D1Database,
  termCode: string,
  subjectCode: string,
  courseId: string,
): Promise<SectionsCacheRow | null> {
  return db
    .prepare(
      `SELECT term_code, subject_code, course_id, data_json, fetched_at, expires_at
       FROM course_sections_cache
       WHERE term_code = ? AND subject_code = ? AND course_id = ?`,
    )
    .bind(termCode, subjectCode, courseId)
    .first<SectionsCacheRow>();
}

function isCacheValid(row: SectionsCacheRow): boolean {
  return row.expires_at > nowIso();
}

async function upsertCache(
  db: D1Database,
  termCode: string,
  subjectCode: string,
  courseId: string,
  packages: EnrollmentPackage[],
): Promise<{ fetchedAt: string; expiresAt: string }> {
  const fetchedAt = nowIso();
  const expiresAt = expiresAtIso();

  await db
    .prepare(
      `INSERT INTO course_sections_cache (
         term_code, subject_code, course_id,
         data_json, fetched_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (term_code, subject_code, course_id) DO UPDATE SET
         data_json = excluded.data_json,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    )
    .bind(
      termCode,
      subjectCode,
      courseId,
      JSON.stringify(packages),
      fetchedAt,
      expiresAt,
    )
    .run();

  return { fetchedAt, expiresAt };
}

/**
 * Returns enrollment packages for a course via D1 cache-through (1h TTL).
 * Fetches from the UW API on cache miss or when forceRefresh is set.
 */
export async function getCourseSections(
  env: SectionCacheEnv,
  subjectCode: string,
  courseId: string,
  options?: { forceRefresh?: boolean },
): Promise<CourseSectionsResult> {
  const termCode = getTermCode(env);
  if (!termCode) {
    throw new SectionCacheError("ENROLLMENT_TERM_CODE is not configured");
  }

  const normalizedSubject = subjectCode.trim();
  const normalizedCourseId = courseId.trim();

  if (!normalizedSubject || !normalizedCourseId) {
    throw new SectionCacheError("subject and courseId are required");
  }

  if (!options?.forceRefresh) {
    const cached = await loadCacheRow(
      env.DB,
      termCode,
      normalizedSubject,
      normalizedCourseId,
    );
    if (cached && isCacheValid(cached)) {
      return {
        packages: JSON.parse(cached.data_json) as EnrollmentPackage[],
        cached: true,
        fetchedAt: cached.fetched_at,
        expiresAt: cached.expires_at,
      };
    }
  }

  const packages = await fetchEnrollmentPackages(
    termCode,
    normalizedSubject,
    normalizedCourseId,
  );

  const { fetchedAt, expiresAt } = await upsertCache(
    env.DB,
    termCode,
    normalizedSubject,
    normalizedCourseId,
    packages,
  );

  return {
    packages,
    cached: false,
    fetchedAt,
    expiresAt,
  };
}
