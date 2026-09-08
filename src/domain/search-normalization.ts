/** Canonical source definitions used when a Project receives its built-ins.
 * Keep these values aligned with the migration's seed/insert trigger. */
export const SEARCH_SOURCE_DEFINITIONS = [
  { sourceKey: "scopus", displayName: "Scopus" },
  { sourceKey: "web_of_science", displayName: "Web of Science" },
  { sourceKey: "ieee_xplore", displayName: "IEEE Xplore" },
  { sourceKey: "pubmed", displayName: "PubMed" },
  { sourceKey: "google_scholar", displayName: "Google Scholar" },
  { sourceKey: "openalex", displayName: "OpenAlex" },
  { sourceKey: "semantic_scholar", displayName: "Semantic Scholar" },
  { sourceKey: "manual", displayName: "Manual" },
] as const;

/** DOI normalization is for comparison and indexing only. It never changes
 * the DOI stored as provenance on a Paper or RetrievedRecord. Keep this in
 * lockstep with the PostgreSQL expressions in the acquisition migrations:
 * trim, lowercase, remove the approved anchored prefix, then trim again. */
export function normalizeDoiForComparison(value: string | null | undefined): string | null {
  if (value == null) return null;
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  normalized = normalized.replace(/^doi:\s*/, "");
  normalized = normalized.trim();
  return normalized.length > 0 ? normalized : null;
}

/** Title normalization intentionally does not remove punctuation, fold accents,
 * normalize Unicode, or infer tokens. It is exactly the SQL comparison rule. */
export function normalizeTitleForComparison(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

export function normalizeSearchComparison(value: { doi?: string | null; title?: string | null }) {
  return {
    doi: normalizeDoiForComparison(value.doi),
    title: normalizeTitleForComparison(value.title),
  };
}
