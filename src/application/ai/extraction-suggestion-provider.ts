import { z } from "zod";

export const AI_EXTRACTION_LIMITS = {
  maxPages: 40,
  maxSourceCodePoints: 80_000,
  maxSerializedInputBytes: 320 * 1024,
  maxOptions: 200,
  maxOutputTokens: 8_192,
  maxGroundings: 8,
  maxGroundingCodePoints: 4_000,
  maxTotalGroundingCodePoints: 16_000,
  maxContextCodePoints: 120,
  maxExplanationCodePoints: 2_000,
  maxValueCodePoints: 10_000,
} as const;

export const extractionSuggestionFieldTypeSchema = z.enum([
  "short_text",
  "long_text",
  "number",
  "boolean",
  "single_select",
]);

export const extractionSuggestionStateSchema = z.enum([
  "present",
  "not_reported",
  "not_applicable",
]);

export type ExtractionSuggestionFieldType = z.infer<typeof extractionSuggestionFieldTypeSchema>;
export type ExtractionSuggestionState = z.infer<typeof extractionSuggestionStateSchema>;

export interface ExtractionSuggestionOption {
  id: string;
  label: string;
  active: boolean;
}

export interface ExtractionSuggestionPage {
  id: string;
  pageNumber: number;
  /** The exact persisted document_text_extraction_pages.text value. */
  text: string;
}

export interface ExtractionSuggestionInput {
  field: {
    id: string;
    name: string;
    description: string | null;
    fieldType: ExtractionSuggestionFieldType;
    options: ExtractionSuggestionOption[];
  };
  pages: ExtractionSuggestionPage[];
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  promptVersion: string;
  responseSchemaVersion: string;
  groundingResolverVersion: string;
  contextSelectionVersion: string;
  sourceCoverage: {
    extractionId: string;
    documentId: string;
    status: "succeeded" | "partial";
    omittedPageCount: number;
  };
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderExecutionMetadata {
  provider: "openai" | "fake";
  configuredModel: string;
  returnedModel: string | null;
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
}

export interface ProviderSuggestionGrounding {
  pageId: string;
  quote: string;
  prefix?: string | null;
  suffix?: string | null;
}

export const providerSuggestionGroundingSchema = z.object({
  pageId: z.string().min(1).max(200),
  quote: z.string().min(1).refine((value) => codePointLength(value) <= AI_EXTRACTION_LIMITS.maxGroundingCodePoints, "quote exceeds the grounding code-point limit"),
  prefix: z.string().min(1).refine((value) => codePointLength(value) <= AI_EXTRACTION_LIMITS.maxContextCodePoints, "prefix exceeds the context code-point limit").nullable().optional(),
  suffix: z.string().min(1).refine((value) => codePointLength(value) <= AI_EXTRACTION_LIMITS.maxContextCodePoints, "suffix exceeds the context code-point limit").nullable().optional(),
}).strict();

const providerCandidateSchema = z.object({
  outcome: z.literal("candidate"),
  state: extractionSuggestionStateSchema,
  // The application validates this against the frozen field type. Numbers are
  // strings here so decimal precision is not lost in JSON parsing.
  value: z.union([z.string().refine((value) => codePointLength(value) <= AI_EXTRACTION_LIMITS.maxValueCodePoints, "value exceeds the code-point limit"), z.boolean(), z.null()]),
  explanation: z.string().refine((value) => codePointLength(value) <= AI_EXTRACTION_LIMITS.maxExplanationCodePoints, "explanation exceeds the code-point limit").nullable().optional(),
  groundings: z.array(providerSuggestionGroundingSchema).max(AI_EXTRACTION_LIMITS.maxGroundings),
}).strict();

const providerNoCandidateSchema = z.object({
  outcome: z.literal("no_candidate"),
  state: z.null(),
  value: z.null(),
  explanation: z.string().refine((value) => codePointLength(value) <= AI_EXTRACTION_LIMITS.maxExplanationCodePoints, "explanation exceeds the code-point limit").nullable().optional(),
  groundings: z.array(providerSuggestionGroundingSchema).max(0),
}).strict();

export const providerSuggestionSchema = z.discriminatedUnion("outcome", [
  providerCandidateSchema,
  providerNoCandidateSchema,
]);

export type UntrustedProviderSuggestion = z.infer<typeof providerSuggestionSchema>;

export type ProviderFailureKind =
  | "provider_refusal"
  | "provider_incomplete"
  | "schema_invalid"
  | "transport_error"
  | "api_error";

export interface ProviderFailure {
  kind: "failure";
  failure: ProviderFailureKind;
  /** Stable bounded diagnostic code, never an unrestricted provider message. */
  code: string;
  metadata: ProviderExecutionMetadata;
}

export interface ProviderSuccess {
  kind: "success";
  suggestion: UntrustedProviderSuggestion;
  metadata: ProviderExecutionMetadata;
}

export type ProviderSuggestionResult = ProviderSuccess | ProviderFailure;

export interface ExtractionSuggestionProvider {
  suggest(input: ExtractionSuggestionInput, options?: ProviderCallOptions): Promise<ProviderSuggestionResult>;
}

export interface NormalizedProviderSuggestion {
  outcome: "candidate" | "no_candidate";
  state: ExtractionSuggestionState | null;
  value: string | boolean | null;
  explanation: string | null;
  groundings: ProviderSuggestionGrounding[];
}

export interface ProviderValidationResult {
  ok: true;
  suggestion: NormalizedProviderSuggestion;
}

export interface ProviderValidationFailure {
  ok: false;
  code:
    | "invalid_shape"
    | "invalid_state"
    | "invalid_value"
    | "invalid_option"
    | "missing_grounding"
    | "grounding_not_allowed";
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Validate the frozen request before any source text is transmitted. This
 * deliberately does not trim, normalize, or otherwise transform page text.
 */
export function validateSuggestionInput(input: ExtractionSuggestionInput):
  | { ok: true; serializedInput: string; serializedInputBytes: number; sourceCodePoints: number }
  | { ok: false; code: "invalid_input" | "input_too_large"; detail: string } {
  if (input.pages.length === 0 || input.pages.length > AI_EXTRACTION_LIMITS.maxPages) {
    return { ok: false, code: "input_too_large", detail: "page_limit_exceeded" };
  }
  if (input.field.options.length > AI_EXTRACTION_LIMITS.maxOptions) {
    return { ok: false, code: "input_too_large", detail: "option_limit_exceeded" };
  }
  const sourceCodePoints = input.pages.reduce((total, page) => total + codePointLength(page.text), 0);
  if (sourceCodePoints > AI_EXTRACTION_LIMITS.maxSourceCodePoints) {
    return { ok: false, code: "input_too_large", detail: "source_limit_exceeded" };
  }
  if (!input.field.id || !input.field.name || !input.model || !input.promptVersion || !input.responseSchemaVersion || !input.groundingResolverVersion || !input.contextSelectionVersion) {
    return { ok: false, code: "invalid_input", detail: "required_metadata_missing" };
  }
  if (!Number.isInteger(input.sourceCoverage.omittedPageCount) || input.sourceCoverage.omittedPageCount < 0 || !["succeeded", "partial"].includes(input.sourceCoverage.status)) {
    return { ok: false, code: "invalid_input", detail: "invalid_source_coverage" };
  }
  if (new Set(input.pages.map((page) => page.id)).size !== input.pages.length) {
    return { ok: false, code: "invalid_input", detail: "duplicate_page" };
  }
  if (input.pages.some((page) => !Number.isInteger(page.pageNumber) || page.pageNumber <= 0 || page.text.length === 0)) {
    return { ok: false, code: "invalid_input", detail: "invalid_page" };
  }
  const serializedInput = JSON.stringify({
    field: input.field,
    sourceCoverage: input.sourceCoverage,
    pages: input.pages,
  });
  const serializedInputBytes = utf8ByteLength(serializedInput);
  if (serializedInputBytes > AI_EXTRACTION_LIMITS.maxSerializedInputBytes) {
    return { ok: false, code: "input_too_large", detail: "serialized_input_limit_exceeded" };
  }
  return { ok: true, serializedInput, serializedInputBytes, sourceCodePoints };
}

export function validateProviderSuggestion(
  candidate: unknown,
  input: ExtractionSuggestionInput,
): ProviderValidationResult | ProviderValidationFailure {
  const parsed = providerSuggestionSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "invalid_shape" };
  const value = parsed.data;
  if (value.outcome === "no_candidate") {
    return { ok: true, suggestion: { outcome: "no_candidate", state: null, value: null, explanation: value.explanation ?? null, groundings: [] } };
  }
  if (value.state === "present") {
    if (value.groundings.length === 0) return { ok: false, code: "missing_grounding" };
    if (!isValueValidForField(value.value, input.field.fieldType, input.field.options)) {
      return { ok: false, code: "invalid_value" };
    }
  } else {
    if (value.value !== null) return { ok: false, code: "invalid_state" };
    if (value.groundings.length === 0) return { ok: false, code: "missing_grounding" };
  }
  if (value.groundings.some((grounding) => !input.pages.some((page) => page.id === grounding.pageId))) {
    return { ok: false, code: "grounding_not_allowed" };
  }
  return {
    ok: true,
    suggestion: {
      outcome: "candidate",
      state: value.state,
      value: value.value,
      explanation: value.explanation ?? null,
      groundings: value.groundings.map((grounding) => ({ ...grounding })),
    },
  };
}

function isValueValidForField(
  value: string | boolean | null,
  fieldType: ExtractionSuggestionFieldType,
  options: ExtractionSuggestionOption[],
): boolean {
  switch (fieldType) {
    case "short_text":
      return typeof value === "string" && value.trim().length > 0 && codePointLength(value) <= 500;
    case "long_text":
      return typeof value === "string" && value.trim().length > 0 && codePointLength(value) <= 10_000;
    case "number":
      return typeof value === "string" && isDecimalWithinNumeric30_10(value);
    case "boolean":
      return typeof value === "boolean";
    case "single_select":
      return typeof value === "string" && options.some((option) => option.active && option.id === value);
  }
}

function isDecimalWithinNumeric30_10(value: string): boolean {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  return integerPart.length <= 20 && fractionPart.length <= 10;
}

/** A strict JSON Schema used by Responses API `text.format`. */
export const PROVIDER_SUGGESTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "state", "value", "explanation", "groundings"],
  properties: {
    outcome: { type: "string", enum: ["candidate", "no_candidate"] },
    state: { type: ["string", "null"], enum: ["present", "not_reported", "not_applicable", null] },
    value: { type: ["string", "boolean", "null"] },
    explanation: { type: ["string", "null"] },
    groundings: {
      type: "array",
      maxItems: AI_EXTRACTION_LIMITS.maxGroundings,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pageId", "quote", "prefix", "suffix"],
        properties: {
          pageId: { type: "string" },
          quote: { type: "string" },
          prefix: { type: ["string", "null"] },
          suffix: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export interface FakeProviderOptions {
  result: ProviderSuggestionResult;
  onInvocation?: (input: ExtractionSuggestionInput) => void;
}

/** Deterministic provider for unit, integration, and isolated E2E tests. */
export class FakeExtractionSuggestionProvider implements ExtractionSuggestionProvider {
  public invocationCount = 0;

  constructor(private readonly options: FakeProviderOptions) {}

  async suggest(input: ExtractionSuggestionInput): Promise<ProviderSuggestionResult> {
    this.invocationCount += 1;
    this.options.onInvocation?.(input);
    return structuredClone(this.options.result);
  }
}
