/**
 * Unit tests for profile photo validation (magic bytes, size, Content-Length).
 * Run: npx tsx --test src/lib/image-validation.test.ts
 *   or: npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PROFILE_PHOTO_BYTES,
  detectProfileImageType,
  validateContentLengthHeader,
  validateProfilePhotoBytes,
} from "./image-validation";

function jpegFixture(extra = 0): ArrayBuffer {
  const bytes = new Uint8Array(3 + extra);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.buffer;
}

function pngFixture(): ArrayBuffer {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  return bytes.buffer;
}

function webpFixture(): ArrayBuffer {
  const bytes = new Uint8Array(12);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return bytes.buffer;
}

describe("detectProfileImageType", () => {
  it("detects JPEG from magic bytes", () => {
    const detected = detectProfileImageType(new Uint8Array(jpegFixture()));
    assert.deepEqual(detected, {
      contentType: "image/jpeg",
      extension: "jpg",
    });
  });

  it("detects PNG from magic bytes", () => {
    const detected = detectProfileImageType(new Uint8Array(pngFixture()));
    assert.deepEqual(detected, {
      contentType: "image/png",
      extension: "png",
    });
  });

  it("detects WebP from RIFF/WEBP signature", () => {
    const detected = detectProfileImageType(new Uint8Array(webpFixture()));
    assert.deepEqual(detected, {
      contentType: "image/webp",
      extension: "webp",
    });
  });

  it("rejects disguised non-images", () => {
    const fake = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    assert.equal(detectProfileImageType(fake), null);
  });

  it("rejects RIFF without WEBP", () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x41, 0x56, 0x49, 0x20], 8); // AVI
    assert.equal(detectProfileImageType(bytes), null);
  });
});

describe("validateProfilePhotoBytes", () => {
  it("accepts valid JPEG", () => {
    const result = validateProfilePhotoBytes(jpegFixture(16));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.contentType, "image/jpeg");
    }
  });

  it("rejects empty body", () => {
    const result = validateProfilePhotoBytes(new ArrayBuffer(0));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Empty/);
  });

  it("rejects oversized body", () => {
    const bytes = new Uint8Array(MAX_PROFILE_PHOTO_BYTES + 1);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    const result = validateProfilePhotoBytes(bytes.buffer);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /at most/);
  });

  it("rejects unsupported signatures regardless of size", () => {
    const result = validateProfilePhotoBytes(new Uint8Array([1, 2, 3, 4]).buffer);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Unsupported/);
  });
});

describe("validateContentLengthHeader", () => {
  it("allows missing Content-Length", () => {
    const result = validateContentLengthHeader(undefined);
    assert.deepEqual(result, { ok: true, value: null });
  });

  it("rejects Content-Length over the max", () => {
    const result = validateContentLengthHeader(
      String(MAX_PROFILE_PHOTO_BYTES + 1),
    );
    assert.equal(result.ok, false);
  });

  it("rejects invalid Content-Length", () => {
    const result = validateContentLengthHeader("abc");
    assert.equal(result.ok, false);
  });
});
