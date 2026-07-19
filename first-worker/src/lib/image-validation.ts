import type { ValidationResult } from "./validation";

/** Max profile photo size after client compression (5 MiB). */
export const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;

export type ProfileImageContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type DetectedProfileImage = {
  contentType: ProfileImageContentType;
  extension: "jpg" | "png" | "webp";
};

const JPEG_SIG = [0xff, 0xd8, 0xff] as const;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/** Detect image type from magic bytes (not filename or Content-Type). */
export function detectProfileImageType(
  bytes: Uint8Array,
): DetectedProfileImage | null {
  if (startsWith(bytes, JPEG_SIG)) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (startsWith(bytes, PNG_SIG)) {
    return { contentType: "image/png", extension: "png" };
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

/**
 * Validate size and magic-byte signature for a profile photo upload body.
 * Declared Content-Type is ignored for type detection.
 */
export function validateProfilePhotoBytes(
  body: ArrayBuffer,
): ValidationResult<DetectedProfileImage & { bytes: Uint8Array }> {
  if (body.byteLength === 0) {
    return { ok: false, error: "Empty body" };
  }
  if (body.byteLength > MAX_PROFILE_PHOTO_BYTES) {
    return {
      ok: false,
      error: `Image must be at most ${MAX_PROFILE_PHOTO_BYTES} bytes`,
    };
  }

  const bytes = new Uint8Array(body);
  const detected = detectProfileImageType(bytes);
  if (!detected) {
    return {
      ok: false,
      error: "Unsupported image type; only JPEG, PNG, and WebP are allowed",
    };
  }

  return { ok: true, value: { ...detected, bytes } };
}

/** Reject oversized uploads early when Content-Length is present. */
export function validateContentLengthHeader(
  contentLength: string | undefined,
): ValidationResult<number | null> {
  if (contentLength === undefined || contentLength === "") {
    return { ok: true, value: null };
  }
  const n = Number.parseInt(contentLength, 10);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: "Invalid Content-Length" };
  }
  if (n > MAX_PROFILE_PHOTO_BYTES) {
    return {
      ok: false,
      error: `Image must be at most ${MAX_PROFILE_PHOTO_BYTES} bytes`,
    };
  }
  return { ok: true, value: n };
}
