import {
  authorYearDisplayLabel,
  compareAuthorYearRecords,
  dedupeRecords,
  formatYearWithSuffix,
  normalizedAuthors,
} from "./common";
import type { CitationFormatter } from "./types";

export const authorYearCitationFormatter: CitationFormatter = {
  style: "author_year",

  formatInline(records, context) {
    const unique = dedupeRecords(records).sort(compareAuthorYearRecords);
    if (unique.length === 0) return "";
    const labels = unique.map((record) => {
      return `${authorYearDisplayLabel(record.input)}, ${formatYearWithSuffix(record, context)}`;
    });
    return `(${labels.join("; ")})`;
  },

  orderBibliography(records) {
    return dedupeRecords(records).sort(compareAuthorYearRecords);
  },

  formatBibliographyEntry(record, context) {
    const input = record.input;
    const authors = normalizedAuthors(input);
    const label = authors.length > 0 ? authors.join(", ") : input.title;
    const year = formatYearWithSuffix(record, context);
    const pieces = [`${label} (${year})`, ...(authors.length > 0 ? [input.title] : []), ...(input.venue ? [input.venue] : [])];
    const base = pieces.join(". ");
    return input.doi ? `${base}. doi:${input.doi}` : base;
  },
};
