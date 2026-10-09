import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("fast verification preflight", () => {
  it("passes with database URL variables absent and never opens a database connection", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.PLAYWRIGHT_ADMIN_DATABASE_URL;
    const script = path.resolve(process.cwd(), "scripts", "verification-preflight.mjs");
    const output = execFileSync(process.execPath, [script, "--mode", "fast"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });

    expect(output).toContain("Preflight mode: fast");
    expect(output).toContain("DATABASE_URL=absent");
    expect(output).toContain("PLAYWRIGHT_ADMIN_DATABASE_URL=absent");
    expect(output).toContain("Preflight passed: fast.");
    expect(output).not.toContain("Database connectivity:");
  });
});
