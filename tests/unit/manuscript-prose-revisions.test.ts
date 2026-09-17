import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(process.cwd(), "drizzle", "0023_manuscript_prose_revisions.sql");

describe("Slice 24 Prose revision migration contract", () => {
  const migration = fs.readFileSync(migrationPath, "utf8");

  it("backfills every existing ProseBlock before removing legacy authority", () => {
    expect(migration).toMatch(/INSERT INTO [\s\S]*manuscript_prose_revisions[\s\S]*SELECT p\.\"project_id\", p\.\"id\", p\.\"text\", p\.\"updated_at\"/);
    expect(migration).toMatch(/mismatch_count/);
    expect(migration).toMatch(/DROP COLUMN \"text\"/);
    expect(migration).toMatch(/DROP COLUMN \"updated_at\"/);
    expect(migration.indexOf("mismatch_count")).toBeLessThan(migration.indexOf('DROP COLUMN "text"'));
  });

  it("defines derived sequence history and database integrity guards", () => {
    expect(migration).toMatch(/\"sequence\" bigint GENERATED ALWAYS AS IDENTITY/);
    expect(migration).toMatch(/manuscript_prose_revisions_insert_guard/);
    expect(migration).toMatch(/exact current revision text/);
    expect(migration).toMatch(/manuscript_prose_blocks_revision_complete/);
    expect(migration).toMatch(/Re-read persisted rows at commit/);
    expect(migration).toMatch(/manuscript_prose_revisions_append_only/);
  });

  it("retains nullable legacy review identity and requires exact identity for new Prose threads", () => {
    expect(migration).toMatch(/ADD COLUMN \"opening_prose_revision_id\" uuid/);
    expect(migration).toMatch(/project_opening_prose_revision_fk/);
    expect(migration).toMatch(/Opening Prose snapshot must match the exact current Prose revision/);
    expect(migration).toMatch(/Pre-Slice-24 Prose review threads must retain NULL revision identity/);
  });
});
