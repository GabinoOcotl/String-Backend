/**
 * End-to-end verification for section groupchat:
 * join section → room appears → send/receive messages (+ WebSocket broadcast).
 *
 * Requires `npx wrangler dev` running (default http://127.0.0.1:8787).
 *
 * Run: npx tsx scripts/verify-section-chat-e2e.ts
 * Remote D1 migrations: npx tsx scripts/verify-section-chat-e2e.ts --remote
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sectionRoomId } from "../src/services/room-service";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const SECTION = {
  subjectCode: "600",
  courseId: "011598",
  enrollmentClassNumber: 30995,
  courseDesignation: "MATH 112 (E2E)",
} as const;

type SupabaseAuthResponse = {
  access_token?: string;
  user?: { id: string; email?: string };
  error_description?: string;
  msg?: string;
};

type RoomThread = {
  id: string;
  name: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
};

type ChatMessage = {
  id: string;
  room_id: string;
  user_id: string;
  text: string;
  created_at: string;
  sender_name: string;
  is_own: boolean;
};

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

function getSupabaseConfig(): { url: string; anonKey: string } {
  const frontendEnv = loadEnvFile(
    resolve(__dirname, "../../../String_App_Frontend/String/.env"),
  );
  const url =
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    frontendEnv.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    frontendEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase config. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  return { url, anonKey };
}

async function applyMigrationsWithWrangler(remote: boolean): Promise<void> {
  const migrationsDir = resolve(__dirname, "../migrations");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const remoteFlag = remote ? "--remote" : "--local";

  for (const file of files) {
    const { execSync } = await import("node:child_process");
    try {
      execSync(
        `npx wrangler d1 execute first-worker-db ${remoteFlag} --file "${resolve(migrationsDir, file)}"`,
        { stdio: "pipe", cwd: resolve(__dirname, "..") },
      );
    } catch (error) {
      const output = [
        (error as { stdout?: Buffer }).stdout?.toString() ?? "",
        (error as { stderr?: Buffer }).stderr?.toString() ?? "",
      ].join("\n");
      if (
        output.includes("duplicate column name") ||
        output.includes("already exists")
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function supabaseSignUp(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const body = (await response.json()) as SupabaseAuthResponse;
    const message = body.error_description ?? body.msg ?? response.statusText;
    throw new Error(`Supabase sign-up failed: ${message}`);
  }
}

async function supabaseSignIn(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<{ accessToken: string }> {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );

  const body = (await response.json()) as SupabaseAuthResponse;
  if (!response.ok || !body.access_token) {
    const message = body.error_description ?? body.msg ?? response.statusText;
    throw new Error(`Supabase sign-in failed: ${message}`);
  }

  return { accessToken: body.access_token };
}

async function apiFetch<T>(
  baseUrl: string,
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      try {
        message = await response.text();
      } catch {
        // ignore
      }
    }
    throw new Error(`${path} failed: ${message}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function waitForWebSocketMessage(
  ws: WebSocket,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    ws.onmessage = (event) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (err) {
        reject(err);
      } finally {
        ws.close();
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    };
  });
}

async function runHttpFlow(baseUrl: string): Promise<void> {
  const { url: supabaseUrl, anonKey } = getSupabaseConfig();
  const stamp = Date.now();
  const password = `E2e-${stamp}!`;
  const user1Email = `e2e-user1-${stamp}@example.com`;
  const user2Email = `e2e-user2-${stamp}@example.com`;

  console.log(`\n=== HTTP flow (${baseUrl}) ===`);
  console.log("Creating test users via Supabase…");

  await supabaseSignUp(supabaseUrl, anonKey, user1Email, password);
  await supabaseSignUp(supabaseUrl, anonKey, user2Email, password);

  const user1 = await supabaseSignIn(supabaseUrl, anonKey, user1Email, password);
  const user2 = await supabaseSignIn(supabaseUrl, anonKey, user2Email, password);

  console.log("1. Join section room (user 1)");
  const joined = await apiFetch<{
    roomId: string;
    name: string;
    joined: true;
  }>(baseUrl, "/rooms/join", user1.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(SECTION),
  });

  const expectedRoomId = sectionRoomId(
    SECTION.subjectCode,
    SECTION.courseId,
    SECTION.enrollmentClassNumber,
  );
  if (joined.roomId !== expectedRoomId) {
    throw new Error(`Expected roomId ${expectedRoomId}, got ${joined.roomId}`);
  }

  console.log("2. Room appears in GET /rooms");
  const rooms = await apiFetch<RoomThread[]>(baseUrl, "/rooms", user1.accessToken);
  if (!rooms.some((room) => room.id === expectedRoomId)) {
    throw new Error(`Room ${expectedRoomId} not found in thread list`);
  }

  console.log("3. User 2 joins same section");
  await apiFetch(baseUrl, "/rooms/join", user2.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(SECTION),
  });

  console.log("4. User 2 connects WebSocket");
  const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/chat/${encodeURIComponent(expectedRoomId)}?token=${encodeURIComponent(user2.accessToken)}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed to connect"));
    };
  });

  const messageText = `HTTP E2E hello ${stamp}`;
  const wsWait = waitForWebSocketMessage(ws, 10_000);

  console.log("5. User 1 sends message");
  const sent = await apiFetch<ChatMessage>(baseUrl, "/messages", user1.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: expectedRoomId, text: messageText }),
  });

  console.log("6. User 2 receives live WebSocket broadcast");
  const wsEvent = (await wsWait) as {
    type?: string;
    payload?: { id: string; text: string };
  };
  if (wsEvent.type !== "message" || wsEvent.payload?.id !== sent.id) {
    throw new Error("WebSocket did not receive the sent message");
  }

  console.log("7. User 2 fetches message history");
  const history = await apiFetch<ChatMessage[]>(
    baseUrl,
    `/messages/${encodeURIComponent(expectedRoomId)}`,
    user2.accessToken,
  );
  const received = history.find((message) => message.id === sent.id);
  if (!received || received.text !== messageText || received.is_own) {
    throw new Error("User 2 did not see user 1's message in history");
  }

  console.log("8. User 1 leaves section");
  await apiFetch<void>(
    baseUrl,
    `/rooms/${encodeURIComponent(expectedRoomId)}/membership`,
    user1.accessToken,
    { method: "DELETE" },
  );

  const roomsAfterLeave = await apiFetch<RoomThread[]>(
    baseUrl,
    "/rooms",
    user1.accessToken,
  );
  if (roomsAfterLeave.some((room) => room.id === expectedRoomId)) {
    throw new Error("Room still listed for user 1 after leaving");
  }

  console.log("HTTP flow OK");
}

async function main(): Promise<void> {
  const useRemote = process.argv.includes("--remote");
  const skipMigrations = process.argv.includes("--skip-migrations");
  const baseUrl = (
    process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1] ??
    process.env.WORKER_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");

  if (!skipMigrations) {
    console.log(`Applying migrations to ${useRemote ? "remote" : "local"} D1…`);
    await applyMigrationsWithWrangler(useRemote);
  }

  const health = await fetch(`${baseUrl}/`);
  if (!health.ok) {
    throw new Error(
      `Worker not reachable at ${baseUrl}. Start it with: npx wrangler dev --port 8787`,
    );
  }

  await runHttpFlow(baseUrl);
  console.log("\nSECTION CHAT E2E OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
