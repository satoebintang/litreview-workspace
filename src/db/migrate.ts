import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

const { db, client } = createDb();

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.end();
}

main().catch(async (error) => {
  await client.end();
  console.error(error);
  process.exitCode = 1;
});
