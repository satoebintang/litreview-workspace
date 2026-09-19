import { AI_SYNTHESIS_LIMITS, codePointLength, type SynthesisSuggestionSupport, type ProviderSynthesisSuggestionGrounding } from "./synthesis-suggestion-provider";

export interface ResolvedSynthesisSuggestionGrounding {
  supportId: string;
  evidenceId: string;
  pageNumber: number | null;
  startOffset: number;
  endOffset: number;
  locatorQuote: string;
  locatorPrefix: string | null;
  locatorSuffix: string | null;
  sourceText: string;
}

export type SynthesisGroundingResolutionFailureCode = "unresolvable_grounding" | "duplicate_grounding" | "grounding_limit_exceeded" | "grounding_source_unavailable";
export type SynthesisGroundingResolutionResult =
  | { ok: true; groundings: ResolvedSynthesisSuggestionGrounding[]; totalCodePoints: number }
  | { ok: false; code: SynthesisGroundingResolutionFailureCode; groundingIndex?: number };

/** Resolve provider quote locators against the exact frozen source text. */
export function resolveSynthesisSuggestionGroundings(locators: ProviderSynthesisSuggestionGrounding[], sources: SynthesisSuggestionSupport[]): SynthesisGroundingResolutionResult {
  if (locators.length === 0 || locators.length > AI_SYNTHESIS_LIMITS.maxGroundings) return { ok: false, code: "grounding_limit_exceeded" };
  const resolved: ResolvedSynthesisSuggestionGrounding[] = [];
  const seen = new Set<string>();
  let totalCodePoints = 0;
  for (let groundingIndex = 0; groundingIndex < locators.length; groundingIndex += 1) {
    const locator = locators[groundingIndex];
    const supportId = locator.supportId;
    const evidenceId = locator.evidenceId;
    const support = supportId ? sources.find((candidate) => candidate.id === supportId) : undefined;
    const source = support && evidenceId ? support.connectingEvidence.find((candidate) => (candidate.id ?? candidate.evidenceId) === evidenceId) : undefined;
    if (!support || !source || !supportId || !evidenceId) return { ok: false, code: "grounding_source_unavailable", groundingIndex };
    const quote = Array.from(locator.quote);
    const prefix = Array.from(locator.prefix ?? "");
    const suffix = Array.from(locator.suffix ?? "");
    if (quote.length === 0 || quote.length > AI_SYNTHESIS_LIMITS.maxGroundingCodePoints || prefix.length > AI_SYNTHESIS_LIMITS.maxContextCodePoints || suffix.length > AI_SYNTHESIS_LIMITS.maxContextCodePoints) return { ok: false, code: "grounding_limit_exceeded", groundingIndex };
    const sourceText = source.text ?? source.sourceText ?? "";
    const sourcePoints = Array.from(sourceText);
    const matches: number[] = [];
    for (let start = 0; start <= sourcePoints.length - quote.length; start += 1) {
      if (!same(sourcePoints.slice(start, start + quote.length), quote)) continue;
      if (prefix.length > start || prefix.length > 0 && !same(sourcePoints.slice(start - prefix.length, start), prefix)) continue;
      const end = start + quote.length;
      if (end + suffix.length > sourcePoints.length || suffix.length > 0 && !same(sourcePoints.slice(end, end + suffix.length), suffix)) continue;
      matches.push(start);
    }
    if (matches.length !== 1) return { ok: false, code: "unresolvable_grounding", groundingIndex };
    const startOffset = matches[0];
    const endOffset = startOffset + quote.length;
    const resolvedEvidenceId = source.id ?? source.evidenceId!;
    const identity = `${support.id}:${resolvedEvidenceId}:${startOffset}:${endOffset}`;
    if (seen.has(identity)) return { ok: false, code: "duplicate_grounding", groundingIndex };
    seen.add(identity);
    totalCodePoints += quote.length;
    if (totalCodePoints > AI_SYNTHESIS_LIMITS.maxTotalGroundingCodePoints) return { ok: false, code: "grounding_limit_exceeded", groundingIndex };
    resolved.push({ supportId: support.id, evidenceId: resolvedEvidenceId, pageNumber: source.pageNumber ?? null, startOffset, endOffset, locatorQuote: locator.quote, locatorPrefix: locator.prefix ?? null, locatorSuffix: locator.suffix ?? null, sourceText: sourcePoints.slice(startOffset, endOffset).join("") });
  }
  return { ok: true, groundings: resolved, totalCodePoints };
}

function same(left: string[], right: string[]): boolean { return left.length === right.length && left.every((point, i) => point === right[i]); }
export { codePointLength };
export const resolveSynthesisGroundings = resolveSynthesisSuggestionGroundings;
