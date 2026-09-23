import "dotenv/config";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { resolveDatabaseUrl } from "./src/db/config";

resolveDatabaseUrl();

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
