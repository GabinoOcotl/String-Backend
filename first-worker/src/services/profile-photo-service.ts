import type { Env } from "../env";
import {
  type DetectedProfileImage,
  MAX_PROFILE_PHOTO_BYTES,
  validateProfilePhotoBytes,
} from "../lib/image-validation";
import { ensureUser } from "./users";

/** Private-cacheable avatar responses (authenticated Worker delivery). */
export const PROFILE_PHOTO_CACHE_CONTROL =
  "private, max-age=3600, stale-while-revalidate=86400";
export const DEFAULT_PROFILE_PHOTO_STORAGE_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;
export const PROFILE_PHOTO_STORAGE_WARNING_RATIO = 0.8;

export type AvatarRow = {
  avatar_key: string | null;
  avatar_content_type: string | null;
  avatar_updated_at: string | null;
  avatar_size_bytes: number | null;
};

export type ProfilePhotoUploadResult = {
  contentType: string;
  updatedAt: string;
};

export type ProfilePhotoObject = {
  body: ReadableStream;
  contentType: string;
  etag: string;
  uploaded: Date;
  size: number;
};

export type ProfilePhotoError = {
  error: string;
  status: 400 | 404 | 413 | 415 | 500 | 507;
};

export type ProfilePhotoUsage = {
  objectCount: number;
  bytesStored: number;
  quotaBytes: number;
  utilization: number;
};

function isProfilePhotoError(value: unknown): value is ProfilePhotoError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    "status" in value
  );
}

function avatarKey(userId: string, detected: DetectedProfileImage): string {
  return `users/${userId}/avatar/${crypto.randomUUID()}.${detected.extension}`;
}

async function getAvatarRow(
  db: D1Database,
  userId: string,
): Promise<AvatarRow | null> {
  return db
    .prepare(
      `SELECT avatar_key, avatar_content_type, avatar_updated_at, avatar_size_bytes
       FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<AvatarRow>();
}

export function profilePhotoStorageQuotaBytes(
  env: Pick<Env, "PROFILE_PHOTO_STORAGE_QUOTA_BYTES">,
): number {
  const configured = Number(env.PROFILE_PHOTO_STORAGE_QUOTA_BYTES);
  return Number.isSafeInteger(configured) && configured >= MAX_PROFILE_PHOTO_BYTES
    ? configured
    : DEFAULT_PROFILE_PHOTO_STORAGE_QUOTA_BYTES;
}

export async function getProfilePhotoUsage(
  env: Pick<Env, "DB" | "PROFILE_PHOTO_STORAGE_QUOTA_BYTES">,
): Promise<ProfilePhotoUsage> {
  const row = await env.DB.prepare(
    `SELECT COUNT(avatar_key) AS object_count,
            COALESCE(SUM(avatar_size_bytes), 0) AS bytes_stored
     FROM users
     WHERE avatar_key IS NOT NULL`,
  ).first<{ object_count: number; bytes_stored: number }>();
  const quotaBytes = profilePhotoStorageQuotaBytes(env);
  const bytesStored = Number(row?.bytes_stored ?? 0);

  return {
    objectCount: Number(row?.object_count ?? 0),
    bytesStored,
    quotaBytes,
    utilization: bytesStored / quotaBytes,
  };
}

/** Emit one structured storage-usage record per scheduled run for Workers Logs. */
export async function logProfilePhotoUsage(
  env: Pick<Env, "DB" | "PROFILE_PHOTO_STORAGE_QUOTA_BYTES">,
): Promise<void> {
  const usage = await getProfilePhotoUsage(env);
  console.log({
    type: "profile_photo_storage_usage",
    ...usage,
    warning: usage.utilization >= PROFILE_PHOTO_STORAGE_WARNING_RATIO,
  });
}

/**
 * Upload a profile photo for `userId` (JWT sub). Object key is server-generated.
 * Updates D1 only after R2 succeeds; rolls back the new object on D1 failure;
 * deletes the prior object after a successful replacement.
 */
export async function uploadProfilePhoto(
  env: Pick<
    Env,
    "DB" | "PROFILE_PHOTOS" | "PROFILE_PHOTO_STORAGE_QUOTA_BYTES"
  >,
  user: { id: string; email?: string },
  body: ArrayBuffer,
): Promise<ProfilePhotoUploadResult | ProfilePhotoError> {
  const validated = validateProfilePhotoBytes(body);
  if (!validated.ok) {
    const oversized = validated.error.includes("at most");
    return {
      error: validated.error,
      status: oversized ? 413 : validated.error.includes("Unsupported") ? 415 : 400,
    };
  }

  const { contentType, bytes } = validated.value;
  const detected: DetectedProfileImage = {
    contentType,
    extension: validated.value.extension,
  };

  await ensureUser(env.DB, { id: user.id, email: user.email });

  const existing = await getAvatarRow(env.DB, user.id);
  const previousKey = existing?.avatar_key ?? null;
  const previousSize = existing?.avatar_size_bytes ?? 0;
  const usage = await getProfilePhotoUsage(env);
  const projectedBytes = usage.bytesStored - previousSize + bytes.byteLength;
  if (projectedBytes > usage.quotaBytes) {
    return {
      error: "Profile photo storage quota reached",
      status: 507,
    };
  }
  const key = avatarKey(user.id, detected);
  const updatedAt = new Date().toISOString();

  const putResult = await env.PROFILE_PHOTOS.put(key, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: PROFILE_PHOTO_CACHE_CONTROL,
    },
    customMetadata: {
      userId: user.id,
    },
  });

  if (!putResult) {
    return { error: "Upload failed", status: 500 };
  }

  try {
    await env.DB.prepare(
      `UPDATE users
       SET avatar_key = ?, avatar_content_type = ?, avatar_updated_at = ?,
           avatar_size_bytes = ?
       WHERE id = ?`,
    )
      .bind(key, contentType, updatedAt, bytes.byteLength, user.id)
      .run();
  } catch (err) {
    await env.PROFILE_PHOTOS.delete(key).catch(() => undefined);
    console.error("profile photo D1 update failed; compensated R2 delete", err);
    return { error: "Failed to save photo metadata", status: 500 };
  }

  if (previousKey && previousKey !== key) {
    await env.PROFILE_PHOTOS.delete(previousKey).catch((err) => {
      console.error("failed to delete previous profile photo object", err);
    });
  }

  return { contentType, updatedAt };
}

/** Load avatar bytes for any user id (caller enforces auth). */
export async function getProfilePhoto(
  env: Pick<Env, "DB" | "PROFILE_PHOTOS">,
  userId: string,
): Promise<ProfilePhotoObject | ProfilePhotoError> {
  const row = await getAvatarRow(env.DB, userId);
  if (!row?.avatar_key) {
    return { error: "Photo not found", status: 404 };
  }

  const object = await env.PROFILE_PHOTOS.get(row.avatar_key);
  if (!object) {
    return { error: "Photo not found", status: 404 };
  }

  return {
    body: object.body,
    contentType:
      row.avatar_content_type ??
      object.httpMetadata?.contentType ??
      "application/octet-stream",
    etag: object.httpEtag,
    uploaded: object.uploaded,
    size: object.size,
  };
}

/**
 * Clear avatar metadata then delete the R2 object.
 * D1 is cleared first so a failed R2 delete cannot leave a broken pointer.
 */
export async function deleteProfilePhoto(
  env: Pick<Env, "DB" | "PROFILE_PHOTOS">,
  user: { id: string; email?: string },
): Promise<{ deleted: boolean } | ProfilePhotoError> {
  await ensureUser(env.DB, { id: user.id, email: user.email });

  const existing = await getAvatarRow(env.DB, user.id);
  const key = existing?.avatar_key ?? null;
  if (!key) {
    return { deleted: false };
  }

  await env.DB.prepare(
    `UPDATE users
     SET avatar_key = NULL, avatar_content_type = NULL, avatar_updated_at = NULL,
         avatar_size_bytes = NULL
     WHERE id = ?`,
  )
    .bind(user.id)
    .run();

  await env.PROFILE_PHOTOS.delete(key).catch((err) => {
    console.error("failed to delete profile photo object after D1 clear", err);
  });

  return { deleted: true };
}

export function isPhotoServiceError(
  value: ProfilePhotoUploadResult | ProfilePhotoObject | { deleted: boolean } | ProfilePhotoError,
): value is ProfilePhotoError {
  return isProfilePhotoError(value);
}
