/**
 * One-off deploy verification: sync catalog to remote D1 and exercise section cache.
 * Run: npx tsx scripts/verify-deploy.ts
 */
import { readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import type { Env } from "../src/env";
import { runClassSync } from "../src/services/class-sync";
import { getCourseSections } from "../src/services/section-cache";

function loadDevVar(name: string): string {
  const content = readFileSync(".dev.vars", "utf8");
  const match = content.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!match) throw new Error(`Missing ${name} in .dev.vars`);
  return match[1].trim();
}

async function main(): Promise<void> {
  // Ensure SUPABASE_JWT_SECRET is available for getPlatformProxy env hydration.
  loadDevVar("SUPABASE_JWT_SECRET");

  const useRemote = process.argv.includes("--remote");
  const { env, dispose } = await getPlatformProxy<Env>({
    configPath: "./wrangler.jsonc",
    remoteBindings: useRemote,
    persist: !useRemote,
  });
  console.log(`Using ${useRemote ? "remote" : "local"} D1 bindings`);

  try {
    console.log("=== Class catalog sync ===");
    let iteration = 0;
    let lastResult;
    while (iteration < 10) {
      iteration++;
      lastResult = await runClassSync(env);
      console.log(`Sync iteration ${iteration}:`, lastResult);
      if (lastResult.status === "complete") break;
      if (lastResult.skipped && lastResult.reason === "recently_completed") break;
      if (lastResult.skipped && lastResult.reason === "missing_term_code") {
        throw new Error("ENROLLMENT_TERM_CODE is not configured");
      }
    }

    const termCode = env.ENROLLMENT_TERM_CODE;
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM courses WHERE term_code = ?",
    )
      .bind(termCode)
      .first<{ count: number }>();

    const syncState = await env.DB.prepare(
      "SELECT * FROM class_sync_state WHERE term_code = ?",
    )
      .bind(termCode)
      .first<{
        status: string;
        total_found: number | null;
        current_page: number;
        completed_at: string | null;
      }>();

    const coursesCount = countRow?.count ?? 0;
    console.log("\n=== D1 row counts ===");
    console.log({ coursesCount, syncState });

    if (syncState?.status !== "complete") {
      throw new Error(`Expected sync status 'complete', got '${syncState?.status}'`);
    }
    if (coursesCount === 0) {
      throw new Error("courses table is empty after sync");
    }
    if (
      syncState.total_found !== null &&
      Math.abs(coursesCount - syncState.total_found) > 50
    ) {
      throw new Error(
        `courses count (${coursesCount}) diverges from total_found (${syncState.total_found})`,
      );
    }

    console.log("\n=== Section cache behavior ===");
    const subject = "600";
    const courseId = "011598";

    const first = await getCourseSections(env, subject, courseId);
    console.log("First fetch:", {
      cached: first.cached,
      packageCount: first.packages.length,
      fetchedAt: first.fetchedAt,
      expiresAt: first.expiresAt,
    });

    const second = await getCourseSections(env, subject, courseId);
    console.log("Second fetch (expect cache hit):", {
      cached: second.cached,
      packageCount: second.packages.length,
      fetchedAt: second.fetchedAt,
    });

    if (first.cached) {
      console.warn("First fetch was cached (unexpected on cold cache)");
    }
    if (!second.cached) {
      throw new Error("Second sections fetch should be served from cache");
    }
    if (second.fetchedAt !== first.fetchedAt) {
      throw new Error("Cached fetch should reuse the same fetchedAt timestamp");
    }

    const cacheCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM course_sections_cache WHERE term_code = ?",
    )
      .bind(termCode)
      .first<{ count: number }>();

    console.log({ courseSectionsCacheRows: cacheCount?.count ?? 0 });
    console.log("\nVERIFY OK");
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
