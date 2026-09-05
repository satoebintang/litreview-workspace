import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "./schema";

export function createDb(databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview") {
  const client = postgres(databaseUrl, { max: 5, prepare: false });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDb>["db"];
