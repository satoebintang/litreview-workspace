import { parseReferenceSource, type ReferenceFormat } from "@/domain/reference-import";
import { isPlausibleDoiForComparison } from "@/domain/search-normalization";

export const BIBLIOGRAPHIC_PARSER_VERSION = "@retorquere/bibtex-parser@10.0.1+ris-adapter@1";

const MAX_TITLE_VENUE_DOI_LENGTH = 1_000;
const MAX_AUTHOR_COUNT = 200;
const MAX_AUTHOR_LENGTH = 500;
const MAX_ABSTRACT_LENGTH = 100_000;
const MAX_RECORD_DIAGNOSTICS = 50;

export type BibliographicParserFormat = "bibtex" | "ris";

export type BibliographicParsedRecord = {
  sourceKey?: string | null;
  sourceType?: string | null;
  startByte: number;
  endByte: number;
  outcome?: "parsed" | "parsed_with_warnings" | "failed";
  fieldStates?: Partial<Record<"title" | "authors" | "publicationYear" | "venue" | "doi" | "url" | "abstract", "absent" | "blank" | "invalid" | "present">>;
  diagnostics?: string[];
  title: string | null;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  abstract: string | null;
};

function authorText(author: { family: string | null; given: string | null; suffix: string | null; literal: string | null }): string {
  if (author.literal) return author.literal;
  return [author.given, author.family, author.suffix].filter(Boolean).join(" ");
}

export const bibliographicParser = {
  parserVersion: BIBLIOGRAPHIC_PARSER_VERSION,
  parse(bytes: Uint8Array, format: BibliographicParserFormat): BibliographicParsedRecord[] {
    const parsed = parseReferenceSource(format as ReferenceFormat, bytes, { maxSourceBytes: 2 * 1024 * 1024, maxRecordBytes: 256 * 1024, maxRecords: 1_000 });
    return parsed.records.map((record) => {
      const diagnostics = record.diagnostics.map((item) => `${item.code}: ${item.message}`);
      const title = record.title?.trim() || null;
      if (!title) diagnostics.push("missing_title: record has no usable title");
      const publicationYear = record.year != null && record.year >= 1000 && record.year <= 3000 ? record.year : null;
      if (record.year != null && publicationYear == null) diagnostics.push("invalid_year: publication year is outside 1000-3000");
      if (record.doi && !isPlausibleDoiForComparison(record.doi)) diagnostics.push("invalid_doi: value is not a DOI namespace identifier");
      const fieldStates = (...names: string[]) => {
        const state = names.map((name) => record.fields[name]?.state).find((candidate) => candidate && candidate !== "missing") ?? record.fields[names[0]]?.state;
        if (!state || state === "missing") return "absent" as const;
        if (state === "empty") return "blank" as const;
        return state === "present" ? "present" as const : "invalid" as const;
      };
      const states = {
        title: fieldStates(record.format === "ris" ? "ti" : "title", record.format === "ris" ? "t1" : "title"),
        authors: fieldStates(record.format === "ris" ? "au" : "author", record.format === "ris" ? "a1" : "author"),
        publicationYear: fieldStates(record.format === "ris" ? "py" : "year", record.format === "ris" ? "y1" : "year", record.format === "ris" ? "da" : "year"),
        venue: fieldStates(record.format === "ris" ? "jo" : "journal", record.format === "ris" ? "jf" : "journaltitle", record.format === "ris" ? "t2" : "booktitle", record.format === "ris" ? "j2" : "howpublished"),
        doi: fieldStates(record.format === "ris" ? "do" : "doi"),
        url: fieldStates(record.format === "ris" ? "ur" : "url", record.format === "ris" ? "lu" : "url"),
        abstract: fieldStates(record.format === "ris" ? "ab" : "abstract", record.format === "ris" ? "n2" : "annote"),
      };
      const yearFieldName = record.format === "ris" ? ["py", "y1", "da"] : ["year"];
      if (yearFieldName.some((name) => record.fields[name]?.state === "present") && publicationYear == null) states.publicationYear = "invalid";
      if (record.doi && !isPlausibleDoiForComparison(record.doi)) states.doi = "invalid";
      const result: BibliographicParsedRecord = {
        sourceKey: record.key,
        sourceType: record.entryType,
        startByte: record.sourceSpan.startByte,
        endByte: record.sourceSpan.endByte,
        outcome: record.diagnostics.some((item) => item.severity === "error") ? "failed" : diagnostics.length ? "parsed_with_warnings" : "parsed",
        fieldStates: states,
        diagnostics,
        title,
        authors: record.authors.map(authorText),
        publicationYear,
        venue: record.journal,
        doi: record.doi,
        url: record.url,
        abstract: record.abstract,
      };
      const framingFailed = result.outcome === "failed";
      const limit = (condition: boolean, code: string, message: string, field?: keyof typeof states) => {
        if (!condition) return;
        diagnostics.push(`${code}: ${message}`);
        if (field) states[field] = "invalid";
      };
      limit(result.title != null && result.title.length > MAX_TITLE_VENUE_DOI_LENGTH, "title_limit", `title exceeds ${MAX_TITLE_VENUE_DOI_LENGTH} characters`, "title");
      limit(result.venue != null && result.venue.length > MAX_TITLE_VENUE_DOI_LENGTH, "venue_limit", `venue exceeds ${MAX_TITLE_VENUE_DOI_LENGTH} characters`, "venue");
      limit(result.doi != null && result.doi.length > MAX_TITLE_VENUE_DOI_LENGTH, "doi_limit", `DOI exceeds ${MAX_TITLE_VENUE_DOI_LENGTH} characters`, "doi");
      limit(result.abstract != null && result.abstract.length > MAX_ABSTRACT_LENGTH, "abstract_limit", `abstract exceeds ${MAX_ABSTRACT_LENGTH} characters`, "abstract");
      limit(result.authors.length > MAX_AUTHOR_COUNT, "author_count_limit", `record contains more than ${MAX_AUTHOR_COUNT} authors`, "authors");
      if (result.authors.some((author) => author.length > MAX_AUTHOR_LENGTH)) {
        diagnostics.push("author_length_limit: an author exceeds 500 characters");
        states.authors = "invalid";
      }
      result.fieldStates = states;
      result.diagnostics = diagnostics.slice(0, MAX_RECORD_DIAGNOSTICS);
      result.outcome = framingFailed || diagnostics.some((item) => /(?:_limit|invalid_year|invalid_doi)/.test(item)) ? "failed" : diagnostics.length ? "parsed_with_warnings" : "parsed";
      return result;
    });
  },
  parseWithDiagnostics(bytes: Uint8Array, format: BibliographicParserFormat) {
    const parsed = parseReferenceSource(format as ReferenceFormat, bytes, { maxSourceBytes: 2 * 1024 * 1024, maxRecordBytes: 256 * 1024, maxRecords: 1_000 });
    return {
      records: this.parse(bytes, format),
      diagnostics: parsed.diagnostics.map((item) => `${item.code}: ${item.message}`).slice(0, MAX_RECORD_DIAGNOSTICS),
      fatal: parsed.diagnostics.some((item) => item.severity === "error" && ["invalid_utf8", "record_limit", "nul_source", "control_source", "string_definition_limit", "nesting_limit", "macro_expansion_limit"].includes(item.code)),
    };
  },
};

export const createBibliographicParser = () => bibliographicParser;
