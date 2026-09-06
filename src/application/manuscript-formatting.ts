import type {
  Manuscript,
  ManuscriptBibliographyCandidate,
  ManuscriptCounts,
  ManuscriptSectionView,
  ManuscriptSectionItemView,
  ManuscriptWarning,
  ManuscriptClaimPlacementView,
} from "@/domain/types";
import {
  buildCitationFormatContext,
  citationFormatterFor,
  missingMetadataWarnings,
  type CitationFormatter,
  type CitationStyle,
  type ManuscriptCitationRecord,
} from "@/citation";

/**
 * Formatter input is deliberately not a database row.  The formatter receives
 * only canonical Paper metadata and the already-derived manuscript number.
 */
export type ManuscriptFormattingSource = {
  manuscript: Manuscript;
  sections: ManuscriptSectionView[];
  bibliographyCandidates: ManuscriptBibliographyCandidate[];
  warnings: ManuscriptWarning[];
  counts: ManuscriptCounts;
};

export interface FormattedManuscriptClaimItem {
  id: string;
  sectionId: string;
  itemType: "claim";
  sortOrder: number;
  placementId: string;
  claimId: string;
  claimRevisionId: string;
  placement: ManuscriptClaimPlacementView;
  claimText: string;
  citationNumbers: readonly number[];
  citationPaperIds: readonly string[];
  renderedCitationMarker: string;
}

export interface FormattedManuscriptProseItem {
  id: string;
  sectionId: string;
  itemType: "prose";
  sortOrder: number;
  text: string;
}

export type FormattedManuscriptItem = FormattedManuscriptClaimItem | FormattedManuscriptProseItem;

export interface FormattedManuscriptBibliographyEntry {
  paperId: string;
  title: string;
  citationNumber: number;
  firstOccurrence: ManuscriptBibliographyCandidate["firstOccurrence"];
  renderedReference: string;
}

export interface FormattedManuscriptProjection {
  manuscript: Manuscript & { citationStyle: CitationStyle };
  sections: Array<{
    id: string;
    title: string;
    sectionType: string;
    items: FormattedManuscriptItem[];
  }>;
  bibliography: FormattedManuscriptBibliographyEntry[];
  warnings: ManuscriptWarning[];
  counts: ManuscriptCounts;
}

function citationRecord(candidate: ManuscriptBibliographyCandidate): ManuscriptCitationRecord {
  const paper = candidate.paper;
  return {
    input: {
      paperId: paper.id,
      title: paper.title,
      authors: [...paper.authors],
      publicationYear: paper.publicationYear,
      venue: paper.venue,
      doi: paper.doi,
    },
    citationNumber: candidate.citationNumber,
    firstOccurrence: candidate.firstOccurrence,
  };
}

function claimText(item: Extract<ManuscriptSectionItemView, { itemType: "claim" }>): string {
  // A withdrawn historical revision may have a null claim text.  Empty text is
  // the exact representable value; the projection must not invent replacement
  // text or silently resolve the placement to a newer revision.
  return item.placement.claimRevision.claimText ?? "";
}

/**
 * Build the sole formatted projection consumed by both the manuscript UI and
 * export serializers.  This function does not read the database and never
 * mutates the source manuscript projection.
 */
export function buildFormattedManuscript(
  view: ManuscriptFormattingSource,
  formatter: CitationFormatter = citationFormatterFor(view.manuscript.citationStyle),
): FormattedManuscriptProjection {
  const style = view.manuscript.citationStyle;
  const sourceRecords = view.bibliographyCandidates.map(citationRecord);
  const context = buildCitationFormatContext(sourceRecords, style);
  const byPaperId = context.recordsByPaperId;
  const warnings: ManuscriptWarning[] = [...view.warnings];
  const warningKeys = new Set(warnings.map((warning) => `${warning.code}|${warning.paperId ?? ""}|${warning.message}`));
  for (const warning of missingMetadataWarnings(sourceRecords)) {
    const key = `incomplete_bibliography|${warning.paperId}|${warning.message}`;
    if (warningKeys.has(key)) continue;
    warningKeys.add(key);
    warnings.push({ code: "incomplete_bibliography", message: warning.message, paperId: warning.paperId, metadataField: warning.field });
  }

  const sections = view.sections.map((section) => ({
    id: section.id,
    title: section.title,
    sectionType: section.sectionType,
    items: section.items.map((item): FormattedManuscriptItem => {
      if (item.itemType === "prose") {
        return { id: item.id, sectionId: item.sectionId, itemType: "prose", sortOrder: item.sortOrder, text: item.text };
      }

      const records = item.citationCandidates
        .map((candidate) => byPaperId.get(candidate.paper.id))
        .filter((record): record is ManuscriptCitationRecord => record !== undefined)
        .sort((a, b) => a.citationNumber - b.citationNumber);
      const citationNumbers = [...new Set(records.map((record) => record.citationNumber))];
      const citationPaperIds = [...new Set(records.map((record) => record.input.paperId))];
      // The formatter receives an empty list for unsupported/unconnected
      // claims.  Its result must remain empty; serializers must not add a
      // visible placeholder or trailing citation space.
      const renderedCitationMarker = records.length ? formatter.formatInline(records, context) : "";
      return {
        id: item.id,
        sectionId: item.sectionId,
        itemType: "claim",
        sortOrder: item.sortOrder,
        placementId: item.placement.id,
        claimId: item.placement.claimId,
        claimRevisionId: item.placement.claimRevisionId,
        placement: item.placement,
        claimText: claimText(item),
        citationNumbers,
        citationPaperIds,
        renderedCitationMarker,
      };
    }),
  }));

  const orderedRecords = [...formatter.orderBibliography(sourceRecords, context)];
  const bibliography = orderedRecords.map((record) => ({
    paperId: record.input.paperId,
    title: record.input.title,
    citationNumber: record.citationNumber,
    firstOccurrence: record.firstOccurrence,
    renderedReference: formatter.formatBibliographyEntry(record, context),
  }));

  return {
    manuscript: { ...view.manuscript, citationStyle: style },
    sections,
    bibliography,
    warnings,
    counts: view.counts,
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Serialize a formatted projection without any database or framework access. */
export function serializeManuscriptMarkdown(projection: FormattedManuscriptProjection): string {
  const lines: string[] = [`# ${projection.manuscript.title}`];
  for (const section of projection.sections) {
    lines.push("", `## ${section.title}`);
    for (const item of section.items) {
      if (item.itemType === "prose") {
        lines.push("", normalizeLineEndings(item.text));
      } else {
        const marker = item.renderedCitationMarker ? ` ${item.renderedCitationMarker}` : "";
        lines.push("", `${normalizeLineEndings(item.claimText)}${marker}`);
      }
    }
  }

  lines.push("", "## References");
  for (const entry of projection.bibliography) {
    const reference = normalizeLineEndings(entry.renderedReference);
    lines.push("", projection.manuscript.citationStyle === "numeric" ? reference : `- ${reference}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
