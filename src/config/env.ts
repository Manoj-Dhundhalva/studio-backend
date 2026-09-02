import dotenv from "dotenv";
import { z } from "zod";

export const APP_STAGE = {
  STAGING: "staging",
  PROD: "prod",
} as const;

process.env.APP_STAGE = process.env.APP_STAGE || APP_STAGE.STAGING;

const isDevelopment = process.env.APP_STAGE === APP_STAGE.STAGING;

// Load environment-specific .env files
if (isDevelopment) {
  dotenv.config({ path: ".env.staging", override: true });
}

const envSchema = z.object({
  APP_STAGE: z.enum([APP_STAGE.STAGING, APP_STAGE.PROD]).default(APP_STAGE.STAGING),

  PORT: z.coerce.number().positive().default(3000),

  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),

  ACCESS_TOKEN_SECRET: z.string(),
  ACCESS_TOKEN_EXPIRE: z.string(),

  CLIENT_URL: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol), {
    message: "CLIENT_URL must use http:// or https://",
  }),

  // Public origin of this API. Google's OAuth callbackURL is built from it, so it
  // must match the redirect URI registered in the Google Cloud console.
  SERVER_URL: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol), {
    message: "SERVER_URL must use http:// or https://",
  }),

  DATABASE_URL: z.url().check((ctx) => {
    const protocol = new URL(ctx.value).protocol;

    if (!["postgres:", "postgresql:"].includes(protocol)) {
      ctx.issues.push({
        code: "custom",
        message: "DATABASE_URL must be a PostgreSQL connection string",
        input: ctx.value,
      });
    }
  }),

  RATE_LIMIT_WINDOW: z.coerce
    .number()
    .positive()
    .default(60 * 1000), // 1 min

  // How often dirty canvas state is bulk-written to Postgres. This interval is
  // what stops a 60fps drag from becoming 60 writes/second — every event in the
  // window collapses into a single row update.
  CANVAS_FLUSH_INTERVAL: z.coerce.number().positive().default(2000),

  // Idle projects (no live members, nothing dirty) are dropped from the
  // in-memory cache after this long, so a long-lived server stays bounded.
  CANVAS_CACHE_TTL: z.coerce
    .number()
    .positive()
    .default(5 * 60 * 1000), // 5 min

  MAX_ELEMENTS_PER_CANVAS: z.coerce.number().positive().default(500),

  // Uploads panel media storage. Left unset in staging until a real Cloudinary
  // account is created — upload requests fail at call time until then, but the
  // server still boots (no `.min(1)`, so an empty string still validates).
  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),

  SHUTDOWN_TIMEOUT: z.coerce.number().positive().default(10 * 1000),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables\n");

  const tree = z.treeifyError(result.error);
  console.error(JSON.stringify(tree, null, 2));

  console.error("\nValidation Errors:");

  result.error.issues.forEach((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    console.error(`  • ${path}: ${issue.message}`);
  });

  process.exit(1);
}

export const env = result.data;

export type Env = typeof env;

export const isProdEnv = () => env.APP_STAGE === APP_STAGE.PROD;
export const isDevEnv = () => env.APP_STAGE === APP_STAGE.STAGING;

export default env;
