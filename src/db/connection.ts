import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env, isProdEnv } from "@/config/env.js";
import { remember } from "@epic-web/remember";

const createPool = (): Pool => {
  return new Pool({
    connectionString: env.DATABASE_URL,
  });
};

export const pool: Pool = isProdEnv() ? createPool() : remember("dbPool", () => createPool());

export const db = drizzle({ client: pool });

/**
 * Drains the pool. Only the shutdown hook should call this, and only after the
 * final cache flush — exporting the drain rather than the pool itself keeps
 * "who is allowed to end the pool" answerable by grep.
 */
export const closeDbPool = async (): Promise<void> => {
  await pool.end();
};
