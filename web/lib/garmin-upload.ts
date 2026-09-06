/**
 * Garmin upload wrappers.
 *
 * Garmin DI tokens are stored in platform_credentials under
 * platform='garmin_tokens'. Authentication is performed from those
 * stored DI tokens; the Cloudflare Worker is responsible for obtaining
 * fresh tokens during the Garmin login flow.
 */
import { getDb } from "./db";
import { GarminAuth, DBTokenStore, type GarminClient } from "garmin-auth";
import {
  uploadFit,
  findActivityByStartTime,
  renameActivity,
  setDescription,
  type UploadResult,
} from "hevy2garmin";

/** The DI tokens live in platform_credentials at this platform key. */
export const GARMIN_TOKEN_PLATFORM = "garmin_tokens";

let cachedClient: GarminClient | null = null;
let normalized = false;

/**
 * Convert an older flat DI-token row into the nested format expected by
 * garmin-auth's DBTokenStore.
 *
 * Older versions stored:
 *   { di_token, ... }
 *
 * Current versions expect:
 *   { garmin_tokens: { di_token, ... } }
 */
export async function normalizeGarminTokenRow(
  sql: ReturnType<typeof getDb>,
): Promise<void> {
  if (normalized) return;

  try {
    await sql`
      UPDATE platform_credentials
      SET
        credentials = jsonb_build_object('garmin_tokens', credentials),
        auth_type = 'oauth',
        status = 'connected'
      WHERE platform = ${GARMIN_TOKEN_PLATFORM}
        AND credentials ? 'di_token'
        AND NOT (credentials ? 'garmin_tokens')
    `;

    normalized = true;
  } catch {
    // DBTokenStore will surface the real authentication/database error.
  }
}

/**
 * Build an authenticated Garmin client from the DI tokens already stored
 * in Postgres.
 *
 * IMPORTANT:
 * Garmin login itself is NOT performed here. Garmin login/MFA is handled
 * by the Cloudflare Worker during /api/garmin-login. This function only
 * consumes the resulting DI tokens.
 */
export async function getGarminClient(
  databaseUrl?: string,
): Promise<GarminClient> {
  if (cachedClient) return cachedClient;

  const url = databaseUrl ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL not set (cannot load Garmin tokens)");
  }

  const sql = getDb();

  await normalizeGarminTokenRow(sql);

  const store = new DBTokenStore(url, GARMIN_TOKEN_PLATFORM);

  try {
    const auth = new GarminAuth({ store });
    cachedClient = await auth.client();
    return cachedClient;
  } catch (err) {
    cachedClient = null;

    const message = err instanceof Error ? err.message : String(err);

    // Make the required recovery action explicit instead of disguising the
    // Garmin authentication failure as a generic sync failure.
    if (
      message.toLowerCase().includes("mfa") ||
      message.toLowerCase().includes("fresh sso") ||
      message.toLowerCase().includes("login needs")
    ) {
      throw new Error(
        "Garmin authentication has expired. Go to Settings → Garmin, " +
        "disconnect Garmin, then reconnect using the Cloudflare Worker login " +
        "before syncing again.",
      );
    }

    throw err;
  }
}

/** Reset the cached client after Garmin credentials are rotated. */
export function resetGarminClient(): void {
  cachedClient = null;
}

/**
 * READ: check whether a Garmin activity already exists at this start time.
 * This is the duplicate-prevention lookup and does not write anything.
 */
export async function findExistingActivity(
  client: GarminClient,
  startTime: string,
): Promise<number | null> {
  return findActivityByStartTime(client, startTime);
}

/**
 * WRITE: upload a FIT file to Garmin.
 */
export async function upload(
  client: GarminClient,
  fit: Uint8Array,
  workoutStart?: string,
): Promise<UploadResult> {
  return uploadFit(client, fit, workoutStart);
}

/** WRITE: rename a Garmin activity. */
export async function rename(
  client: GarminClient,
  activityId: number,
  name: string,
): Promise<void> {
  return renameActivity(client, activityId, name);
}

/** WRITE: set a Garmin activity description. */
export async function describe(
  client: GarminClient,
  activityId: number,
  description: string,
): Promise<void> {
  return setDescription(client, activityId, description);
}
