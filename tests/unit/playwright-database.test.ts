import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePlaywrightTestDatabaseUrl } from "../e2e/playwright-database";

const temporaryDirectories: string[] = [];

function writeMarker(databaseName: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-playwright-db-"));
  temporaryDirectories.push(directory);
  const markerPath = path.join(directory, "playwright-db.json");
  fs.writeFileSync(markerPath, JSON.stringify({ databaseName, storageRoot: "unused" }));
  return markerPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Playwright disposable database URL", () => {
  it("uses the explicit admin URL and replaces only its database path", () => {
    const markerPath = writeMarker("litreview_playwright_case_123");

    const result = resolvePlaywrightTestDatabaseUrl(
      markerPath,
      "postgres://playwright:secret@db.example:5433/admin?sslmode=require",
      "postgres://fallback:secret@fallback.example:5432/app",
    );

    const target = new URL(result);
    expect(target.hostname).toBe("db.example");
    expect(target.port).toBe("5433");
    expect(target.pathname).toBe("/litreview_playwright_case_123");
    expect(target.searchParams.get("sslmode")).toBe("require");
  });

  it("uses DATABASE_URL when the explicit admin URL is blank", () => {
    const markerPath = writeMarker("litreview_playwright_case_456");

    const result = resolvePlaywrightTestDatabaseUrl(
      markerPath,
      "  ",
      "postgres://fallback:secret@fallback.example:5432/app",
    );

    expect(new URL(result).hostname).toBe("fallback.example");
    expect(new URL(result).pathname).toBe("/litreview_playwright_case_456");
  });

  it("fails closed without a configured admin URL or with an invalid marker name", () => {
    const markerPath = writeMarker("litreview_playwright_case_789");
    expect(() => resolvePlaywrightTestDatabaseUrl(markerPath, " ", "\t")).toThrow(/DATABASE_URL/i);
    const invalidMarkerPath = writeMarker("../litreview");
    expect(() => resolvePlaywrightTestDatabaseUrl(invalidMarkerPath, "postgres://admin@localhost:5432/db", "")).toThrow(/database name/i);
  });
});
