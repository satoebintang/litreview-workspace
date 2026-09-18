import { describe, expect, it, vi } from "vitest";
import { resolveSuggestionGroundings } from "@/application/ai/extraction-suggestion-grounding";
import { validateProviderSuggestion, validateSuggestionInput, type ExtractionSuggestionInput } from "@/application/ai/extraction-suggestion-provider";
import { OpenAIExtractionSuggestionProvider, type OpenAIResponsesRequest, type OpenAIResponsesTransport } from "@/infrastructure/openai-extraction-suggestion-provider";

function input(overrides: Partial<ExtractionSuggestionInput> = {}): ExtractionSuggestionInput {
  return {
    field: { id: "field-1", name: "Participants", description: null, fieldType: "number", options: [] },
    pages: [{ id: "page-1", pageNumber: 1, text: "Study reports 42 participants." }],
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    promptVersion: "extraction-suggestion-v1",
    responseSchemaVersion: "extraction-suggestion-response-v1",
    groundingResolverVersion: "exact-page-quote-v1",
    contextSelectionVersion: "selected-pages-v1",
    sourceCoverage: { extractionId: "extraction-1", documentId: "document-1", status: "succeeded", omittedPageCount: 0 },
    ...overrides,
  };
}

function responseBody(payload: unknown) {
  return {
    id: "resp_123",
    model: "gpt-5.6-luna",
    usage: { input_tokens: 31, output_tokens: 17, total_tokens: 48 },
    output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
  };
}

describe("Slice 26 provider boundary", () => {
  it("builds a strict no-tools request and forwards zero retries", async () => {
    let request: OpenAIResponsesRequest | undefined;
    let maxRetries: number | undefined;
    const transport: OpenAIResponsesTransport = {
      create: vi.fn(async (value, options) => {
        request = value;
        maxRetries = options.maxRetries;
        return {
          status: 200,
          body: responseBody({
            outcome: "candidate",
            state: "present",
            value: "42",
            explanation: "Reported in the paper.",
            groundings: [{ pageId: "page-1", quote: "42 participants" }],
          }),
        };
      }),
    };
    const provider = new OpenAIExtractionSuggestionProvider({ transport });
    const result = await provider.suggest(input());
    expect(result.kind).toBe("success");
    expect(maxRetries).toBe(0);
    expect(request).toMatchObject({ model: "gpt-5.6-luna", reasoning: { effort: "low" }, max_output_tokens: 8192, store: false, tools: [] });
    expect(request?.text.format).toMatchObject({ type: "json_schema", strict: true, name: "extraction_suggestion_v1" });
    expect(request?.input[1]?.content[0]?.text).toContain("Study reports 42 participants.");
  });

  it.each([
    ["provider refusal", { refusal: "policy" }, "provider_refusal"],
    ["incomplete response", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "provider_incomplete"],
    ["schema-invalid response", responseBody({ unexpected: true }), "schema_invalid"],
  ])("classifies %s without exposing provider text", async (_label, body, failure) => {
    const transport: OpenAIResponsesTransport = { create: vi.fn(async () => ({ status: 200, body })) };
    const result = await new OpenAIExtractionSuggestionProvider({ transport }).suggest(input());
    expect(result).toMatchObject({ kind: "failure", failure });
    expect(JSON.stringify(result)).not.toContain("policy");
  });
});

describe("Slice 26 exact grounding resolver", () => {
  it("uses code-point offsets and derives copied text from the persisted page", () => {
    const result = resolveSuggestionGroundings([{ pageId: "p1", quote: "😀 B" }], [{ id: "p1", pageNumber: 1, text: "A😀 B" }]);
    expect(result).toEqual({
      ok: true,
      totalCodePoints: 3,
      groundings: [{ pageId: "p1", pageNumber: 1, startOffset: 1, endOffset: 4, locatorQuote: "😀 B", locatorPrefix: null, locatorSuffix: null, sourceText: "😀 B" }],
    });
  });

  it("rejects ambiguity and does not normalize line endings", () => {
    expect(resolveSuggestionGroundings([{ pageId: "p1", quote: "same" }], [{ id: "p1", pageNumber: 1, text: "same and same" }])).toMatchObject({ ok: false, code: "unresolvable_grounding" });
    expect(resolveSuggestionGroundings([{ pageId: "p1", quote: "A\nB" }], [{ id: "p1", pageNumber: 1, text: "A\r\nB" }])).toMatchObject({ ok: false, code: "unresolvable_grounding" });
    expect(resolveSuggestionGroundings([{ pageId: "p1", quote: "same", prefix: "and " }], [{ id: "p1", pageNumber: 1, text: "same and same" }])).toMatchObject({ ok: true });
  });
});

describe("Slice 26 semantic field validation", () => {
  const grounding = [{ pageId: "page-1", quote: "reported" }];

  it.each([
    ["short_text", "a".repeat(500)],
    ["long_text", "a".repeat(10_000)],
    ["number", "99999999999999999999.9999999999"],
    ["boolean", true],
    ["single_select", "option-1"],
  ] as const)("accepts the %s field boundary", (fieldType, value) => {
    const result = validateProviderSuggestion({ outcome: "candidate", state: "present", value, explanation: null, groundings: grounding }, input({ field: { id: "field-1", name: "Field", description: null, fieldType, options: fieldType === "single_select" ? [{ id: "option-1", label: "One", active: true }] : [] } }));
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects blank and over-limit text, string booleans, invalid options, and exponent numbers", () => {
    const shortInput = input({ field: { id: "field-1", name: "Field", description: null, fieldType: "short_text", options: [] } });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: " ", explanation: null, groundings: grounding }, shortInput)).toMatchObject({ ok: false, code: "invalid_value" });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: "a".repeat(501), explanation: null, groundings: grounding }, shortInput)).toMatchObject({ ok: false, code: "invalid_value" });
    const booleanInput = input({ field: { id: "field-1", name: "Field", description: null, fieldType: "boolean", options: [] } });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: "true", explanation: null, groundings: grounding }, booleanInput)).toMatchObject({ ok: false, code: "invalid_value" });
    const selectInput = input({ field: { id: "field-1", name: "Field", description: null, fieldType: "single_select", options: [{ id: "option-1", label: "One", active: true }] } });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: "other", explanation: null, groundings: grounding }, selectInput)).toMatchObject({ ok: false, code: "invalid_value" });
    const numberInput = input();
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: "1e3", explanation: null, groundings: grounding }, numberInput)).toMatchObject({ ok: false, code: "invalid_value" });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: "100000000000000000000", explanation: null, groundings: grounding }, numberInput)).toMatchObject({ ok: false, code: "invalid_value" });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "present", value: "1.12345678901", explanation: null, groundings: grounding }, numberInput)).toMatchObject({ ok: false, code: "invalid_value" });
  });

  it("requires grounding for non-reporting states and never accepts provider cleared", () => {
    const fieldInput = input({ field: { id: "field-1", name: "Field", description: null, fieldType: "short_text", options: [] } });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "not_reported", value: null, explanation: null, groundings: [] }, fieldInput)).toMatchObject({ ok: false, code: "missing_grounding" });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "not_applicable", value: null, explanation: null, groundings: grounding }, fieldInput)).toMatchObject({ ok: true });
    expect(validateProviderSuggestion({ outcome: "candidate", state: "cleared", value: null, explanation: null, groundings: grounding }, fieldInput)).toMatchObject({ ok: false, code: "invalid_shape" });
  });

  it("keeps input budgets at exact code-point boundaries", () => {
    const accepted = validateSuggestionInput(input({ pages: [{ id: "page-1", pageNumber: 1, text: "a".repeat(80_000) }] }));
    expect(accepted.ok).toBe(true);
    const rejected = validateSuggestionInput(input({ pages: [{ id: "page-1", pageNumber: 1, text: "a".repeat(80_001) }] }));
    expect(rejected).toMatchObject({ ok: false, code: "input_too_large" });
  });
});
