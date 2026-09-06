import type {
  CitationFormatContext,
  CitationInput,
  CitationMetadataWarning,
  CitationStyle,
  ManuscriptCitationRecord,
} from "./types";

export function normalizeCitationInput(input: CitationInput): CitationInput {
  return {
    paperId: input.paperId,
    title: input.title.trim(),
    authors: input.authors.map((author) => author.trim()).filter((author) => author.length > 0),
    publicationYear: input.publicationYear,
    venue: normalizeOptional(input.venue),
    doi: normalizeOptional(input.doi),
  };
}

function normalizeOptional(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizedRecord(record: ManuscriptCitationRecord): ManuscriptCitationRecord {
  return { ...record, input: normalizeCitationInput(record.input) };
}

export function citationYearToken(input: CitationInput): string {
  return input.publicationYear === null ? "n.d." : String(input.publicationYear);
}

/**
 * Uses the stored author strings exactly as display names.  In particular,
 * this does not infer surnames from values such as "Alice Smith".
 */
export function authorYearDisplayLabel(input: CitationInput): string {
  const authors = normalizedAuthors(input);
  if (authors.length === 0) return input.title.trim();
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  return `${authors[0]} et al.`;
}

export function normalizedAuthors(input: CitationInput): readonly string[] {
  return input.authors.map((author) => author.trim()).filter((author) => author.length > 0);
}

export function authorYearCollisionKey(input: CitationInput): string {
  return `${authorYearDisplayLabel(input)}\u0000${citationYearToken(input)}`;
}

export function authorYearSortKey(record: ManuscriptCitationRecord): readonly [string, number, string, string] {
  const input = record.input;
  return [
    authorYearDisplayLabel(input),
    input.publicationYear === null ? 1 : 0,
    input.publicationYear === null ? "" : String(input.publicationYear),
    `${input.title}\u0000${input.paperId}`,
  ];
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareAuthorYearRecords(left: ManuscriptCitationRecord, right: ManuscriptCitationRecord): number {
  const leftKey = authorYearSortKey(left);
  const rightKey = authorYearSortKey(right);
  const labelResult = compareStrings(leftKey[0], rightKey[0]);
  if (labelResult !== 0) return labelResult;
  if (leftKey[1] !== rightKey[1]) return leftKey[1] - rightKey[1];
  const yearResult = compareStrings(leftKey[2], rightKey[2]);
  if (yearResult !== 0) return yearResult;
  return compareStrings(leftKey[3], rightKey[3]);
}

function suffixForIndex(index: number): string {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

export function buildAuthorYearSuffixes(
  records: readonly ManuscriptCitationRecord[],
): ReadonlyMap<string, string> {
  const groups = new Map<string, ManuscriptCitationRecord[]>();
  for (const record of records) {
    const normalized = normalizedRecord(record);
    const key = authorYearCollisionKey(normalized.input);
    const group = groups.get(key) ?? [];
    group.push(normalized);
    groups.set(key, group);
  }

  const suffixes = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    [...group].sort(compareAuthorYearRecords).forEach((record, index) => {
      suffixes.set(record.input.paperId, suffixForIndex(index));
    });
  }
  return suffixes;
}

export function buildCitationFormatContext(
  records: readonly ManuscriptCitationRecord[],
  style: CitationStyle,
): CitationFormatContext {
  const recordsByPaperId = new Map<string, ManuscriptCitationRecord>();
  for (const record of records) {
    if (!recordsByPaperId.has(record.input.paperId)) {
      recordsByPaperId.set(record.input.paperId, normalizedRecord(record));
    }
  }
  const canonicalRecords = [...recordsByPaperId.values()];
  return {
    style,
    recordsByPaperId,
    authorYearSuffixByPaperId: style === "author_year" ? buildAuthorYearSuffixes(canonicalRecords) : new Map(),
  };
}

export function dedupeRecords(records: readonly ManuscriptCitationRecord[]): ManuscriptCitationRecord[] {
  const seen = new Set<string>();
  const result: ManuscriptCitationRecord[] = [];
  for (const record of records) {
    if (seen.has(record.input.paperId)) continue;
    seen.add(record.input.paperId);
    result.push(normalizedRecord(record));
  }
  return result;
}

export function formatYearWithSuffix(
  record: ManuscriptCitationRecord,
  context: CitationFormatContext,
): string {
  const year = citationYearToken(record.input);
  const suffix = context.authorYearSuffixByPaperId.get(record.input.paperId);
  if (!suffix) return year;
  return year === "n.d." ? `${year}-${suffix}` : `${year}${suffix}`;
}

export function missingMetadataWarnings(
  records: readonly ManuscriptCitationRecord[],
): CitationMetadataWarning[] {
  const warnings: CitationMetadataWarning[] = [];
  for (const record of dedupeRecords(records)) {
    const { input } = record;
    if (normalizedAuthors(input).length === 0) {
      warnings.push({ paperId: input.paperId, field: "authors", message: "Paper has no authors; formatting uses its title as the author label." });
    }
    if (input.publicationYear === null) {
      warnings.push({ paperId: input.paperId, field: "publication_year", message: "Paper has no publication year; formatting uses n.d." });
    }
    if (input.venue === null || input.venue.trim().length === 0) {
      warnings.push({ paperId: input.paperId, field: "venue", message: "Paper has no venue; formatting omits the venue." });
    }
  }
  return warnings;
}
