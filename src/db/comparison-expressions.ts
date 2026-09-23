import { sql, type SQLWrapper } from "drizzle-orm";

/**
 * Canonical DOI comparison expression released for acquisition deduplication.
 * Keep the outer btrim and both prefix-removal patterns aligned with the
 * PostgreSQL candidate queries and the retrieved-record comparison index.
 */
export function retrievedRecordDoiComparison(column: SQLWrapper) {
  return sql`btrim(lower(regexp_replace(regexp_replace(btrim(${column}), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))`;
}
