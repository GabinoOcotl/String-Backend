import type { Env } from "../env";
import type { CourseSearchHit } from "../types/enrollment";
import {
  DEFAULT_PAGE_SIZE,
  EnrollmentApiError,
  searchCourses,
} from "./enrollment-api";

/** Pages fetched per cron/manual invocation (stays under Worker subrequest limits). */
export const MAX_PAGES_PER_RUN = 40;

/** Rows per D1 batch upsert. */
const UPSERT_BATCH_SIZE = 25;

/** Skip sync if a completed run finished within this window. */
const SYNC_DEBOUNCE_MS = 2 * 60 * 60 * 1000;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

export type SyncStatus = "idle" | "running" | "complete" | "failed";

export interface ClassSyncState {
  term_code: string;
  status: SyncStatus;
  current_page: number;
  total_found: number | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface ClassSyncResult {
  skipped: boolean;
  reason?: string;
  status?: SyncStatus;
  pagesProcessed?: number;
  currentPage?: number;
  totalFound?: number | null;
}

type ClassSyncEnv = Env & { ENROLLMENT_TERM_CODE?: string };

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTermCode(env: ClassSyncEnv): string | null {
  const termCode = env.ENROLLMENT_TERM_CODE?.trim();
  return termCode || null;
}

function shouldSkipDueToDebounce(state: ClassSyncState): boolean {
  if (state.status !== "complete" || !state.completed_at) {
    return false;
  }
  const completedAt = new Date(state.completed_at).getTime();
  return Date.now() - completedAt < SYNC_DEBOUNCE_MS;
}

function isFreshStart(state: ClassSyncState): boolean {
  return state.status === "complete" || state.status === "idle";
}

function totalPages(totalFound: number): number {
  return Math.ceil(totalFound / DEFAULT_PAGE_SIZE);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}

async function loadOrCreateSyncState(
  db: D1Database,
  termCode: string,
): Promise<ClassSyncState> {
  const row = await db
    .prepare("SELECT * FROM class_sync_state WHERE term_code = ?")
    .bind(termCode)
    .first<ClassSyncState>();

  if (row) return row;

  await db
    .prepare(
      "INSERT INTO class_sync_state (term_code, status, current_page) VALUES (?, 'idle', 0)",
    )
    .bind(termCode)
    .run();

  return {
    term_code: termCode,
    status: "idle",
    current_page: 0,
    total_found: null,
    last_error: null,
    started_at: null,
    completed_at: null,
  };
}

async function markRunning(
  db: D1Database,
  termCode: string,
  fresh: boolean,
): Promise<void> {
  const startedAt = nowIso();
  if (fresh) {
    await db
      .prepare(
        `UPDATE class_sync_state
         SET status = 'running',
             current_page = 0,
             total_found = NULL,
             last_error = NULL,
             started_at = ?,
             completed_at = NULL
         WHERE term_code = ?`,
      )
      .bind(startedAt, termCode)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE class_sync_state
       SET status = 'running',
           last_error = NULL,
           started_at = COALESCE(started_at, ?)
       WHERE term_code = ?`,
    )
    .bind(startedAt, termCode)
    .run();
}

async function updateProgress(
  db: D1Database,
  termCode: string,
  currentPage: number,
  totalFound: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE class_sync_state
       SET current_page = ?,
           total_found = COALESCE(?, total_found)
       WHERE term_code = ?`,
    )
    .bind(currentPage, totalFound, termCode)
    .run();
}

async function markComplete(db: D1Database, termCode: string): Promise<void> {
  await db
    .prepare(
      `UPDATE class_sync_state
       SET status = 'complete',
           last_error = NULL,
           completed_at = ?
       WHERE term_code = ?`,
    )
    .bind(nowIso(), termCode)
    .run();
}

async function markFailed(
  db: D1Database,
  termCode: string,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof EnrollmentApiError
      ? `${error.message} (${error.status})`
      : error instanceof Error
        ? error.message
        : String(error);

  await db
    .prepare(
      `UPDATE class_sync_state
       SET status = 'failed',
           last_error = ?
       WHERE term_code = ?`,
    )
    .bind(message, termCode)
    .run();
}

function upsertCourseStatement(
  db: D1Database,
  hit: CourseSearchHit,
  syncedAt: string,
) {
  return db
    .prepare(
      `INSERT INTO courses (
         term_code, subject_code, course_id,
         course_designation, title, catalog_number,
         subject_description, data_json, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (term_code, subject_code, course_id) DO UPDATE SET
         course_designation = excluded.course_designation,
         title = excluded.title,
         catalog_number = excluded.catalog_number,
         subject_description = excluded.subject_description,
         data_json = excluded.data_json,
         synced_at = excluded.synced_at`,
    )
    .bind(
      hit.termCode,
      hit.subject.subjectCode,
      hit.courseId,
      hit.courseDesignation,
      hit.title,
      hit.catalogNumber ?? null,
      hit.subject.description ?? null,
      JSON.stringify(hit),
      syncedAt,
    );
}

async function upsertCourseHits(
  db: D1Database,
  hits: CourseSearchHit[],
  syncedAt: string,
): Promise<void> {
  for (let i = 0; i < hits.length; i += UPSERT_BATCH_SIZE) {
    const chunk = hits.slice(i, i + UPSERT_BATCH_SIZE);
    const statements = chunk.map((hit) =>
      upsertCourseStatement(db, hit, syncedAt),
    );
    await db.batch(statements);
  }
}

/**
 * Syncs the course catalog from the UW enrollment search API into D1.
 * Processes up to MAX_PAGES_PER_RUN pages per invocation and persists progress
 * in class_sync_state so cron runs can resume a large catalog incrementally.
 */
export async function runClassSync(env: ClassSyncEnv): Promise<ClassSyncResult> {
  const termCode = getTermCode(env);
  if (!termCode) {
    console.error("class-sync: ENROLLMENT_TERM_CODE is not configured");
    return { skipped: true, reason: "missing_term_code" };
  }

  const state = await loadOrCreateSyncState(env.DB, termCode);

  if (shouldSkipDueToDebounce(state)) {
    console.log(`class-sync: skipping term ${termCode}, recently completed`);
    return {
      skipped: true,
      reason: "recently_completed",
      status: state.status,
      currentPage: state.current_page,
      totalFound: state.total_found,
    };
  }

  const fresh = isFreshStart(state);
  const startPage = fresh ? 1 : state.current_page + 1;

  await markRunning(env.DB, termCode, fresh);

  let page = startPage;
  let pagesProcessed = 0;
  let totalFound = fresh ? null : state.total_found;
  const syncedAt = nowIso();

  try {
    while (pagesProcessed < MAX_PAGES_PER_RUN) {
      const response = await withRetry(() => searchCourses(termCode, page));

      if (totalFound === null) {
        totalFound = response.found;
      }

      if (response.hits.length > 0) {
        await upsertCourseHits(env.DB, response.hits, syncedAt);
      }

      await updateProgress(env.DB, termCode, page, totalFound);
      pagesProcessed++;

      const lastPage = totalFound !== null ? totalPages(totalFound) : page;
      const noMoreResults =
        response.hits.length === 0 || page >= lastPage;

      if (noMoreResults) {
        await markComplete(env.DB, termCode);
        console.log(
          `class-sync: completed term ${termCode}, ${totalFound} courses`,
        );
        return {
          skipped: false,
          status: "complete",
          pagesProcessed,
          currentPage: page,
          totalFound,
        };
      }

      page++;
    }

    console.log(
      `class-sync: chunked progress for term ${termCode}, page ${page - 1}/${totalFound !== null ? totalPages(totalFound) : "?"}`,
    );
    return {
      skipped: false,
      status: "running",
      pagesProcessed,
      currentPage: page - 1,
      totalFound,
    };
  } catch (error) {
    await markFailed(env.DB, termCode, error);
    console.error(`class-sync: failed for term ${termCode}`, error);
    throw error;
  }
}
