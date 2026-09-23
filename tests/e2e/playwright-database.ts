import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { resolveDatabaseUrl } from "../../src/db/config";

type PlaywrightDatabaseMarker = { databaseName?: unknown };

export function databaseUrlForName(adminUrl: string, databaseName: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(databaseName)) {
    throw new Error("Playwright database marker has an invalid database name");
  }
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  return target.toString();
}

export function resolvePlaywrightTestDatabaseUrl(
  markerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json"),
  explicitAdminUrl = process.env.PLAYWRIGHT_ADMIN_DATABASE_URL,
  configuredDatabaseUrl = process.env.DATABASE_URL,
): string {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as PlaywrightDatabaseMarker;
  if (typeof marker.databaseName !== "string") {
    throw new Error("Playwright database marker is missing its database name");
  }

  return databaseUrlForName(
    resolveDatabaseUrl(explicitAdminUrl, configuredDatabaseUrl),
    marker.databaseName,
  );
}

export function createPlaywrightTestDatabaseClient(options: { prepare?: boolean } = {}) {
  return postgres(resolvePlaywrightTestDatabaseUrl(), { max: 1, ...options });
}
