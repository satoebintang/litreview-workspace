import { compareStrings, dedupeRecords } from "./common";
import type { CitationFormatter, ManuscriptCitationRecord } from "./types";

export const numericCitationFormatter: CitationFormatter = {
  style: "numeric",

  formatInline(records) {
    const numbers = dedupeRecords(records)
      .map((record) => record.citationNumber)
      .filter((number) => Number.isFinite(number) && number > 0)
      .sort((left, right) => left - right);
    return numbers.length > 0 ? `[${numbers.join(", ")}]` : "";
  },

  orderBibliography(records) {
    return dedupeRecords(records).sort((left, right) => {
      if (left.citationNumber !== right.citationNumber) return left.citationNumber - right.citationNumber;
      return compareStrings(left.input.paperId, right.input.paperId);
    });
  },

  formatBibliographyEntry(record: ManuscriptCitationRecord) {
    const input = record.input;
    const authors = input.authors.map((author) => author.trim()).filter((author) => author.length > 0);
    const pieces = [authors.length > 0 ? authors.join(", ") : null, input.title.trim(), input.venue, input.publicationYear === null ? "n.d." : String(input.publicationYear)]
      .filter((piece): piece is string => piece !== null && piece.length > 0);
    const base = `${record.citationNumber}. ${pieces.join(". ")}`;
    return input.doi ? `${base}. doi:${input.doi}` : base;
  },
};
