import { getDb } from "./db";
import { DBTokenStore, GarminClient } from "garmin-auth";
import {
  uploadFit,
  findActivityByStartTime,
  renameActivity,
  setDescription,
  type UploadResult,
} from "hevy2garmin";

export const GARMIN_TOKEN_PLATFORM = "garmin_tokens";

let cachedClient: GarminClient | null = null;
let normalized = false;

export async function normalizeGarminTokenRow(
  sql: ReturnType<typeof getDb>,
): Promise<void> {
  if (normalized) return;

  await sql`
    UPDATE platform_credentials
       SET credentials = jsonb_build_object(
         'garmin_tokens',
         credentials
       ),
       auth_type = 'oauth',
       status = 'active'
     WHERE platform = ${GARMIN_TOKEN_PLATFORM}
       AND credentials ? 'di_token'
       AND NOT (credentials ? 'garmin_tokens')
  `;

  normalized = true;
}

export async function getGarminClient(
  databaseUrl?: string,
): Promise<GarminClient> {
  if (cachedClient) return cachedClient;

  const url = databaseUrl ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL not set (cannot load Garmin tokens)");
  }

  const sql = getDb();

  const store = new DBTokenStore(
    url,
    GARMIN_TOKEN_PLATFORM,
  );

  const tokens = await store.load();

  if (!tokens) {
    throw new Error(
      "No Garmin DI tokens found. Connect Garmin again through the Garmin login worker.",
    );
  }

  const client = new GarminClient();

  client.loads(tokens);

  cachedClient = client;

  return client;
}

export function resetGarminClient(): void {
  cachedClient = null;
}

export async function findExistingActivity(
  client: GarminClient,
  startTime: string,
): Promise<number | null> {
  return findActivityByStartTime(client, startTime);
}

export async function upload(
  client: GarminClient,
  fit: Uint8Array,
  workoutStart?: string,
): Promise<UploadResult> {
  return uploadFit(client, fit, workoutStart);
}

export async function rename(
  client: GarminClient,
  activityId: number,
  name: string,
): Promise<void> {
  return renameActivity(client, activityId, name);
}

export async function describe(
  client: GarminClient,
  activityId: number,
  description: string,
): Promise<void> {
  return setDescription(client, activityId, description);
}
