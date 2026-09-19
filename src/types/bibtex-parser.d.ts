declare module "@retorquere/bibtex-parser" {
  export interface BibTeXParserOptions {
    english?: boolean | string[];
    sentenceCase?: boolean | { guess?: boolean; preserveQuoted?: boolean; subSentence?: boolean };
    verbatimFields?: Array<string | RegExp>;
    unsupported?: "ignore" | ((node: unknown, source: string, entry: unknown) => string);
    raw?: boolean;
    applyCrossRef?: boolean;
  }

  export interface BibTeXEntry {
    type: string;
    key: string;
    fields: Record<string, unknown>;
    mode: Record<string, string>;
    input: string;
  }

  export interface BibTeXParseResult {
    errors: Array<{ error: string; input?: string }>;
    entries: BibTeXEntry[];
    comments: string[];
    strings: Record<string, string>;
    preamble: string[];
    jabref: unknown;
  }

  export function parse(input: string, options?: BibTeXParserOptions): BibTeXParseResult;
}
