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

  CODEFORCES_BASE_URL: z.url().default("https://codeforces.com"),

  WEB_SCRAPER_API_URL: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol), {
    message: "WEB_SCRAPER_API_URL must use http:// or https://",
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
