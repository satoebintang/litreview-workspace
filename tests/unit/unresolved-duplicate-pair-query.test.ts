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

  it("generates three project-scoped branches joined by UNION and an all-history anti-join", () => {
    const query = dialect.sqlToQuery(unresolvedDuplicatePairCtes("00000000-0000-0000-0000-000000000034")).sql.toLowerCase();
    expect(query.match(/\bunion\b/g)).toHaveLength(2);
    expect(query.match(/join\s+retrieved_records\s+b/g)).toHaveLength(3);
    expect(query.match(/a\.project_id\s*=\s*\$\d/g)).toHaveLength(3);
    expect(query.match(/a\.id\s*<\s*b\.id/g)).toHaveLength(3);
    expect(query).toContain("b.search_source_id = a.search_source_id");
    expect(query).toContain("b.source_record_id = a.source_record_id");
    expect(query).toContain("b.publication_year = a.publication_year");
    expect(query).toContain("where not exists");
    expect(query).not.toMatch(/\bor\b/);
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
