import { authorYearCitationFormatter } from "./author-year";
import { numericCitationFormatter } from "./numeric";
import type { CitationFormatter, CitationStyle } from "./types";

export * from "./types";
export * from "./common";
export { authorYearCitationFormatter } from "./author-year";
export { numericCitationFormatter } from "./numeric";

export function citationFormatterFor(style: CitationStyle): CitationFormatter {
  return style === "author_year" ? authorYearCitationFormatter : numericCitationFormatter;
}
