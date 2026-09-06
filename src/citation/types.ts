/**
 * Citation formatting is a derived presentation concern.  These types are
 * deliberately independent of React, persistence, and database row shapes.
 */

export type CitationStyle = "numeric" | "author_year";

export type CitationInput = {
  paperId: string;
  title: string;
  /** Stored display names.  Formatter code never parses these strings. */
  authors: readonly string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
};

export type CitationFirstOccurrence = {
  sectionId: string;
  sectionItemId: string;
  placementId: string;
  claimRevisionId: string;
};

/** A canonical manuscript citation number supplied by the provenance projection. */
export type ManuscriptCitationRecord = {
  input: CitationInput;
  citationNumber: number;
  firstOccurrence: CitationFirstOccurrence;
};

export type CitationFormatContext = {
  style: CitationStyle;
  recordsByPaperId: ReadonlyMap<string, ManuscriptCitationRecord>;
  /** Only colliding author-year records have a suffix. */
  authorYearSuffixByPaperId: ReadonlyMap<string, string>;
};

export type CitationMetadataWarningField = "authors" | "publication_year" | "venue";

export type CitationMetadataWarning = {
  paperId: string;
  field: CitationMetadataWarningField;
  message: string;
};

export interface CitationFormatter {
  readonly style: CitationStyle;
  formatInline(
    records: readonly ManuscriptCitationRecord[],
    context: CitationFormatContext,
  ): string;
  orderBibliography(
    records: readonly ManuscriptCitationRecord[],
    context: CitationFormatContext,
  ): readonly ManuscriptCitationRecord[];
  formatBibliographyEntry(
    record: ManuscriptCitationRecord,
    context: CitationFormatContext,
  ): string;
}
