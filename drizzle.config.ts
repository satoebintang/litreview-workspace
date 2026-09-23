import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
  throw new Error("DATABASE_URL must be configured to a nonblank value for Drizzle commands.");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});