/**
 * Service-level tests for profile photo upload/delete cleanup behavior.
 * Uses in-memory fakes for D1 and R2 (no Cloudflare account required).
 * Run: npx tsx --test src/services/profile-photo-service.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deleteProfilePhoto,
  uploadProfilePhoto,
} from "./profile-photo-service";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  avatar_key: string | null;
  avatar_content_type: string | null;
  avatar_updated_at: string | null;
  avatar_size_bytes: number | null;
};

function jpegBytes(size = 16): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.buffer;
}

function createFakeEnv() {
  const users = new Map<string, UserRow>();
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();

  const db = {
    prepare(sql: string) {
      const binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds.push(...args);
          return stmt;
        },
        async first<T>() {
          if (sql.includes("SELECT avatar_key")) {
            const id = binds[0] as string;
            const row = users.get(id);
            if (!row) return null;
            return {
              avatar_key: row.avatar_key,
              avatar_content_type: row.avatar_content_type,
              avatar_updated_at: row.avatar_updated_at,
              avatar_size_bytes: row.avatar_size_bytes,
            } as T;
          }
          if (sql.includes("COUNT(avatar_key)")) {
            const active = [...users.values()].filter((row) => row.avatar_key);
            return {
              object_count: active.length,
              bytes_stored: active.reduce(
                (total, row) => total + (row.avatar_size_bytes ?? 0),
                0,
              ),
            } as T;
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO users")) {
            const [id, email] = binds as [string, string, string | null, number];
            const existing = users.get(id);
            if (!existing) {
              users.set(id, {
                id,
                email,
                name: null,
                avatar_key: null,
                avatar_content_type: null,
                avatar_updated_at: null,
                avatar_size_bytes: null,
              });
            }
            return { success: true };
          }
          if (sql.includes("SET avatar_key = ?")) {
            const [key, contentType, updatedAt, size, id] = binds as [
              string,
              string,
              string,
              number,
              string,
            ];
            const row = users.get(id);
            if (!row) throw new Error("user missing");
            row.avatar_key = key;
            row.avatar_content_type = contentType;
            row.avatar_updated_at = updatedAt;
            row.avatar_size_bytes = size;
            return { success: true };
          }
          if (sql.includes("SET avatar_key = NULL")) {
            const [id] = binds as [string];
            const row = users.get(id);
            if (row) {
              row.avatar_key = null;
              row.avatar_content_type = null;
              row.avatar_updated_at = null;
              row.avatar_size_bytes = null;
            }
            return { success: true };
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  const bucket = {
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, {
        body,
        contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
      });
      return { key, size: body.byteLength, etag: `"${key}"` };
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) {
        objects.delete(k);
      }
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(obj.body);
            controller.close();
          },
        }),
        httpMetadata: { contentType: obj.contentType },
        httpEtag: `"${key}"`,
        uploaded: new Date(),
        size: obj.body.byteLength,
      };
    },
  };

  return {
    env: {
      DB: db as unknown as D1Database,
      PROFILE_PHOTOS: bucket as unknown as R2Bucket,
    },
    users,
    objects,
  };
}

describe("uploadProfilePhoto", () => {
  it("stores object under a server-generated key and updates D1", async () => {
    const { env, users, objects } = createFakeEnv();
    const result = await uploadProfilePhoto(
      env,
      { id: "user-1", email: "a@b.com" },
      jpegBytes(),
    );

    assert.ok(!("status" in result));
    if ("status" in result) return;

    const row = users.get("user-1");
    assert.ok(row?.avatar_key?.startsWith("users/user-1/avatar/"));
    assert.equal(row?.avatar_content_type, "image/jpeg");
    assert.equal(objects.size, 1);
    assert.ok(objects.has(row!.avatar_key!));
  });

  it("deletes the previous object after a successful replacement", async () => {
    const { env, users, objects } = createFakeEnv();
    const first = await uploadProfilePhoto(env, { id: "user-1" }, jpegBytes());
    assert.ok(!("status" in first));
    const oldKey = users.get("user-1")!.avatar_key!;

    const second = await uploadProfilePhoto(env, { id: "user-1" }, jpegBytes());
    assert.ok(!("status" in second));
    const newKey = users.get("user-1")!.avatar_key!;

    assert.notEqual(oldKey, newKey);
    assert.equal(objects.has(oldKey), false);
    assert.equal(objects.has(newKey), true);
    assert.equal(objects.size, 1);
  });

  it("compensates by deleting the new R2 object when D1 update fails", async () => {
    const { env, objects } = createFakeEnv();
    const failingDb = {
      prepare(sql: string) {
        const binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds.push(...args);
            return stmt;
          },
          async first() {
            return {
              avatar_key: null,
              avatar_content_type: null,
              avatar_updated_at: null,
              avatar_size_bytes: null,
            };
          },
          async run() {
            if (sql.includes("INSERT INTO users")) return { success: true };
            if (sql.includes("SET avatar_key = ?")) {
              throw new Error("d1 down");
            }
            return { success: true };
          },
        };
        return stmt;
      },
    };

    const result = await uploadProfilePhoto(
      { DB: failingDb as unknown as D1Database, PROFILE_PHOTOS: env.PROFILE_PHOTOS },
      { id: "user-1" },
      jpegBytes(),
    );

    assert.equal("status" in result && result.status, 500);
    assert.equal(objects.size, 0);
  });

  it("rejects unsupported bytes", async () => {
    const { env } = createFakeEnv();
    const result = await uploadProfilePhoto(
      env,
      { id: "user-1" },
      new Uint8Array([0, 1, 2, 3]).buffer,
    );
    assert.equal("status" in result && result.status, 415);
  });

  it("rejects uploads that would exceed the application storage quota", async () => {
    const { env, objects } = createFakeEnv();
    const quotaEnv = {
      ...env,
      PROFILE_PHOTO_STORAGE_QUOTA_BYTES: String(5 * 1024 * 1024),
    };
    const first = await uploadProfilePhoto(
      quotaEnv,
      { id: "user-1" },
      jpegBytes(3 * 1024 * 1024),
    );
    assert.ok(!("status" in first));

    const second = await uploadProfilePhoto(
      quotaEnv,
      { id: "user-2" },
      jpegBytes(3 * 1024 * 1024),
    );
    assert.equal("status" in second && second.status, 507);
    assert.equal(objects.size, 1);
  });
});

describe("deleteProfilePhoto", () => {
  it("clears D1 and removes the R2 object", async () => {
    const { env, users, objects } = createFakeEnv();
    await uploadProfilePhoto(env, { id: "user-1" }, jpegBytes());
    assert.equal(objects.size, 1);

    const result = await deleteProfilePhoto(env, { id: "user-1" });
    assert.deepEqual(result, { deleted: true });
    assert.equal(users.get("user-1")!.avatar_key, null);
    assert.equal(objects.size, 0);
  });

  it("is idempotent when no photo exists", async () => {
    const { env } = createFakeEnv();
    const result = await deleteProfilePhoto(env, { id: "user-1" });
    assert.deepEqual(result, { deleted: false });
  });
});
