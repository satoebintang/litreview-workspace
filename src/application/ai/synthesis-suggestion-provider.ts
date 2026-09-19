import { z } from "zod";

/** Bounds shared by the synthesis provider, request builder, and resolver. */
export const AI_SYNTHESIS_LIMITS = {
  minSupports: 1,
  maxSupports: 20,
  maxConnectingEvidencePerSupport: 8,
  maxConnectingEvidencePerRequest: 80,
  maxSourceCodePoints: 80_000,
  maxSerializedInputBytes: 320 * 1024,
  maxGroundings: 40,
  maxGroundingCodePoints: 500,
  maxTotalGroundingCodePoints: 12_000,
  maxContextCodePoints: 120,
  maxTitleCodePoints: 500,
  maxStatementCodePoints: 10_000,
  maxExplanationCodePoints: 2_000,
  maxOutputTokens: 8_192,
} as const;

export const SYNTHESIS_SUGGESTION_PROMPT_VERSION = "synthesis-suggestion-v1";
export const SYNTHESIS_SUGGESTION_RESPONSE_SCHEMA_VERSION = "synthesis-suggestion-response-v1";
export const SYNTHESIS_SUGGESTION_GROUNDING_RESOLVER_VERSION = "exact-support-evidence-quote-v1";
export const SYNTHESIS_SUGGESTION_CONTEXT_SELECTION_VERSION = "pinned-supports-v1";
export const SYNTHESIS_SUGGESTION_DISCLOSURE_VERSION = "openai-synthesis-transmission-v1";

export type SynthesisSuggestionTarget =
  | { kind: "new" }
  | { kind: "existing"; statementId: string };

/** A frozen, provider-facing source. `text` is persisted source text. */
export interface SynthesisSuggestionConnectingEvidence {
  id?: string;
  evidenceId?: string;
  text?: string;
  sourceText?: string;
  pageNumber?: number | null;
  reviewState?: "unreviewed" | "needs_review" | "accepted" | "rejected";
  noteSnapshot?: string | null;
}

export interface SynthesisSuggestionSupport {
  id: string;
  extractionRevisionId?: string;
  paperId?: string;
  paperTitle?: string;
  paperPublicationYear?: number | null;
  fieldType?: "short_text" | "long_text" | "number" | "boolean" | "single_select";
  valueState?: "present" | "not_reported" | "not_applicable" | "cleared";
  optionId?: string | null;
  optionLabelSnapshot?: string | null;
  researcherNote?: string | null;
  value: string;
  connectingEvidence: SynthesisSuggestionConnectingEvidence[];
}

/** Compatibility alias for callers that call frozen supports “sources”. */
export type SynthesisSuggestionSource = SynthesisSuggestionSupport;

export interface SynthesisSuggestionInput {
  preparationId: string;
  target: SynthesisSuggestionTarget;
  field: { id: string; name: string; description?: string | null; type?: "short_text" | "long_text" | "number" | "boolean" | "single_select" };
  workingTitle?: string | null;
  workingNote?: string | null;
  supports: SynthesisSuggestionSupport[];
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  promptVersion: string;
  responseSchemaVersion: string;
  groundingResolverVersion: string;
  contextSelectionVersion: string;
  sourceCoverage?: {
    selectedCount: number;
    omittedCount: number;
    status: "complete" | "partial";
  };
}

export interface ProviderCallOptions { signal?: AbortSignal; timeoutMs?: number }

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

export interface ProviderSynthesisSuggestionGrounding {
  supportId?: string;
  evidenceId?: string;
  quote: string;
  prefix?: string | null;
  suffix?: string | null;
}

const groundingShape = z.object({
  supportId: z.string().min(1).max(200).optional(),
  evidenceId: z.string().min(1).max(200).optional(),
  quote: z.string().min(1).refine((v) => codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxGroundingCodePoints, "quote exceeds the grounding code-point limit"),
  prefix: z.string().min(1).refine((v) => codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxContextCodePoints, "prefix exceeds the context code-point limit").nullable().optional(),
  suffix: z.string().min(1).refine((v) => codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxContextCodePoints, "suffix exceeds the context code-point limit").nullable().optional(),
}).strict().refine((v) => Boolean(v.supportId && v.evidenceId), "grounding support and evidence identity are required");

export const providerSynthesisSuggestionSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("candidate"),
    title: z.string().nullable().refine((v) => v == null || (v.length > 0 && codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxTitleCodePoints)),
    statementText: z.string().min(1).refine((v) => codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxStatementCodePoints),
    explanation: z.string().refine((v) => codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxExplanationCodePoints).nullable().optional(),
    groundings: z.array(groundingShape).min(1).max(AI_SYNTHESIS_LIMITS.maxGroundings),
  }).strict(),
  z.object({
    outcome: z.literal("no_candidate"),
    title: z.null(), statementText: z.null(),
    explanation: z.string().refine((v) => codePointLength(v) <= AI_SYNTHESIS_LIMITS.maxExplanationCodePoints).nullable().optional(),
    groundings: z.array(groundingShape).max(0),
  }).strict(),
]);

export type UntrustedProviderSynthesisSuggestion = z.infer<typeof providerSynthesisSuggestionSchema>;
export type ProviderFailureKind = "provider_refusal" | "provider_incomplete" | "schema_invalid" | "transport_error" | "api_error";
export interface ProviderFailure { kind: "failure"; failure: ProviderFailureKind; code: string; metadata: ProviderExecutionMetadata }
export interface ProviderSuccess { kind: "success"; suggestion: UntrustedProviderSynthesisSuggestion; metadata: ProviderExecutionMetadata }
export type ProviderSynthesisSuggestionResult = ProviderSuccess | ProviderFailure;

export interface SynthesisSuggestionProvider {
  suggest(input: SynthesisSuggestionInput, options?: ProviderCallOptions): Promise<ProviderSynthesisSuggestionResult>;
}

export interface NormalizedProviderSynthesisSuggestion {
  outcome: "candidate" | "no_candidate";
  title: string | null;
  statementText: string | null;
  explanation: string | null;
  groundings: Array<{ supportId: string; evidenceId: string; quote: string; prefix?: string | null; suffix?: string | null }>;
}
export type ProviderSynthesisValidationResult = { ok: true; suggestion: NormalizedProviderSynthesisSuggestion } | { ok: false; code: "invalid_shape" | "invalid_target" | "invalid_text" | "missing_grounding" | "grounding_not_allowed" };

export function codePointLength(value: string): number { return Array.from(value).length }
export function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength }

export function validateSynthesisSuggestionInput(input: SynthesisSuggestionInput): { ok: true; serializedInput: string; serializedInputBytes: number; sourceCodePoints: number } | { ok: false; code: "invalid_input" | "input_too_large"; detail: string } {
  if (!input.preparationId || !input.field.id || !input.field.name || !input.model || !input.promptVersion || !input.responseSchemaVersion || !input.groundingResolverVersion || !input.contextSelectionVersion) return { ok: false, code: "invalid_input", detail: "required_metadata_missing" };
  if (input.supports.length < AI_SYNTHESIS_LIMITS.minSupports || input.supports.length > AI_SYNTHESIS_LIMITS.maxSupports) return { ok: false, code: "input_too_large", detail: "support_limit_exceeded" };
  if (input.target.kind === "existing" && !input.target.statementId) return { ok: false, code: "invalid_input", detail: "target_statement_missing" };
  if (new Set(input.supports.map((support) => support.id)).size !== input.supports.length) return { ok: false, code: "invalid_input", detail: "duplicate_support" };
  const connectingCount = input.supports.reduce((sum, support) => sum + support.connectingEvidence.length, 0);
  if (input.supports.some((support) => support.connectingEvidence.length === 0)) return { ok: false, code: "invalid_input", detail: "connecting_evidence_missing" };
  if (connectingCount > AI_SYNTHESIS_LIMITS.maxConnectingEvidencePerRequest || input.supports.some((support) => support.connectingEvidence.length > AI_SYNTHESIS_LIMITS.maxConnectingEvidencePerSupport)) return { ok: false, code: "input_too_large", detail: "connecting_evidence_limit_exceeded" };
  if (input.supports.some((support) => !support.id || typeof support.value !== "string" || support.connectingEvidence.some((evidence) => !(evidence.id || evidence.evidenceId) || typeof (evidence.text ?? evidence.sourceText) !== "string" || (evidence.text ?? evidence.sourceText)!.length === 0))) return { ok: false, code: "invalid_input", detail: "invalid_support" };
  const sourceCodePoints = input.supports.reduce((sum, support) => sum + support.connectingEvidence.reduce((evidenceSum, evidence) => evidenceSum + codePointLength(evidence.text ?? evidence.sourceText ?? ""), 0), 0);
  if (input.supports.some((support) => support.connectingEvidence.some((evidence) => codePointLength(evidence.text ?? evidence.sourceText ?? "") > 4_000))) return { ok: false, code: "input_too_large", detail: "passage_code_point_limit_exceeded" };
  if (sourceCodePoints > AI_SYNTHESIS_LIMITS.maxSourceCodePoints) return { ok: false, code: "input_too_large", detail: "source_code_point_limit_exceeded" };
  const serializedInput = JSON.stringify({ preparationId: input.preparationId, target: input.target, field: input.field, workingTitle: input.workingTitle ?? null, workingNote: input.workingNote ?? null, supports: input.supports, sourceCoverage: input.sourceCoverage ?? null });
  const serializedInputBytes = utf8ByteLength(serializedInput);
  if (serializedInputBytes > AI_SYNTHESIS_LIMITS.maxSerializedInputBytes) return { ok: false, code: "input_too_large", detail: "serialized_input_limit_exceeded" };
  return { ok: true, serializedInput, serializedInputBytes, sourceCodePoints };
}

export function validateProviderSynthesisSuggestion(candidate: unknown, input: SynthesisSuggestionInput): ProviderSynthesisValidationResult {
  const parsed = providerSynthesisSuggestionSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "invalid_shape" };
  const value = parsed.data;
  if (value.outcome === "no_candidate") return { ok: true, suggestion: { outcome: "no_candidate", title: null, statementText: null, explanation: value.explanation ?? null, groundings: [] } };
  if (value.title !== null && !value.title.trim() || !value.statementText.trim()) return { ok: false, code: "invalid_text" };
  const groundings = value.groundings.map((g) => ({ supportId: g.supportId!, evidenceId: g.evidenceId!, quote: g.quote, prefix: g.prefix ?? null, suffix: g.suffix ?? null }));
  if (groundings.some((g) => !input.supports.some((support) => support.id === g.supportId && support.connectingEvidence.some((evidence) => (evidence.id ?? evidence.evidenceId) === g.evidenceId)))) return { ok: false, code: "grounding_not_allowed" };
  if (input.supports.some((support) => !groundings.some((grounding) => grounding.supportId === support.id))) return { ok: false, code: "missing_grounding" };
  return { ok: true, suggestion: { outcome: "candidate", title: value.title, statementText: value.statementText, explanation: value.explanation ?? null, groundings } };
}

export const SYNTHESIS_SUGGESTION_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["outcome", "title", "statementText", "explanation", "groundings"],
  properties: {
    outcome: { type: "string", enum: ["candidate", "no_candidate"] },
    title: { type: ["string", "null"] }, statementText: { type: ["string", "null"] },
    explanation: { type: ["string", "null"] },
    groundings: { type: "array", maxItems: AI_SYNTHESIS_LIMITS.maxGroundings, items: { type: "object", additionalProperties: false, required: ["supportId", "evidenceId", "quote", "prefix", "suffix"], properties: { supportId: { type: "string" }, evidenceId: { type: "string" }, quote: { type: "string" }, prefix: { type: ["string", "null"] }, suffix: { type: ["string", "null"] } } } },
  },
} as const;

export interface FakeSynthesisSuggestionProviderOptions {
  result: ProviderSynthesisSuggestionResult | ((input: SynthesisSuggestionInput) => ProviderSynthesisSuggestionResult);
  onInvocation?: (input: SynthesisSuggestionInput) => void;
}
export class FakeSynthesisSuggestionProvider implements SynthesisSuggestionProvider {
  public invocationCount = 0;
  constructor(private readonly options: FakeSynthesisSuggestionProviderOptions) {}
  async suggest(input: SynthesisSuggestionInput): Promise<ProviderSynthesisSuggestionResult> {
    this.invocationCount += 1;
    this.options.onInvocation?.(input);
    const result = typeof this.options.result === "function" ? this.options.result(input) : this.options.result;
    return structuredClone(result);
  }
}

// Short aliases keep the provider seam parallel with Slice 26 and make the
// lifecycle service independent of the concrete adapter's longer names.
export type ProviderSuggestionGrounding = ProviderSynthesisSuggestionGrounding;
export type ProviderSuggestionResult = ProviderSynthesisSuggestionResult;
export type UntrustedProviderSuggestion = UntrustedProviderSynthesisSuggestion;
export const providerSuggestionSchema = providerSynthesisSuggestionSchema;
export const validateProviderSuggestion = validateProviderSynthesisSuggestion;
