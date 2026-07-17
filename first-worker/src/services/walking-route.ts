import type { Env } from "../env";

const ORS_DIRECTIONS_URL =
  "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";

/** Cache shared campus paths for a day — same stop set rarely changes mid-day. */
const CACHE_TTL_SEC = 86_400;

/** ORS free tier supports many waypoints; keep campus routes bounded. */
export const MAX_WALKING_STOPS = 25;

export type LatLng = {
  latitude: number;
  longitude: number;
};

export type WalkingRouteResult = {
  coordinates: LatLng[];
  /** `walking` = ORS sidewalk-ish geometry; `straight` = fallback between stops. */
  source: "walking" | "straight";
  cached: boolean;
  distanceMeters?: number;
  durationSeconds?: number;
};

export class WalkingRouteError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = "WalkingRouteError";
  }
}

function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function straightLine(stops: LatLng[]): WalkingRouteResult {
  return {
    coordinates: stops.map((s) => ({
      latitude: s.latitude,
      longitude: s.longitude,
    })),
    source: "straight",
    cached: false,
  };
}

export function normalizeStops(raw: unknown): LatLng[] {
  if (!Array.isArray(raw)) {
    throw new WalkingRouteError("stops must be an array", 400);
  }
  if (raw.length < 2) {
    throw new WalkingRouteError("At least 2 stops are required", 400);
  }
  if (raw.length > MAX_WALKING_STOPS) {
    throw new WalkingRouteError(
      `At most ${MAX_WALKING_STOPS} stops are allowed`,
      400,
    );
  }

  const stops: LatLng[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new WalkingRouteError("Each stop must be an object", 400);
    }
    const record = entry as Record<string, unknown>;
    const latitude = record.latitude;
    const longitude = record.longitude;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      throw new WalkingRouteError(
        "Each stop needs numeric latitude and longitude",
        400,
      );
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new WalkingRouteError("Stop coordinates must be finite numbers", 400);
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new WalkingRouteError("Stop coordinates out of range", 400);
    }
    stops.push({
      latitude: roundCoord(latitude),
      longitude: roundCoord(longitude),
    });
  }

  return stops;
}

async function cacheKey(stops: LatLng[]): Promise<string> {
  const payload = stops
    .map((s) => `${s.latitude},${s.longitude}`)
    .join(";");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `walking-route:v1:${hex}`;
}

type OrsGeoJson = {
  features?: Array<{
    geometry?: {
      type?: string;
      coordinates?: number[][];
    };
    properties?: {
      summary?: {
        distance?: number;
        duration?: number;
      };
    };
  }>;
  error?: { message?: string; code?: number };
};

function parseOrsGeoJson(body: OrsGeoJson): {
  coordinates: LatLng[];
  distanceMeters?: number;
  durationSeconds?: number;
} {
  const feature = body.features?.[0];
  const line = feature?.geometry?.coordinates;
  if (!Array.isArray(line) || line.length < 2) {
    throw new WalkingRouteError("OpenRouteService returned no route geometry");
  }

  const coordinates: LatLng[] = [];
  for (const pair of line) {
    if (!Array.isArray(pair) || pair.length < 2) {
      continue;
    }
    const longitude = pair[0];
    const latitude = pair[1];
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      continue;
    }
    coordinates.push({ latitude, longitude });
  }

  if (coordinates.length < 2) {
    throw new WalkingRouteError("OpenRouteService returned an empty path");
  }

  const summary = feature?.properties?.summary;
  return {
    coordinates,
    distanceMeters:
      typeof summary?.distance === "number" ? summary.distance : undefined,
    durationSeconds:
      typeof summary?.duration === "number" ? summary.duration : undefined,
  };
}

async function fetchOrsWalkingRoute(
  apiKey: string,
  stops: LatLng[],
): Promise<Omit<WalkingRouteResult, "cached" | "source">> {
  // ORS expects [longitude, latitude] pairs.
  const coordinates = stops.map((s) => [s.longitude, s.latitude]);

  const response = await fetch(ORS_DIRECTIONS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, application/geo+json",
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ coordinates }),
  });

  const text = await response.text();
  let body: OrsGeoJson = {};
  try {
    body = JSON.parse(text) as OrsGeoJson;
  } catch {
    throw new WalkingRouteError(
      `OpenRouteService returned non-JSON (${response.status})`,
    );
  }

  if (!response.ok) {
    const message =
      body.error?.message?.trim() ||
      `OpenRouteService request failed (${response.status})`;
    throw new WalkingRouteError(message);
  }

  return parseOrsGeoJson(body);
}

/**
 * Resolve a walking polyline for ordered campus stops.
 * Uses KV cache when possible; falls back to a straight polyline if ORS is
 * unavailable or the API key is not configured.
 */
export async function getWalkingRoute(
  env: Env,
  stops: LatLng[],
): Promise<WalkingRouteResult> {
  if (stops.length < 2) {
    return straightLine(stops);
  }

  const key = await cacheKey(stops);
  const cached = await env.RATE_LIMIT_KV.get<WalkingRouteResult>(key, "json");
  if (cached?.coordinates?.length && cached.source === "walking") {
    return { ...cached, cached: true };
  }

  const apiKey = env.OPENROUTESERVICE_API_KEY?.trim();
  if (!apiKey) {
    return straightLine(stops);
  }

  try {
    const routed = await fetchOrsWalkingRoute(apiKey, stops);
    const result: WalkingRouteResult = {
      ...routed,
      source: "walking",
      cached: false,
    };
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(result), {
      expirationTtl: CACHE_TTL_SEC,
    });
    return result;
  } catch (error) {
    console.error(
      "Walking route ORS failed; using straight fallback",
      error instanceof Error ? error.message : error,
    );
    return straightLine(stops);
  }
}
