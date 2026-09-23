import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMigrationManifest,
  comparePublicSchema,
  derivePublicSchema,
  formatPublicSchemaDiff,
  getLatestSnapshotPath,
  getMigrationRowMismatches,
  type MigrationJournal,
} from "../e2e/playwright-schema-contract";

function journal(entries: MigrationJournal["entries"]): MigrationJournal {
  return { version: "7", entries };
}

describe("Playwright migration and schema contract", () => {
  it("builds hashes from journal order and compares the complete applied migration tail", () => {
    const expected = buildMigrationManifest(journal([
      { idx: 0, version: "7", when: 100, tag: "0000_initial", breakpoints: true },
      { idx: 1, version: "7", when: 200, tag: "0001_hardening", breakpoints: true },
    ]), (tag) => Buffer.from(`${tag} SQL`));

    expect(expected.map(({ id, tag }) => ({ id, tag }))).toEqual([
      { id: 1, tag: "0000_initial" },
      { id: 2, tag: "0001_hardening" },
    ]);
    expect(getMigrationRowMismatches(expected, expected.map(({ id, hash, when }) => ({ id, hash, created_at: when })))).toEqual([]);
    expect(getMigrationRowMismatches(expected, expected.slice(0, 1).map(({ id, hash, when }) => ({ id, hash, created_at: when })))).toContain("0001_hardening is missing");
  });

  it("updates the expected migration tail and hash when a synthetic journal entry is appended", () => {
    const initial = { idx: 0, version: "7", when: 100, tag: "0000_initial", breakpoints: true };
    const baseJournal = journal([initial]);
    const extendedJournal = journal([
      initial,
      { idx: 1, version: "7", when: 200, tag: "0001_synthetic_tail", breakpoints: true },
    ]);
    const sqlByTag: Record<string, Uint8Array> = {
      "0000_initial": Buffer.from("initial SQL"),
      "0001_synthetic_tail": Buffer.from("synthetic SQL"),
    };
    const readSql = (tag: string) => sqlByTag[tag];
    const base = buildMigrationManifest(baseJournal, readSql);
    const extended = buildMigrationManifest(extendedJournal, readSql);

    expect(base).toHaveLength(1);
    expect(extended).toHaveLength(2);
    expect(extended.at(-1)).toMatchObject({ idx: 1, id: 2, tag: "0001_synthetic_tail" });
    expect(extended.at(-1)?.hash).not.toBe(base.at(-1)?.hash);
    const rowsBeforeTail = base.map(({ id, hash, when }) => ({ id, hash, created_at: when }));
    expect(getMigrationRowMismatches(extended, rowsBeforeTail)).toContain("0001_synthetic_tail is missing");
    expect(getLatestSnapshotPath("drizzle", extended)).toMatch(/[\\/]meta[\\/]0001_snapshot\.json$/);
  });

  it("rejects journal entries that do not preserve contiguous Drizzle order", () => {
    expect(() => buildMigrationManifest(journal([
      { idx: 1, version: "7", when: 100, tag: "0001_wrong_order", breakpoints: true },
    ]), () => Buffer.from("SQL"))).toThrow(/journal order is invalid/);
  });

  it("derives only public table and column names from the latest snapshot", () => {
    const schema = derivePublicSchema({
      tables: {
        "public.projects": {
          name: "projects",
          columns: { id: { name: "id" }, title: { name: "title" } },
        },
        "internal.metadata": {
          name: "metadata",
          columns: { detail: { name: "detail" } },
        },
      },
    });

    expect(schema).toEqual({ projects: ["id", "title"] });
  });

  it("loads the public schema contract from the current journal tail snapshot", () => {
    const migrationFolder = path.resolve(process.cwd(), "drizzle");
    const currentJournal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as MigrationJournal;
    const migrations = buildMigrationManifest(currentJournal, (tag) => fs.readFileSync(path.join(migrationFolder, `${tag}.sql`)));
    const snapshotPath = getLatestSnapshotPath(migrationFolder, migrations);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

    expect(derivePublicSchema(snapshot)).toMatchObject({
      retrieved_records: expect.arrayContaining(["id", "source_record_id", "doi"]),
    });
  });

  it("reports missing and unexpected public tables and columns", () => {
    const diff = comparePublicSchema({ papers: ["id", "title"], projects: ["id"] }, [
      { table_name: "papers", column_name: "id" },
      { table_name: "papers", column_name: "abstract" },
      { table_name: "extra", column_name: "id" },
    ]);

    expect(formatPublicSchemaDiff(diff)).toEqual([
      "missing table projects",
      "unexpected table extra",
      "missing column papers.title",
      "missing column projects.id",
      "unexpected column papers.abstract",
    ]);
  });
});
