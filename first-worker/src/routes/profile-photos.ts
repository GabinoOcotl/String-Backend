import { Hono } from "hono";
import type { Env } from "../env";
import {
  validateContentLengthHeader,
} from "../lib/image-validation";
import { logSecurityEvent, requestSecurityContext } from "../lib/security-log";
import { requireAuth, type AuthUser } from "../middleware/auth";
import { profilePhotoUploadRateLimit } from "../middleware/rate-limit";
import {
  PROFILE_PHOTO_CACHE_CONTROL,
  deleteProfilePhoto,
  getProfilePhoto,
  isPhotoServiceError,
  uploadProfilePhoto,
} from "../services/profile-photo-service";

type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser };
};

export const profilePhotoRoutes = new Hono<AppEnv>();

profilePhotoRoutes.use(requireAuth);

/** Replace the authenticated user's profile photo (raw image body). */
profilePhotoRoutes.put("/me/photo", profilePhotoUploadRateLimit, async (c) => {
  const lengthCheck = validateContentLengthHeader(c.req.header("Content-Length"));
  if (!lengthCheck.ok) {
    const status = lengthCheck.error.includes("at most") ? 413 : 400;
    return c.json({ error: lengthCheck.error }, status);
  }

  const body = await c.req.arrayBuffer();
  const user = c.get("user");
  const result = await uploadProfilePhoto(
    c.env,
    { id: user.sub, email: user.email },
    body,
  );

  if (isPhotoServiceError(result)) {
    return c.json({ error: result.error }, result.status);
  }

  logSecurityEvent(
    requestSecurityContext(c, {
      type: "profile_photo_upload",
      status: 200,
      reason: result.contentType,
    }),
  );

  return c.json({
    contentType: result.contentType,
    updatedAt: result.updatedAt,
  });
});

/** Remove the authenticated user's profile photo. Idempotent. */
profilePhotoRoutes.delete("/me/photo", async (c) => {
  const user = c.get("user");
  const result = await deleteProfilePhoto(c.env, {
    id: user.sub,
    email: user.email,
  });

  if (isPhotoServiceError(result)) {
    return c.json({ error: result.error }, result.status);
  }

  if (result.deleted) {
    logSecurityEvent(
      requestSecurityContext(c, {
        type: "profile_photo_delete",
        status: 204,
      }),
    );
  }

  return c.body(null, 204);
});

/**
 * Fetch a user's profile photo. Requires authentication (any signed-in user).
 * Supports If-None-Match for conditional reads.
 */
profilePhotoRoutes.get("/:id/photo", async (c) => {
  const userId = c.req.param("id");
  const result = await getProfilePhoto(c.env, userId);

  if (isPhotoServiceError(result)) {
    return c.json({ error: result.error }, result.status);
  }

  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifNoneMatch && etagMatches(ifNoneMatch, result.etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: result.etag,
        "Cache-Control": PROFILE_PHOTO_CACHE_CONTROL,
      },
    });
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.size),
      ETag: result.etag,
      "Cache-Control": PROFILE_PHOTO_CACHE_CONTROL,
      "Last-Modified": result.uploaded.toUTCString(),
    },
  });
});

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const candidates = ifNoneMatch.split(",").map((v) => v.trim());
  if (candidates.includes("*")) return true;
  const normalized = etag.replace(/^W\//, "");
  return candidates.some((c) => {
    const n = c.replace(/^W\//, "");
    return n === etag || n === normalized || c === etag;
  });
}
