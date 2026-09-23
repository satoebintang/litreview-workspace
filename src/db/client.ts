import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "./schema";
import { resolveDatabaseUrl } from "./config";

export function createDb(databaseUrl?: string) {
  const client = postgres(resolveDatabaseUrl(databaseUrl), { max: 5, prepare: false });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDb>["db"];
