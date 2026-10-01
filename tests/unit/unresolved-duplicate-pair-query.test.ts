import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { unresolvedDuplicatePairCtes } from "@/application/unresolved-duplicate-pair-query";
import { retrievedRecordDoiComparison } from "@/db/comparison-expressions";

const dialect = new PgDialect();

describe("unresolved retrieved-record pair query contract", () => {
  it("uses the released DOI normalization with its outer trim and unchanged regex arguments", () => {
    const expression = dialect.sqlToQuery(retrievedRecordDoiComparison(sql.raw("a.doi"))).sql;
    expect(expression).toBe("btrim(lower(regexp_replace(regexp_replace(btrim(a.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))");
  });

  it("uses shared released candidate predicates, including blank-title behavior, and an all-history anti-join", () => {
    const query = dialect.sqlToQuery(unresolvedDuplicatePairCtes("00000000-0000-0000-0000-000000000034")).sql.toLowerCase();
    expect(query).toContain("candidate_pairs as (");
    expect(query).toContain("a.project_id = $1");
    expect(query).toContain("a.id < b.id");
    expect(query).toContain("a.search_source_id = b.search_source_id");
    expect(query).toContain("a.source_record_id = b.source_record_id");
    expect(query).toContain("b.publication_year = a.publication_year");
    expect(query).not.toContain("btrim(a.title) <> ''");
    expect(query).toMatch(/\bor\b/);
    expect(query).toContain("where not exists");
  });

  it("limits migration 0032 to the two approved index changes", () => {
    const migration = readFileSync(new URL("../../drizzle/0032_hot_path_hardening.sql", import.meta.url), "utf8");
    const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^DROP INDEX "retrieved_records_project_doi_comparison_idx"/);
    expect(statements[1]).toContain('CREATE INDEX "retrieved_records_project_source_record_comparison_idx"');
    expect(statements[2]).toContain('CREATE INDEX "retrieved_records_project_doi_comparison_idx"');
    expect(migration).not.toMatch(/CREATE TABLE|ALTER TABLE|\bUPDATE\b|\bINSERT\b/i);
  });
});
