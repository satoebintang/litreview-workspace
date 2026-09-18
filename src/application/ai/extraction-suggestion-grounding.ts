import {
  AI_EXTRACTION_LIMITS,
  codePointLength,
  ExtractionSuggestionPage,
  ProviderSuggestionGrounding,
} from "./extraction-suggestion-provider";

export interface ResolvedSuggestionGrounding {
  pageId: string;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  locatorQuote: string;
  locatorPrefix: string | null;
  locatorSuffix: string | null;
  sourceText: string;
}

export type GroundingResolutionFailureCode =
  | "unresolvable_grounding"
  | "duplicate_grounding"
  | "grounding_limit_exceeded"
  | "grounding_page_unavailable";

export type GroundingResolutionResult =
  | { ok: true; groundings: ResolvedSuggestionGrounding[]; totalCodePoints: number }
  | { ok: false; code: GroundingResolutionFailureCode; groundingIndex?: number };

/**
 * Resolve model-provided quote locators against the exact persisted page text.
 * Matching uses JavaScript code points, the same coordinate system used by
 * PostgreSQL char_length in the extraction tables. No Unicode, whitespace,
 * punctuation, or line-ending normalization is performed here.
 */
export function resolveSuggestionGroundings(
  locators: ProviderSuggestionGrounding[],
  pages: ExtractionSuggestionPage[],
): GroundingResolutionResult {
  if (locators.length === 0 || locators.length > AI_EXTRACTION_LIMITS.maxGroundings) {
    return { ok: false, code: "grounding_limit_exceeded" };
  }
  const resolved: ResolvedSuggestionGrounding[] = [];
  let totalCodePoints = 0;
  const seen = new Set<string>();

  for (let groundingIndex = 0; groundingIndex < locators.length; groundingIndex += 1) {
    const locator = locators[groundingIndex];
    const page = pages.find((candidate) => candidate.id === locator.pageId);
    if (!page) return { ok: false, code: "grounding_page_unavailable", groundingIndex };
    const quote = Array.from(locator.quote);
    if (quote.length === 0 || quote.length > AI_EXTRACTION_LIMITS.maxGroundingCodePoints) {
      return { ok: false, code: "grounding_limit_exceeded", groundingIndex };
    }
    const source = Array.from(page.text);
    const starts = findCodePointMatches(source, quote);
    const contextualMatches = starts.filter((start) => {
      const prefix = locator.prefix ?? "";
      const suffix = locator.suffix ?? "";
      const prefixPoints = Array.from(prefix);
      const suffixPoints = Array.from(suffix);
      if (prefixPoints.length > AI_EXTRACTION_LIMITS.maxContextCodePoints || suffixPoints.length > AI_EXTRACTION_LIMITS.maxContextCodePoints) {
        return false;
      }
      if (prefixPoints.length > start) return false;
      if (prefixPoints.length > 0 && !sameCodePoints(source.slice(start - prefixPoints.length, start), prefixPoints)) return false;
      const end = start + quote.length;
      if (end + suffixPoints.length > source.length) return false;
      if (suffixPoints.length > 0 && !sameCodePoints(source.slice(end, end + suffixPoints.length), suffixPoints)) return false;
      return true;
    });
    if (contextualMatches.length !== 1) return { ok: false, code: "unresolvable_grounding", groundingIndex };

    const startOffset = contextualMatches[0];
    const endOffset = startOffset + quote.length;
    const identity = `${page.id}:${startOffset}:${endOffset}`;
    if (seen.has(identity)) return { ok: false, code: "duplicate_grounding", groundingIndex };
    seen.add(identity);
    totalCodePoints += quote.length;
    if (totalCodePoints > AI_EXTRACTION_LIMITS.maxTotalGroundingCodePoints) {
      return { ok: false, code: "grounding_limit_exceeded", groundingIndex };
    }
    // Derive this value from the persisted page string rather than the model's
    // quote. The offsets remain code-point offsets for the database writer.
    const sourceText = source.slice(startOffset, endOffset).join("");
    resolved.push({
      pageId: page.id,
      pageNumber: page.pageNumber,
      startOffset,
      endOffset,
      locatorQuote: locator.quote,
      locatorPrefix: locator.prefix ?? null,
      locatorSuffix: locator.suffix ?? null,
      sourceText,
    });
  }
  return { ok: true, groundings: resolved, totalCodePoints };
}

function findCodePointMatches(source: string[], query: string[]): number[] {
  if (query.length > source.length) return [];
  const matches: number[] = [];
  for (let start = 0; start <= source.length - query.length; start += 1) {
    if (sameCodePoints(source.slice(start, start + query.length), query)) matches.push(start);
  }
  return matches;
}

function sameCodePoints(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((point, index) => point === right[index]);
}

// Keep the imported helper part of this module's public implementation contract
// for callers that need to calculate the same persisted coordinate lengths.
export { codePointLength };
