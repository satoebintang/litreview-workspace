import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(() => ({})),
  drizzle: vi.fn(() => ({})),
}));

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));

import postgres from "postgres";
import { createDb } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  vi.clearAllMocks();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("database URL configuration", () => {
  it("uses an explicit createDb URL before DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://127.0.0.1:5432/env-db";

    createDb("postgres://127.0.0.1:5432/explicit-db");

    expect(postgres).toHaveBeenCalledWith("postgres://127.0.0.1:5432/explicit-db", {
      max: 5,
      prepare: false,
    });
  });

  it("uses nonblank DATABASE_URL when no explicit URL is provided", () => {
    process.env.DATABASE_URL = "postgres://127.0.0.1:5432/configured-db";

    createDb();

    expect(postgres).toHaveBeenCalledWith("postgres://127.0.0.1:5432/configured-db", {
      max: 5,
      prepare: false,
    });
  });

  it("treats a blank explicit URL as missing and falls back to DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://127.0.0.1:5432/configured-db";

    createDb("  ");

    expect(postgres).toHaveBeenCalledWith("postgres://127.0.0.1:5432/configured-db", {
      max: 5,
      prepare: false,
    });
  });

  it.each(["", "   ", undefined])("throws synchronously when DATABASE_URL is missing or blank (%j)", (value) => {
    if (value === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = value;

    expect(() => createDb()).toThrow("Database URL is missing");
    expect(postgres).not.toHaveBeenCalled();
  });

  it("prefers a nonblank Playwright admin URL over DATABASE_URL", () => {
    expect(resolveDatabaseUrl("admin-url", "database-url")).toBe("admin-url");
  });

  it("uses DATABASE_URL when the Playwright admin URL is blank", () => {
    expect(resolveDatabaseUrl("  ", "database-url")).toBe("database-url");
  });

  it("throws a concise configuration error when Playwright URLs are blank", () => {
    expect(() => resolveDatabaseUrl("  ", " ")).toThrow("Database URL is missing");
  });
});