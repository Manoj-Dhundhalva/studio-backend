import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env, isProdEnv } from "@/config/env.js";
import { remember } from "@epic-web/remember";

const createPool = () => {
  return new Pool({
    connectionString: env.DATABASE_URL,
  });
};

let client;

if (isProdEnv()) {
  client = createPool();
} else {
  client = remember("dbPool", () => createPool());
}

export const db = drizzle({ client });
