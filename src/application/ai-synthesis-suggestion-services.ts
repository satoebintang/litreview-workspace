import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { idSchema, finalizeSynthesisPreparationSchema, type FinalizeSynthesisPreparationSchemaInput } from "@/domain/validation";
import type { ReviewTransaction } from "@/application/synthesis-writer";
import type { FinalizeSynthesisPreparationTransactionOptions } from "@/application/synthesis-preparation-services";
import {
  AI_SYNTHESIS_LIMITS,
  type SynthesisSuggestionInput,
  type SynthesisSuggestionProvider,
  type ProviderSynthesisSuggestionResult,
  validateSynthesisSuggestionInput,
  validateProviderSynthesisSuggestion,
  SYNTHESIS_SUGGESTION_PROMPT_VERSION,
  SYNTHESIS_SUGGESTION_RESPONSE_SCHEMA_VERSION,
  SYNTHESIS_SUGGESTION_GROUNDING_RESOLVER_VERSION,
  SYNTHESIS_SUGGESTION_CONTEXT_SELECTION_VERSION,
} from "@/application/ai/synthesis-suggestion-provider";
import { resolveSynthesisSuggestionGroundings } from "@/application/ai/synthesis-suggestion-grounding";

type Executor = Pick<Database, "execute">;
type Outcome = "succeeded" | "no_candidate" | "provider_unavailable" | "failed" | "invalid_output" | "unresolvable_grounding" | "outcome_unknown";
type Diagnostic = "success" | "refusal" | "incomplete" | "schema_invalid" | "transport_error" | "api_error" | "unknown";

export type BeginAiSynthesisSuggestionInput = {
  projectId: string;
  preparationId: string;
  idempotencyKey: string;
  model?: string;
  reasoningEffort?: SynthesisSuggestionInput["reasoningEffort"];
  externalTransmissionAcknowledged: boolean;
  disclosureVersion: string;
};

export type AcceptAiSynthesisSuggestionInput = {
  projectId: string;
  requestId: string;
  preparationId?: string;
  mode: "accept" | "edit_and_accept";
  title?: string | null;
  statementText?: string;
  researcherNote?: string | null;
};

export type AiSynthesisSuggestionHistoryPageOptions = {
  pageSize?: number;
  cursor?: string | null;
};

export type AiSynthesisSuggestionHistoryItem = {
  requestId: string;
  preparationId: string;
  createdAt: Date | null;
  provider: string;
  model: string;
  returnedModel: string | null;
  outcome: string | null;
  providerDiagnostic: string | null;
  errorCode: string | null;
  candidateState: string | null;
  resultFinalizedAt: Date | null;
  decision: string | null;
  resultingSynthesisRevisionId: string | null;
  supportCount: number;
  sourceCount: number;
  groundingCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
};

export type AiSynthesisSuggestionHistoryPage = {
  items: AiSynthesisSuggestionHistoryItem[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export interface AiSynthesisSuggestionServiceOptions {
  defaultModel?: string;
  defaultReasoningEffort?: SynthesisSuggestionInput["reasoningEffort"];
  finalizePreparationInTransaction: (
    tx: ReviewTransaction,
    projectId: string,
    preparationId: string,
    input: FinalizeSynthesisPreparationSchemaInput,
    options?: FinalizeSynthesisPreparationTransactionOptions,
  ) => Promise<{ preparation: unknown; statement: { id: string }; revision: { id: string }; selectedIds: string[] }>;
}

export interface AiSynthesisSuggestionServices {
  beginAiSynthesisSuggestion(input: BeginAiSynthesisSuggestionInput): Promise<Record<string, unknown>>;
  executeAiSynthesisSuggestion(requestId: string, projectId?: string, preparationId?: string): Promise<Record<string, unknown>>;
  expireAiSynthesisSuggestion(requestId: string, projectId?: string, preparationId?: string): Promise<Record<string, unknown>>;
  getAiSynthesisSuggestion(requestId: string, projectId?: string, preparationId?: string): Promise<Record<string, unknown>>;
  listAiSynthesisSuggestions(projectId: string, preparationId: string): Promise<Record<string, unknown>[]>;
  listAiSynthesisSuggestionHistoryPage(projectId: string, preparationId: string, options?: AiSynthesisSuggestionHistoryPageOptions): Promise<AiSynthesisSuggestionHistoryPage>;
  rejectAiSynthesisSuggestion(projectId: string, requestId: string, preparationId?: string): Promise<Record<string, unknown>>;
  acceptAiSynthesisSuggestion(input: AcceptAiSynthesisSuggestionInput): Promise<Record<string, unknown>>;
}

const PROVIDER_TIMEOUT_MS = 45_000;
const PROMPT_VERSION = SYNTHESIS_SUGGESTION_PROMPT_VERSION;
const RESPONSE_SCHEMA_VERSION = SYNTHESIS_SUGGESTION_RESPONSE_SCHEMA_VERSION;
const GROUNDING_RESOLVER_VERSION = SYNTHESIS_SUGGESTION_GROUNDING_RESOLVER_VERSION;
const CONTEXT_SELECTION_VERSION = SYNTHESIS_SUGGESTION_CONTEXT_SELECTION_VERSION;

function rows(value: unknown): Record<string, unknown>[] { return value as Record<string, unknown>[]; }
function id(value: string, label: string): string {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  return result.data;
}
function assertPreparationScope(requestRow: Record<string, unknown>, preparationId?: string): void {
  if (preparationId !== undefined && String(requestRow.preparation_id).toLowerCase() !== id(preparationId, "Preparation").toLowerCase()) {
    throw new DomainError("CROSS_PROJECT_REFERENCE", "AI synthesis request does not belong to this preparation");
  }
}
function asDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    // Use code-unit ordering rather than locale-sensitive comparison so the
    // request hashes are identical across runtimes and host locales.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
function hashCanonical(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex"); }
function textHash(value: string): string { return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex"); }
function codePoints(value: string): number { return Array.from(value).length; }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
type AiHistoryCursor = { version: 1; projectId: string; preparationId: string; createdAt: string; requestId: string };
function encodeAiHistoryCursor(cursor: AiHistoryCursor): string { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeAiHistoryCursor(value: string, projectId: string, preparationId: string): AiHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const cursorProjectId = typeof parsed.projectId === "string" ? id(parsed.projectId, "Cursor Project") : "";
    const cursorPreparationId = typeof parsed.preparationId === "string" ? id(parsed.preparationId, "Cursor Preparation") : "";
    const cursorRequestId = typeof parsed.requestId === "string" ? id(parsed.requestId, "Cursor request") : "";
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    if (parsed.version !== 1 || cursorProjectId !== projectId || cursorPreparationId !== preparationId
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt)
      || Number.isNaN(Date.parse(createdAt))) {
      throw new Error("invalid scope or key");
    }
    return { version: 1, projectId: cursorProjectId, preparationId: cursorPreparationId, createdAt, requestId: cursorRequestId };
  } catch {
    throw new DomainError("VALIDATION_ERROR", "AI synthesis history cursor is invalid for this preparation");
  }
}
function mapRequest(row: Record<string, unknown>) {
  return {
    id: String(row.id), projectId: String(row.project_id), preparationId: String(row.preparation_id),
    evidenceSetId: String(row.evidence_set_id), evidenceSetCompositionRevisionId: String(row.evidence_set_composition_revision_id),
    extractionFieldId: String(row.extraction_field_id), targetSynthesisStatementId: row.target_synthesis_statement_id == null ? null : String(row.target_synthesis_statement_id),
    targetBaselineRevisionId: row.target_baseline_synthesis_revision_id == null ? null : String(row.target_baseline_synthesis_revision_id),
    idempotencyKey: String(row.idempotency_key), sourceStateHash: String(row.source_state_hash), intentHash: String(row.intent_hash),
    fieldName: String(row.field_name_snapshot), fieldDescription: row.field_description_snapshot == null ? null : String(row.field_description_snapshot), fieldType: String(row.field_type),
    provider: String(row.provider), model: String(row.configured_model), reasoningEffort: String(row.configured_reasoning_effort),
    promptVersion: String(row.prompt_version), responseSchemaVersion: String(row.response_schema_version), groundingResolverVersion: String(row.grounding_resolver_version), contextSelectionVersion: String(row.context_selection_version),
    sourceCoverageState: String(row.source_coverage_state), supportCount: Number(row.support_count), sourceCount: Number(row.source_count),
    sourceCharacterCount: Number(row.source_character_count), sourceByteSize: Number(row.source_byte_size), sourceManifestHash: String(row.source_manifest_hash),
    externalTransmissionAcknowledged: Boolean(row.external_transmission_acknowledged), disclosureVersion: String(row.disclosure_version),
    createdAt: asDate(row.created_at), undispatchedExpiresAt: asDate(row.undispatched_expires_at),
  };
}
function mapResult(row: Record<string, unknown>) {
  return {
    id: String(row.id), requestId: String(row.request_id), outcome: String(row.outcome), providerDiagnostic: String(row.provider_diagnostic),
    errorCode: row.error_code == null ? null : String(row.error_code), title: row.proposed_title == null ? null : String(row.proposed_title),
    statementText: row.proposed_statement_text == null ? null : String(row.proposed_statement_text), explanation: row.explanation == null ? null : String(row.explanation),
    sourceCoverageState: row.source_coverage_state == null ? null : String(row.source_coverage_state), coveredSupportCount: row.covered_support_count == null ? null : Number(row.covered_support_count),
    groundingCount: row.grounding_count == null ? null : Number(row.grounding_count), providerResponseId: row.provider_request_id == null ? null : String(row.provider_request_id),
    configuredModel: row.configured_model == null ? null : String(row.configured_model), returnedModel: row.returned_model == null ? null : String(row.returned_model),
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens), outputTokens: row.output_tokens == null ? null : Number(row.output_tokens), durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: asDate(row.created_at), finalizedAt: asDate(row.finalized_at),
  };
}
function outcomeOf(result: ProviderSynthesisSuggestionResult): { outcome: Outcome; diagnostic: Diagnostic; errorCode: string | null } {
  if (result.kind === "success") return { outcome: result.suggestion.outcome === "no_candidate" ? "no_candidate" : "succeeded", diagnostic: "success", errorCode: null };
  if (result.failure === "provider_refusal") return { outcome: "failed", diagnostic: "refusal", errorCode: result.code };
  if (result.failure === "provider_incomplete") return { outcome: "failed", diagnostic: "incomplete", errorCode: result.code };
  if (result.failure === "schema_invalid") return { outcome: "invalid_output", diagnostic: "schema_invalid", errorCode: result.code };
  if (result.failure === "api_error") return { outcome: result.code === "configuration_missing" ? "provider_unavailable" : "failed", diagnostic: "api_error", errorCode: result.code };
  return { outcome: "outcome_unknown", diagnostic: "transport_error", errorCode: result.code };
}

export function createAiSynthesisSuggestionServices(
  db: Database,
  provider: SynthesisSuggestionProvider | undefined,
  options: AiSynthesisSuggestionServiceOptions,
): AiSynthesisSuggestionServices {
  const defaultModel = options.defaultModel?.trim() || "gpt-5.6-luna";
  const defaultReasoningEffort = options.defaultReasoningEffort ?? "low";
  const pendingPersistence = new Map<string, ProviderSynthesisSuggestionResult>();
  const inFlightExecutions = new Map<string, Promise<Record<string, unknown>>>();

  async function request(requestId: string, executor: Executor = db, lock = false) {
    const found = rows(await executor.execute(lock
      ? sql`select * from ai_synthesis_requests where id=${requestId}::uuid limit 1 for update`
      : sql`select * from ai_synthesis_requests where id=${requestId}::uuid limit 1`))[0];
    if (!found) throw new DomainError("NOT_FOUND", "AI synthesis request was not found");
    return found;
  }
  async function result(requestId: string, executor: Executor = db) {
    return rows(await executor.execute(sql`select * from ai_synthesis_results where request_id=${requestId}::uuid limit 1`))[0] ?? null;
  }
  async function sourceRows(req: Record<string, unknown>, executor: Executor = db) {
    return rows(await executor.execute(sql`
      select s.*, coalesce(s.source_text, '') as text, s.extraction_revision_id, s.evidence_id
      from ai_synthesis_request_sources s
      join ai_synthesis_request_supports support_order
        on support_order.project_id=s.project_id
       and support_order.request_id=s.request_id
       and support_order.extraction_revision_id=s.extraction_revision_id
      where s.project_id=${String(req.project_id)}::uuid and s.request_id=${String(req.id)}::uuid
      order by s.membership_sort_order, s.page_number, s.evidence_id, support_order.support_ordinal
    `));
  }
  async function supportRows(req: Record<string, unknown>, executor: Executor = db) {
    return rows(await executor.execute(sql`
      select s.* from ai_synthesis_request_supports s
      where s.project_id=${String(req.project_id)}::uuid and s.request_id=${String(req.id)}::uuid
      order by s.support_ordinal
    `));
  }
  function providerInput(req: Record<string, unknown>, supports: Record<string, unknown>[], sources: Record<string, unknown>[]): SynthesisSuggestionInput {
    return {
      preparationId: String(req.preparation_id),
      target: req.target_synthesis_statement_id == null ? { kind: "new" } : { kind: "existing", statementId: String(req.target_synthesis_statement_id) },
      field: { id: String(req.extraction_field_id), name: String(req.field_name_snapshot), description: req.field_description_snapshot == null ? null : String(req.field_description_snapshot), type: String(req.field_type) as SynthesisSuggestionInput["field"]["type"] },
      workingTitle: req.working_title_snapshot == null ? null : String(req.working_title_snapshot),
      workingNote: req.working_note_snapshot == null ? null : String(req.working_note_snapshot),
      supports: supports.map((support) => ({
        id: String(support.extraction_revision_id),
        extractionRevisionId: String(support.extraction_revision_id),
        paperId: String(support.paper_id),
        paperTitle: String(support.paper_title_snapshot),
        paperPublicationYear: support.paper_publication_year_snapshot == null ? null : Number(support.paper_publication_year_snapshot),
        fieldType: String(support.field_type) as SynthesisSuggestionInput["supports"][number]["fieldType"],
        valueState: String(support.value_state) as SynthesisSuggestionInput["supports"][number]["valueState"],
        optionId: support.option_id == null ? null : String(support.option_id),
        optionLabelSnapshot: support.option_label_snapshot == null ? null : String(support.option_label_snapshot),
        researcherNote: support.researcher_note == null ? null : String(support.researcher_note),
        value: support.value_canonical == null ? canonicalValue(support) : String(support.value_canonical),
        connectingEvidence: sources.filter((source) => String(source.extraction_revision_id) === String(support.extraction_revision_id)).map((source) => ({
          id: String(source.evidence_id), evidenceId: String(source.evidence_id), text: String(source.source_text), sourceText: String(source.source_text), pageNumber: Number(source.page_number), reviewState: String(source.evidence_review_state) as "unreviewed" | "needs_review" | "accepted" | "rejected", noteSnapshot: source.evidence_note_snapshot == null ? null : String(source.evidence_note_snapshot),
        })),
      })),
      model: String(req.configured_model), reasoningEffort: String(req.configured_reasoning_effort) as SynthesisSuggestionInput["reasoningEffort"],
      promptVersion: String(req.prompt_version), responseSchemaVersion: String(req.response_schema_version), groundingResolverVersion: String(req.grounding_resolver_version), contextSelectionVersion: String(req.context_selection_version),
      sourceCoverage: { selectedCount: Number(req.support_count), omittedCount: 0, status: "complete" },
    };
  }

  async function materializeExpiredForPreparation(tx: Executor, projectId: string, preparationId: string) {
    const pending = rows(await tx.execute(sql`
      select r.* from ai_synthesis_requests r
      left join ai_synthesis_results x on x.project_id=r.project_id and x.request_id=r.id
      where r.project_id=${projectId}::uuid and r.preparation_id=${preparationId}::uuid and x.id is null
      order by r.created_at, r.id
      for update of r
    `));
    for (const req of pending) {
      const dispatch = rows(await tx.execute(sql`select deadline_at from ai_synthesis_dispatches where project_id=${projectId}::uuid and request_id=${String(req.id)}::uuid limit 1`))[0];
      const expiresAt = dispatch ? asDate(dispatch.deadline_at) : asDate(req.undispatched_expires_at);
      if (!expiresAt || Date.now() < expiresAt.getTime()) continue;
      await tx.execute(sql`
        insert into ai_synthesis_results (project_id,request_id,outcome,provider_diagnostic,error_code,configured_model,finalized_at)
        values (${projectId}::uuid,${String(req.id)}::uuid,${dispatch ? "outcome_unknown" : "failed"},'unknown',${dispatch ? "outcome_unknown" : "request_expired"},${String(req.configured_model)},now())
        on conflict (project_id,request_id) do nothing
      `);
    }
  }

  async function loadBeginContext(tx: Executor, projectId: string, preparationId: string) {
    const prep = rows(await tx.execute(sql`select p.*, pr.title as project_title, f.name as field_name, f.description as field_description, f.field_type, target.title as target_title, target.statement_text as target_statement_text from synthesis_preparations p join projects pr on pr.id=p.project_id join extraction_fields f on f.project_id=p.project_id and f.id=p.extraction_field_id left join lateral (select r.title, r.statement_text from synthesis_revisions r where r.project_id=p.project_id and r.synthesis_statement_id=p.target_synthesis_statement_id and r.finalized_at is not null order by r.sequence desc limit 1) target on true where p.project_id=${projectId}::uuid and p.id=${preparationId}::uuid for update of p`))[0];
    if (!prep) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis preparation does not belong to this project");
    if (String(prep.status) !== "active") throw new DomainError("VALIDATION_ERROR", "AI synthesis suggestions require an active preparation");
    const selectedSupports = rows(await tx.execute(sql`
      select s.extraction_revision_id, s.created_at as selection_created_at
      from synthesis_preparation_selections s
      where s.project_id=${projectId}::uuid and s.preparation_id=${preparationId}::uuid
      order by s.created_at, s.extraction_revision_id
      limit ${AI_SYNTHESIS_LIMITS.maxSupports + 1}
    `));
    if (selectedSupports.length < 1 || selectedSupports.length > AI_SYNTHESIS_LIMITS.maxSupports) {
      throw new DomainError("VALIDATION_ERROR", `Select between ${AI_SYNTHESIS_LIMITS.minSupports} and ${AI_SYNTHESIS_LIMITS.maxSupports} extraction revisions before requesting AI synthesis`);
    }
    const supports = rows(await tx.execute(sql`
      select s.extraction_revision_id, s.created_at as selection_created_at, r.paper_id, r.field_id as extraction_field_id, r.extraction_value_id, r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id, r.researcher_note, p.title as paper_title, p.publication_year as paper_publication_year, o.label as option_label_snapshot
      from synthesis_preparation_selections s
      join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id
      join papers p on p.project_id=r.project_id and p.id=r.paper_id
      left join extraction_options o on o.project_id=r.project_id and o.field_id=r.field_id and o.id=r.option_id
      where s.project_id=${projectId}::uuid and s.preparation_id=${preparationId}::uuid and r.field_id=${String(prep.extraction_field_id)}::uuid
        and s.extraction_revision_id in (${sql.join(selectedSupports.map((support) => sql`${String(support.extraction_revision_id)}::uuid`), sql`, `)})
      order by s.created_at, s.extraction_revision_id
    `));
    if (supports.length < 1 || supports.length > AI_SYNTHESIS_LIMITS.maxSupports) {
      throw new DomainError("VALIDATION_ERROR", `Select between ${AI_SYNTHESIS_LIMITS.minSupports} and ${AI_SYNTHESIS_LIMITS.maxSupports} extraction revisions before requesting AI synthesis`);
    }
    const sourceRowsFound = rows(await tx.execute(sql`
      with recursive pinned_revision as (
        select r.project_id, r.evidence_set_id, r.set_ordinal,
          r.head_membership_id, r.tail_membership_id, r.member_count
        from evidence_set_composition_revisions r
        where r.project_id=${projectId}::uuid
          and r.evidence_set_id=${String(prep.evidence_set_id)}::uuid
          and r.id=${String(prep.evidence_set_composition_revision_id)}::uuid
      ), selected_support_order as materialized (
        select s.extraction_revision_id,
          row_number() over (order by s.created_at, s.extraction_revision_id) - 1 as support_ordinal
        from synthesis_preparation_selections s
        where s.project_id=${projectId}::uuid
          and s.preparation_id=${preparationId}::uuid
          and s.extraction_revision_id in (${sql.join(supports.map((support) => sql`${String(support.extraction_revision_id)}::uuid`), sql`, `)})
      ), walk(membership_id, next_membership_id, position) as (
        select v.membership_id, v.next_membership_id, 1
        from pinned_revision r
        join evidence_set_membership_order_versions v
          on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
         and v.membership_id=r.head_membership_id
         and v.valid_from_ordinal <= r.set_ordinal
         and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
        where r.head_membership_id is not null
        union all
        select next_version.membership_id, next_version.next_membership_id,
          walk.position + 1
        from walk
        join pinned_revision r on true
        join evidence_set_membership_order_versions next_version
          on next_version.project_id=r.project_id and next_version.evidence_set_id=r.evidence_set_id
         and next_version.membership_id=walk.next_membership_id
         and next_version.valid_from_ordinal <= r.set_ordinal
         and (next_version.valid_to_ordinal is null or r.set_ordinal < next_version.valid_to_ordinal)
        where walk.next_membership_id is not null
          and walk.position < r.member_count
      ), chain_summary as (
        select r.member_count, r.head_membership_id, r.tail_membership_id,
          count(w.membership_id)::integer as traversed_count,
          count(distinct w.membership_id)::integer as unique_membership_count,
          max(w.position)::integer as final_position,
          coalesce(bool_or(w.membership_id = r.head_membership_id) filter (where w.position = 1), false) as starts_at_head,
          coalesce(bool_or(w.membership_id = r.tail_membership_id) filter (where w.position = r.member_count), false) as ends_at_tail,
          coalesce(bool_or(w.next_membership_id is null) filter (where w.position = r.member_count), false) as tail_is_terminal
        from pinned_revision r
        left join walk w on true
        group by r.member_count, r.head_membership_id, r.tail_membership_id
      ), pinned_chain as (
        select coalesce(bool_and(
          (member_count = 0 and head_membership_id is null and tail_membership_id is null and traversed_count = 0)
          or (member_count > 0 and head_membership_id is not null and tail_membership_id is not null
            and traversed_count = member_count
            and unique_membership_count = member_count
            and final_position = member_count
            and starts_at_head and ends_at_tail and tail_is_terminal)
        ), false) as is_valid
        from chain_summary
      ), connecting_sources as materialized (
        -- The active interval join defines reachability; walk supplies the persisted absolute manifest position only.
        select r.id as extraction_revision_id, r.paper_id, e.id as evidence_id,
          selected.support_ordinal,
          m.id as membership_id, e.page_number, e.source_text,
          e.note as evidence_note_snapshot,
          coalesce(rd.decision,'unreviewed') as evidence_review_state
        from pinned_revision pinned
        join extraction_value_revisions r
          on r.project_id=pinned.project_id
        join selected_support_order selected
          on selected.extraction_revision_id=r.id
        join extraction_revision_evidence ere
          on ere.project_id=r.project_id and ere.revision_id=r.id
        join evidence e on e.project_id=ere.project_id and e.id=ere.evidence_id
        join evidence_set_memberships m
          on m.project_id=pinned.project_id and m.evidence_set_id=pinned.evidence_set_id
         and m.evidence_id=e.id
        join evidence_set_membership_order_versions active_order
          on active_order.project_id=pinned.project_id and active_order.evidence_set_id=pinned.evidence_set_id
         and active_order.membership_id=m.id
         and active_order.valid_from_ordinal <= pinned.set_ordinal
         and (active_order.valid_to_ordinal is null or pinned.set_ordinal < active_order.valid_to_ordinal)
        left join lateral (
          select decision from evidence_review_decisions d
          where d.project_id=e.project_id and d.evidence_id=e.id
          order by d.sequence desc limit 1
        ) rd on true
        where r.project_id=${projectId}::uuid
          and r.id in (${sql.join(supports.map((support) => sql`${String(support.extraction_revision_id)}::uuid`), sql`, `)})
      ), source_candidates as materialized (
        select connected.extraction_revision_id, connected.paper_id, connected.evidence_id,
          connected.support_ordinal,
          connected.membership_id, walk.position as membership_sort_order,
          connected.page_number, connected.source_text, connected.evidence_note_snapshot,
          connected.evidence_review_state,
          row_number() over (
            partition by connected.extraction_revision_id
            order by walk.position, connected.page_number, connected.evidence_id, connected.support_ordinal
          ) - 1 as source_ordinal,
          row_number() over (order by walk.position, connected.page_number, connected.evidence_id, connected.support_ordinal) as request_source_ordinal
        from connecting_sources connected
        left join walk on walk.membership_id=connected.membership_id
      ), support_source_counts as (
        select extraction_revision_id, count(*) as source_count,
          bool_or(char_length(source_text) > 4000) as source_text_limit_exceeded,
          bool_or(membership_sort_order is null) as missing_manifest_order
        from source_candidates group by extraction_revision_id
      ), source_limits as (
        select coalesce(sum(source_count), 0) as total_source_count,
          coalesce(bool_or(source_count > ${AI_SYNTHESIS_LIMITS.maxConnectingEvidencePerSupport}), false) as per_support_limit_exceeded,
          coalesce(bool_or(source_text_limit_exceeded), false) as source_text_limit_exceeded,
          coalesce(bool_or(missing_manifest_order), false) as missing_manifest_order,
          (select is_valid from pinned_chain) as pinned_chain_valid
        from support_source_counts
      ), bounded_source_rows as (
        select source.* from source_candidates source
        where source.source_ordinal < ${AI_SYNTHESIS_LIMITS.maxConnectingEvidencePerSupport}
          and source.request_source_ordinal <= ${AI_SYNTHESIS_LIMITS.maxConnectingEvidencePerRequest}
      )
      select source.*, limits.total_source_count, limits.per_support_limit_exceeded,
        limits.source_text_limit_exceeded, limits.missing_manifest_order, limits.pinned_chain_valid
      from bounded_source_rows source cross join source_limits limits
      order by source.membership_sort_order, source.page_number, source.evidence_id, source.support_ordinal
    `));
    const sourceBySupport = new Map<string, Record<string, unknown>[]>();
    const frozenSources: Array<Record<string, unknown> & { source_ordinal: number }> = sourceRowsFound.map((source) => {
      const sourceOrdinal = Number(source.source_ordinal);
      return { ...source, source_ordinal: sourceOrdinal } as Record<string, unknown> & { source_ordinal: number };
    });
    for (const source of frozenSources) sourceBySupport.set(String(source.extraction_revision_id), [...(sourceBySupport.get(String(source.extraction_revision_id)) ?? []), source]);
    const totalSourceCount = Number(sourceRowsFound[0]?.total_source_count ?? 0);
    if (sourceRowsFound[0]?.pinned_chain_valid !== true) throw new DomainError("DATABASE_CONSTRAINT", "Pinned Evidence Set composition is corrupt");
    if (supports.some((support) => !(sourceBySupport.get(String(support.extraction_revision_id))?.length)) || totalSourceCount > AI_SYNTHESIS_LIMITS.maxConnectingEvidencePerRequest) throw new DomainError("VALIDATION_ERROR", "Every selected extraction revision must have complete connecting Evidence within the pinned composition");
    if (Boolean(sourceRowsFound[0]?.missing_manifest_order)) throw new DomainError("VALIDATION_ERROR", "Every selected extraction revision must have complete connecting Evidence within the pinned composition");
    if (Boolean(sourceRowsFound[0]?.source_text_limit_exceeded)) throw new DomainError("VALIDATION_ERROR", "A connecting Evidence passage exceeds the AI context limit");
    for (const source of frozenSources) {
       if (codePoints(String(source.source_text)) > 4_000) throw new DomainError("VALIDATION_ERROR", "A connecting Evidence passage exceeds the AI context limit");
    }
    if (Boolean(sourceRowsFound[0]?.per_support_limit_exceeded)) throw new DomainError("VALIDATION_ERROR", "connecting_evidence_limit_exceeded");
    const targetId = prep.target_synthesis_statement_id == null ? null : String(prep.target_synthesis_statement_id);
    let baselineId: string | null = null;
    if (targetId) {
      const current = rows(await tx.execute(sql`select id from synthesis_revisions where project_id=${projectId}::uuid and synthesis_statement_id=${targetId}::uuid and finalized_at is not null order by sequence desc limit 1`))[0];
      baselineId = current ? String(current.id) : null;
    }
    const supportManifest = supports.map((support, ordinal) => ({ ordinal, extractionRevisionId: String(support.extraction_revision_id), paperId: String(support.paper_id), extractionFieldId: String(support.extraction_field_id), extractionValueId: String(support.extraction_value_id), fieldType: String(support.field_type), valueState: String(support.value_state), textValue: support.text_value == null ? null : String(support.text_value), numberValue: support.number_value == null ? null : String(support.number_value), booleanValue: support.boolean_value == null ? null : Boolean(support.boolean_value), optionId: support.option_id == null ? null : String(support.option_id), optionLabelSnapshot: support.option_label_snapshot == null ? null : String(support.option_label_snapshot), researcherNote: support.researcher_note == null ? null : String(support.researcher_note), paperTitleSnapshot: String(support.paper_title), paperPublicationYearSnapshot: support.paper_publication_year == null ? null : Number(support.paper_publication_year), valueCanonical: canonicalValue(support) }));
    const sourceManifest = frozenSources.map((source, ordinal) => ({ ordinal, sourceOrdinal: Number(source.source_ordinal), extractionRevisionId: String(source.extraction_revision_id), evidenceId: String(source.evidence_id), paperId: String(source.paper_id ?? ""), membershipId: String(source.membership_id), membershipSortOrder: Number(source.membership_sort_order), pageNumber: Number(source.page_number), sourceTextHash: textHash(String(source.source_text)), sourceText: String(source.source_text), evidenceReviewState: String(source.evidence_review_state), evidenceNoteSnapshot: source.evidence_note_snapshot == null ? null : String(source.evidence_note_snapshot) }));
    const sourceState = { preparationId, pinnedCompositionRevisionId: String(prep.evidence_set_composition_revision_id), field: { id: String(prep.extraction_field_id), name: String(prep.field_name), description: prep.field_description == null ? null : String(prep.field_description), type: String(prep.field_type) }, targetStatementId: targetId, targetBaselineRevisionId: baselineId, supports: supportManifest, sources: sourceManifest };
    const sourceStateHash = hashCanonical(sourceState);
    const model = defaultModel;
    const reasoning = defaultReasoningEffort;
    return { prep, supports, sources: frozenSources, targetId, baselineId, sourceState, sourceStateHash, model, reasoning };
  }
  function canonicalValue(row: Record<string, unknown>): string {
    const state = String(row.value_state);
    if (state !== "present") return state;
    if (String(row.field_type) === "boolean") return String(Boolean(row.boolean_value));
    if (String(row.field_type) === "single_select") return JSON.stringify({ optionId: row.option_id == null ? null : String(row.option_id), optionLabelSnapshot: row.option_label_snapshot == null ? null : String(row.option_label_snapshot) });
    return String(row.text_value ?? row.number_value ?? "");
  }

  async function persistResult(requestId: string, providerResult: ProviderSynthesisSuggestionResult, override?: { outcome: Outcome; diagnostic: Diagnostic; errorCode: string | null }) {
    return db.transaction(async (tx) => {
      const req = await request(requestId, tx);
      const existing = await result(requestId, tx);
      if (existing) return mapResult(existing);
      const dispatch = rows(await tx.execute(sql`select deadline_at from ai_synthesis_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${requestId}::uuid limit 1`))[0];
      const deadline = asDate(dispatch?.deadline_at);
      let status = override ?? outcomeOf(providerResult);
      if (!override && deadline && Date.now() >= deadline.getTime()) status = { outcome: "outcome_unknown", diagnostic: "transport_error", errorCode: "outcome_unknown" };
      const supports = await supportRows(req, tx);
      const sources = await sourceRows(req, tx);
      const input = providerInput(req, supports, sources);
      let title: string | null = null;
      let statementText: string | null = null;
      let explanation: string | null = null;
      let candidateState: "present" | "not_present" | null = null;
      const resolved: Array<{ extractionRevisionId: string; evidenceId: string; startOffset: number; endOffset: number; locatorQuote: string; locatorPrefix: string | null; locatorSuffix: string | null; sourceText: string }> = [];
      let coveredSupportCount = 0;
       if (providerResult.kind === "success") {
        const checked = validateProviderSynthesisSuggestion(providerResult.suggestion, input);
        if (!checked.ok) status = { outcome: "invalid_output", diagnostic: "schema_invalid", errorCode: checked.code };
        else if (checked.suggestion.outcome === "candidate") {
          candidateState = "present";
          title = checked.suggestion.title; statementText = checked.suggestion.statementText; explanation = checked.suggestion.explanation;
          const grounding = resolveSynthesisSuggestionGroundings(checked.suggestion.groundings, input.supports);
          if (!grounding.ok) status = { outcome: "unresolvable_grounding", diagnostic: "success", errorCode: grounding.code };
          else {
            const supportIds = new Set(supports.map((support) => String(support.extraction_revision_id)));
            const groundedSupportIds = new Set<string>();
            for (const item of grounding.groundings) {
              const source = sources.find((source) => String(source.extraction_revision_id) === item.supportId && String(source.evidence_id) === item.evidenceId);
              if (!source) { status = { outcome: "unresolvable_grounding", diagnostic: "success", errorCode: "grounding_source_unavailable" }; break; }
              groundedSupportIds.add(String(source.extraction_revision_id));
              resolved.push({ extractionRevisionId: String(source.extraction_revision_id), evidenceId: String(source.evidence_id), startOffset: item.startOffset, endOffset: item.endOffset, locatorQuote: item.locatorQuote, locatorPrefix: item.locatorPrefix, locatorSuffix: item.locatorSuffix, sourceText: item.sourceText });
       }
       // A result that cannot be normalized or grounded is terminal failure,
       // never a partially persisted candidate. The result CHECK constraint
       // requires all candidate fields to be null for these outcomes.
       if (status.outcome !== "succeeded" && status.outcome !== "no_candidate") {
         title = null;
         statementText = null;
         explanation = null;
         candidateState = null;
         resolved.length = 0;
         coveredSupportCount = 0;
       }
            if (status.outcome === "succeeded" && [...supportIds].some((supportId) => !groundedSupportIds.has(supportId))) status = { outcome: "unresolvable_grounding", diagnostic: "success", errorCode: "missing_support_grounding" };
            if (status.outcome === "succeeded") coveredSupportCount = groundedSupportIds.size;
          }
        } else if (checked.suggestion.outcome === "no_candidate") {
          candidateState = "not_present";
          explanation = checked.suggestion.explanation;
        }
      }
      const metadata = providerResult.metadata;
      const inserted = rows(await tx.execute(sql`insert into ai_synthesis_results (project_id,request_id,outcome,provider_diagnostic,error_code,candidate_state,proposed_title,proposed_statement_text,explanation,source_coverage_state,covered_support_count,grounding_count,provider_request_id,configured_model,returned_model,input_tokens,output_tokens,duration_ms,finalized_at) values (${String(req.project_id)}::uuid,${requestId}::uuid,${status.outcome},${status.diagnostic},${status.errorCode},${candidateState},${title},${statementText},${explanation},${String(req.source_coverage_state)},${coveredSupportCount},${resolved.length},${metadata.responseId},${String(req.configured_model)},${metadata.returnedModel},${metadata.inputTokens},${metadata.outputTokens},${metadata.durationMs},now()) returning *`));
      if (!inserted[0]) throw new DomainError("DATABASE_CONSTRAINT", "AI synthesis result could not be recorded");
      if (status.outcome === "succeeded") for (const item of resolved) await tx.execute(sql`insert into ai_synthesis_result_groundings (project_id,request_id,result_id,extraction_revision_id,evidence_id,page_number,start_offset,end_offset,locator_quote,locator_prefix,locator_suffix,source_text) values (${String(req.project_id)}::uuid,${requestId}::uuid,${String(inserted[0].id)}::uuid,${item.extractionRevisionId}::uuid,${item.evidenceId}::uuid,${sources.find((source) => String(source.evidence_id) === item.evidenceId && String(source.extraction_revision_id) === item.extractionRevisionId)?.page_number ?? 0},${item.startOffset},${item.endOffset},${item.locatorQuote},${item.locatorPrefix},${item.locatorSuffix},${item.sourceText})`);
      return mapResult(inserted[0]);
    });
  }

  return {
    async beginAiSynthesisSuggestion(input) {
      const projectId = id(input.projectId, "Project");
      const preparationId = id(input.preparationId, "Preparation");
      const key = id(input.idempotencyKey, "Idempotency key");
      if (!input.externalTransmissionAcknowledged) throw new DomainError("VALIDATION_ERROR", "External transmission acknowledgement is required");
      const disclosureVersion = input.disclosureVersion.trim();
      if (!disclosureVersion || disclosureVersion.length > 100) throw new DomainError("VALIDATION_ERROR", "Disclosure version is invalid");
      return db.transaction(async (tx) => {
        const context = await loadBeginContext(tx, projectId, preparationId);
        await materializeExpiredForPreparation(tx, projectId, preparationId);
        const model = input.model?.trim() || context.model;
        const reasoning = input.reasoningEffort ?? context.reasoning;
        if (!model || model.length > 200) throw new DomainError("VALIDATION_ERROR", "AI model configuration is invalid");
        if (!(new Set(["none", "minimal", "low", "medium", "high", "xhigh"])).has(reasoning)) throw new DomainError("VALIDATION_ERROR", "AI reasoning configuration is invalid");
        const intentHash = hashCanonical({ sourceStateHash: context.sourceStateHash, provider: "openai", model, reasoningEffort: reasoning, promptVersion: PROMPT_VERSION, responseSchemaVersion: RESPONSE_SCHEMA_VERSION, groundingResolverVersion: GROUNDING_RESOLVER_VERSION, contextSelectionVersion: CONTEXT_SELECTION_VERSION, disclosureVersion });
        const existingByKey = rows(await tx.execute(sql`select * from ai_synthesis_requests where project_id=${projectId}::uuid and idempotency_key=${key}::uuid limit 1`))[0];
        if (existingByKey) {
          if (String(existingByKey.intent_hash) !== intentHash) throw new DomainError("VALIDATION_ERROR", "Idempotency key was already used for a different AI synthesis request");
          return { requestId: String(existingByKey.id), created: false, request: mapRequest(existingByKey) };
        }
        const unresolved = rows(await tx.execute(sql`select r.id from ai_synthesis_requests r left join ai_synthesis_results x on x.project_id=r.project_id and x.request_id=r.id where r.project_id=${projectId}::uuid and r.preparation_id=${preparationId}::uuid and r.source_state_hash=${context.sourceStateHash} and x.id is null limit 1`))[0];
        if (unresolved) throw new DomainError("VALIDATION_ERROR", "An unresolved AI synthesis request already exists for this preparation");
        const sources: Array<Record<string, unknown> & { sourceOrdinal: number }> = context.sources.map((source) => ({ ...source, sourceOrdinal: Number(source.source_ordinal) }));
        const sourceCharacters = sources.reduce((sum, source) => sum + codePoints(String(source.source_text)), 0);
        const sourceBytes = sources.reduce((sum, source) => sum + byteLength(String(source.source_text)), 0);
        if (sourceCharacters > AI_SYNTHESIS_LIMITS.maxSourceCodePoints || sourceBytes > AI_SYNTHESIS_LIMITS.maxSerializedInputBytes) throw new DomainError("VALIDATION_ERROR", "Frozen AI synthesis context exceeds the source limit");
        const providerContext = providerInput({ ...context.prep, preparation_id: preparationId, target_synthesis_statement_id: context.targetId, extraction_field_id: context.prep.extraction_field_id, field_name_snapshot: context.prep.field_name, field_description_snapshot: context.prep.field_description, configured_model: model, configured_reasoning_effort: reasoning, prompt_version: PROMPT_VERSION, response_schema_version: RESPONSE_SCHEMA_VERSION, grounding_resolver_version: GROUNDING_RESOLVER_VERSION, context_selection_version: CONTEXT_SELECTION_VERSION, support_count: context.supports.length, source_coverage_state: "complete", working_title_snapshot: context.prep.working_title, working_note_snapshot: context.prep.working_note }, context.supports.map((support) => ({ ...support, value_canonical: canonicalValue(support) })), sources);
        const checked = validateSynthesisSuggestionInput(providerContext);
        if (!checked.ok) throw new DomainError("VALIDATION_ERROR", checked.detail);
        const requestId = randomUUID();
        const sourceManifestHash = hashCanonical(context.sourceState.sources);
        const inserted = rows(await tx.execute(sql`insert into ai_synthesis_requests (id,project_id,project_title_snapshot,preparation_id,evidence_set_id,evidence_set_composition_revision_id,extraction_field_id,target_synthesis_statement_id,target_baseline_synthesis_revision_id,target_title_snapshot,target_statement_text_snapshot,idempotency_key,source_state_hash,intent_hash,field_name_snapshot,field_description_snapshot,field_type,provider,configured_model,configured_reasoning_effort,prompt_version,response_schema_version,grounding_resolver_version,context_selection_version,source_coverage_state,support_count,source_count,source_character_count,source_byte_size,source_manifest_hash,external_transmission_acknowledged,disclosure_version,created_at,undispatched_expires_at) values (${requestId}::uuid,${projectId}::uuid,${String(context.prep.project_title)},${preparationId}::uuid,${String(context.prep.evidence_set_id)}::uuid,${String(context.prep.evidence_set_composition_revision_id)}::uuid,${String(context.prep.extraction_field_id)}::uuid,${context.targetId ? sql`${context.targetId}::uuid` : sql`null`},${context.baselineId ? sql`${context.baselineId}::uuid` : sql`null`},${context.prep.target_title == null ? null : String(context.prep.target_title)},${context.prep.target_statement_text == null ? null : String(context.prep.target_statement_text)},${key}::uuid,${context.sourceStateHash},${intentHash},${String(context.prep.field_name)},${context.prep.field_description == null ? null : String(context.prep.field_description)},${String(context.prep.field_type)},'openai',${model},${reasoning},${PROMPT_VERSION},${RESPONSE_SCHEMA_VERSION},${GROUNDING_RESOLVER_VERSION},${CONTEXT_SELECTION_VERSION},'complete',${context.supports.length},${sources.length},${sourceCharacters},${sourceBytes},${sourceManifestHash},true,${disclosureVersion},now(),now()+interval '5 minutes') returning *`));
        for (let ordinal = 0; ordinal < context.supports.length; ordinal += 1) {
          const support = context.supports[ordinal];
          await tx.execute(sql`insert into ai_synthesis_request_supports (project_id,request_id,extraction_revision_id,support_ordinal,paper_id,extraction_field_id,extraction_value_id,field_type,value_state,text_value,number_value,boolean_value,option_id,option_label_snapshot,researcher_note,paper_title_snapshot,paper_publication_year_snapshot) values (${projectId}::uuid,${requestId}::uuid,${String(support.extraction_revision_id)}::uuid,${ordinal},${String(support.paper_id)}::uuid,${String(support.extraction_field_id)}::uuid,${String(support.extraction_value_id)}::uuid,${String(support.field_type)},${String(support.value_state)},${support.text_value == null ? null : String(support.text_value)},${support.number_value == null ? null : String(support.number_value)},${support.boolean_value == null ? null : Boolean(support.boolean_value)},${support.option_id == null ? sql`null` : sql`${String(support.option_id)}::uuid`},${support.option_label_snapshot == null ? null : String(support.option_label_snapshot)},${support.researcher_note == null ? null : String(support.researcher_note)},${String(support.paper_title)},${support.paper_publication_year == null ? null : Number(support.paper_publication_year)})`);
        }
        for (const source of sources) await tx.execute(sql`insert into ai_synthesis_request_sources (project_id,request_id,extraction_revision_id,evidence_id,paper_id,source_ordinal,membership_id,membership_sort_order,page_number,source_text,source_text_sha256,source_character_count,source_byte_size,evidence_review_state,evidence_note_snapshot) values (${projectId}::uuid,${requestId}::uuid,${String(source.extraction_revision_id)}::uuid,${String(source.evidence_id)}::uuid,${String(source.paper_id ?? "")}::uuid,${Number(source.sourceOrdinal)},${String(source.membership_id)}::uuid,${Number(source.membership_sort_order)},${Number(source.page_number)},${String(source.source_text)},${textHash(String(source.source_text))},${codePoints(String(source.source_text))},${byteLength(String(source.source_text))},${String(source.evidence_review_state)},${source.evidence_note_snapshot == null ? null : String(source.evidence_note_snapshot)})`);
        return { requestId, created: true, request: mapRequest(inserted[0]) };
      });
    },
    async executeAiSynthesisSuggestion(requestId, projectId, preparationId) {
      const rid = id(requestId, "Request");
      const expectedProject = projectId ? id(projectId, "Project") : null;
      const claim = await db.transaction(async (tx) => {
        const req = await request(rid, tx, true);
        if (expectedProject && String(req.project_id) !== expectedProject) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI synthesis request does not belong to this project");
        assertPreparationScope(req, preparationId);
        const done = await result(rid, tx);
        if (done) return { done: true as const, value: mapResult(done) };
        const dispatch = rows(await tx.execute(sql`select * from ai_synthesis_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1`))[0];
        if (dispatch) {
          if (asDate(dispatch.deadline_at)?.getTime() != null && Date.now() >= Number(asDate(dispatch.deadline_at)?.getTime())) {
            const unknown = rows(await tx.execute(sql`insert into ai_synthesis_results (project_id,request_id,outcome,provider_diagnostic,error_code,configured_model,finalized_at) values (${String(req.project_id)}::uuid,${rid}::uuid,'outcome_unknown','unknown','outcome_unknown',${String(req.configured_model)},now()) on conflict (project_id,request_id) do nothing returning *`))[0];
            return { done: true as const, value: mapResult(unknown ?? await result(rid, tx)) };
          }
          return { done: false as const, pending: true as const, req };
        }
        if (asDate(req.undispatched_expires_at)?.getTime() != null && Date.now() >= Number(asDate(req.undispatched_expires_at)?.getTime())) {
          const expired = rows(await tx.execute(sql`insert into ai_synthesis_results (project_id,request_id,outcome,provider_diagnostic,error_code,configured_model,finalized_at) values (${String(req.project_id)}::uuid,${rid}::uuid,'failed','unknown','request_expired',${String(req.configured_model)},now()) on conflict (project_id,request_id) do nothing returning *`))[0];
          return { done: true as const, value: mapResult(expired ?? await result(rid, tx)) };
        }
        const claimed = rows(await tx.execute(sql`insert into ai_synthesis_dispatches (project_id,request_id,started_at,deadline_at) values (${String(req.project_id)}::uuid,${rid}::uuid,now(),now()+interval '90 seconds') on conflict (project_id,request_id) do nothing returning *`))[0];
        return claimed ? { done: false as const, pending: false as const, req } : { done: false as const, pending: true as const, req };
      });
      if (claim.done) return claim.value;
      if (claim.pending) {
        const inFlight = inFlightExecutions.get(rid);
        if (inFlight) return inFlight;
        const replay = pendingPersistence.get(rid);
        if (replay) {
          try {
            const persisted = await persistResult(rid, replay);
            pendingPersistence.delete(rid);
            return persisted;
          } catch (error) {
            throw error;
          }
        }
        return this.getAiSynthesisSuggestion(rid, projectId, preparationId);
      }
      const providerExecution = (async () => {
        const replay = pendingPersistence.get(rid);
        if (replay) { const persisted = await persistResult(rid, replay); pendingPersistence.delete(rid); return persisted; }
        const req = claim.req;
        if (!provider) return persistResult(rid, { kind: "failure", failure: "api_error", code: "configuration_missing", metadata: { provider: "openai", configuredModel: String(req.configured_model), returnedModel: null, responseId: null, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 0 } });
        const supports = await supportRows(req); const sources = await sourceRows(req); const input = providerInput(req, supports, sources); const checked = validateSynthesisSuggestionInput(input);
        if (!checked.ok) return persistResult(rid, { kind: "failure", failure: "schema_invalid", code: checked.detail, metadata: { provider: "openai", configuredModel: String(req.configured_model), returnedModel: null, responseId: null, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 0 } });
        let providerResult: ProviderSynthesisSuggestionResult;
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
        try { providerResult = await provider.suggest(input, { signal: controller.signal, timeoutMs: PROVIDER_TIMEOUT_MS }); }
        catch { providerResult = { kind: "failure", failure: "transport_error", code: "outcome_unknown", metadata: { provider: "openai", configuredModel: String(req.configured_model), returnedModel: null, responseId: null, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: PROVIDER_TIMEOUT_MS } }; }
        finally { clearTimeout(timer); }
        try { const persisted = await persistResult(rid, providerResult); pendingPersistence.delete(rid); return persisted; } catch (error) { pendingPersistence.set(rid, providerResult); throw error; }
      })();
      inFlightExecutions.set(rid, providerExecution);
      try { return await providerExecution; } finally { inFlightExecutions.delete(rid); }
    },
    async expireAiSynthesisSuggestion(requestId, projectId, preparationId) {
      const rid = id(requestId, "Request");
      return db.transaction(async (tx) => {
        const req = await request(rid, tx, true); if (projectId && String(req.project_id) !== id(projectId, "Project")) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI synthesis request does not belong to this project");
        assertPreparationScope(req, preparationId);
        const found = await result(rid, tx); if (found) return mapResult(found);
        const dispatch = rows(await tx.execute(sql`select deadline_at from ai_synthesis_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1`))[0];
        const deadline = dispatch ? asDate(dispatch.deadline_at) : asDate(req.undispatched_expires_at);
        if (!deadline || Date.now() < deadline.getTime()) throw new DomainError("VALIDATION_ERROR", "AI synthesis request has not reached its expiry deadline");
        const inserted = rows(await tx.execute(sql`insert into ai_synthesis_results (project_id,request_id,outcome,provider_diagnostic,error_code,configured_model,finalized_at) values (${String(req.project_id)}::uuid,${rid}::uuid,${dispatch ? "outcome_unknown" : "failed"},'unknown',${dispatch ? "outcome_unknown" : "request_expired"},${String(req.configured_model)},now()) on conflict (project_id,request_id) do nothing returning *`))[0];
        return mapResult(inserted ?? await result(rid, tx));
      });
    },
    async getAiSynthesisSuggestion(requestId, projectId, preparationId) {
      const rid = id(requestId, "Request"); const req = await request(rid);
      if (projectId && String(req.project_id) !== id(projectId, "Project")) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI synthesis request does not belong to this project");
      assertPreparationScope(req, preparationId);
      const found = await result(rid); const supports = await supportRows(req); const sources = await sourceRows(req); const groundings = found ? rows(await db.execute(sql`select * from ai_synthesis_result_groundings where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid and result_id=${String(found.id)}::uuid order by created_at,id`)) : [];
      const decision = rows(await db.execute(sql`select * from ai_synthesis_decisions where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1`))[0] ?? null;
      return { request: mapRequest(req), supports, sources, result: found ? mapResult(found) : null, groundings, decision, dispatch: rows(await db.execute(sql`select * from ai_synthesis_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1`))[0] ?? null };
    },
    async listAiSynthesisSuggestions(projectId, preparationId) {
      const p = id(projectId, "Project"), prep = id(preparationId, "Preparation");
      const found = rows(await db.execute(sql`select r.*, x.id as result_id, x.outcome, x.provider_diagnostic, x.error_code, x.candidate_state, x.proposed_title, x.proposed_statement_text, x.explanation, x.source_coverage_state as result_source_coverage_state, x.covered_support_count, x.grounding_count, x.provider_request_id, x.configured_model as result_configured_model, x.returned_model, x.input_tokens, x.output_tokens, x.duration_ms, x.created_at as result_created_at, x.finalized_at as result_finalized_at, d.decision, d.resulting_synthesis_revision_id from ai_synthesis_requests r left join ai_synthesis_results x on x.project_id=r.project_id and x.request_id=r.id left join ai_synthesis_decisions d on d.project_id=r.project_id and d.request_id=r.id where r.project_id=${p}::uuid and r.preparation_id=${prep}::uuid order by r.created_at desc`));
      return found.map((row) => ({ request: mapRequest(row), result: row.result_id == null ? null : mapResult({ ...row, id: row.result_id, request_id: row.id, source_coverage_state: row.result_source_coverage_state, configured_model: row.result_configured_model, created_at: row.result_created_at, finalized_at: row.result_finalized_at }) }));
    },
    async listAiSynthesisSuggestionHistoryPage(projectId, preparationId, options = {}) {
      const p = id(projectId, "Project").toLowerCase();
      const prep = id(preparationId, "Preparation").toLowerCase();
      const requestedPageSize = options.pageSize ?? 25;
      const pageSize = Number.isSafeInteger(requestedPageSize)
        ? Math.min(50, Math.max(1, requestedPageSize))
        : 25;
      const cursor = options.cursor ? decodeAiHistoryCursor(options.cursor, p, prep) : null;
      const cursorPredicate = cursor
        ? sql`and (r.created_at, r.id) < (${cursor.createdAt}::timestamptz, ${cursor.requestId}::uuid)`
        : sql``;
      const found = rows(await db.execute(sql`
        with request_page_keys as materialized (
          select r.id, r.project_id, r.preparation_id, r.created_at
          from ai_synthesis_requests r
          where r.project_id=${p}::uuid and r.preparation_id=${prep}::uuid
            ${cursorPredicate}
          order by r.created_at desc nulls last, r.id desc nulls last
          limit ${pageSize + 1}
        ), requests_page as materialized (
          select page_keys.id, page_keys.project_id, page_keys.preparation_id, page_keys.created_at,
            to_char(page_keys.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
            left(r.provider, 100) as provider,
            left(r.configured_model, 100) as model,
            left(x.returned_model, 100) as returned_model,
            x.id as result_id, x.outcome,
            left(x.provider_diagnostic, 240) as provider_diagnostic,
            x.error_code, x.candidate_state, x.finalized_at as result_finalized_at,
            x.input_tokens, x.output_tokens, x.duration_ms,
            d.decision, d.resulting_synthesis_revision_id
          from request_page_keys page_keys
          join ai_synthesis_requests r
            on r.project_id=page_keys.project_id and r.preparation_id=page_keys.preparation_id and r.id=page_keys.id
          left join ai_synthesis_results x
            on x.project_id=r.project_id and x.request_id=r.id
          left join ai_synthesis_decisions d
            on d.project_id=r.project_id and d.request_id=r.id
        ), visible_page as materialized (
          select * from requests_page
          order by created_at desc nulls last, id desc nulls last
          limit ${pageSize}
        ), support_counts as (
          select s.request_id, count(*) as support_count
          from ai_synthesis_request_supports s
          join visible_page visible
            on visible.project_id=s.project_id and visible.id=s.request_id
          group by s.request_id
        ), source_counts as (
          select s.request_id, count(*) as source_count
          from ai_synthesis_request_sources s
          join visible_page visible
            on visible.project_id=s.project_id and visible.id=s.request_id
          group by s.request_id
        ), grounding_counts as (
          select g.request_id, count(*) as grounding_count
          from ai_synthesis_result_groundings g
          join visible_page visible
            on visible.project_id=g.project_id and visible.result_id=g.result_id
          group by g.request_id
        ), page_state as (
          select count(*) > ${pageSize} as has_more from requests_page
        )
        select visible.*, coalesce(support_counts.support_count, 0) as support_count,
          coalesce(source_counts.source_count, 0) as source_count,
          coalesce(grounding_counts.grounding_count, 0) as grounding_count,
          page_state.has_more
        from visible_page visible
        left join support_counts on support_counts.request_id=visible.id
        left join source_counts on source_counts.request_id=visible.id
        left join grounding_counts on grounding_counts.request_id=visible.id
        cross join page_state
        order by visible.created_at desc nulls last, visible.id desc nulls last
      `));
      const items: AiSynthesisSuggestionHistoryItem[] = found.map((row) => ({
        requestId: String(row.id),
        preparationId: String(row.preparation_id),
        createdAt: asDate(row.created_at),
        provider: String(row.provider),
        model: String(row.model),
        returnedModel: row.returned_model == null ? null : String(row.returned_model),
        outcome: row.outcome == null ? null : String(row.outcome),
        providerDiagnostic: row.provider_diagnostic == null ? null : String(row.provider_diagnostic),
        errorCode: row.error_code == null ? null : String(row.error_code),
        candidateState: row.candidate_state == null ? null : String(row.candidate_state),
        resultFinalizedAt: asDate(row.result_finalized_at),
        decision: row.decision == null ? null : String(row.decision),
        resultingSynthesisRevisionId: row.resulting_synthesis_revision_id == null ? null : String(row.resulting_synthesis_revision_id),
        supportCount: Number(row.support_count),
        sourceCount: Number(row.source_count),
        groundingCount: Number(row.grounding_count),
        inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
        outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      }));
      const hasMore = found.length > 0 && Boolean(found[0].has_more);
      const last = found.at(-1);
      const nextCursor = hasMore && last
        ? encodeAiHistoryCursor({ version: 1, projectId: p, preparationId: prep, createdAt: String(last.cursor_created_at), requestId: String(last.id).toLowerCase() })
        : null;
      return { items, pageSize, hasMore, nextCursor };
    },
    async rejectAiSynthesisSuggestion(projectId, requestId, preparationId) {
      const p = id(projectId, "Project"), rid = id(requestId, "Request");
      return db.transaction(async (tx) => {
        const req = await request(rid, tx); if (String(req.project_id) !== p) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI synthesis request does not belong to this project");
        assertPreparationScope(req, preparationId);
        const existing = rows(await tx.execute(sql`select * from ai_synthesis_decisions where project_id=${p}::uuid and request_id=${rid}::uuid limit 1`))[0];
        if (existing) {
          if (String(existing.decision) !== "rejected") throw new DomainError("VALIDATION_ERROR", "This AI synthesis request was already accepted");
          return existing;
        }
        const current = await result(rid, tx); if (!current || !["succeeded", "no_candidate"].includes(String(current.outcome))) throw new DomainError("VALIDATION_ERROR", "Only a completed AI candidate or no-candidate result can be rejected");
        const inserted = rows(await tx.execute(sql`insert into ai_synthesis_decisions (project_id,request_id,decision) values (${p}::uuid,${rid}::uuid,'rejected') returning *`))[0]; return inserted;
      });
    },
    async acceptAiSynthesisSuggestion(input) {
      const projectId = id(input.projectId, "Project"), requestId = id(input.requestId, "Request");
      if (input.mode !== "accept" && input.mode !== "edit_and_accept") throw new DomainError("VALIDATION_ERROR", "Invalid AI synthesis acceptance mode");
      return db.transaction(async (tx) => {
        const req = await request(requestId, tx); if (String(req.project_id) !== projectId) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI synthesis request does not belong to this project");
        assertPreparationScope(req, input.preparationId);
        const existing = rows(await tx.execute(sql`select * from ai_synthesis_decisions where project_id=${projectId}::uuid and request_id=${requestId}::uuid limit 1`))[0];
        if (existing) {
          if (String(existing.decision) !== "accepted") throw new DomainError("VALIDATION_ERROR", "This AI synthesis request was already rejected");
          if (String(existing.acceptance_mode) !== input.mode) throw new DomainError("VALIDATION_ERROR", "This AI synthesis request was already accepted with a different mode");
          if (input.mode === "edit_and_accept") {
            const prepSnapshot = rows(await tx.execute(sql`select working_title, working_note from synthesis_preparations where project_id=${projectId}::uuid and id=(select preparation_id from ai_synthesis_requests where project_id=${projectId}::uuid and id=${requestId}::uuid)`))[0];
            const submittedTitle = input.title ?? (prepSnapshot?.working_title == null ? null : String(prepSnapshot.working_title));
            const submittedStatement = input.statementText ?? "";
            const submittedNote = input.researcherNote ?? (prepSnapshot?.working_note == null ? null : String(prepSnapshot.working_note));
            if ((existing.title == null ? null : String(existing.title)) !== submittedTitle || String(existing.statement_text) !== submittedStatement || (existing.researcher_note == null ? null : String(existing.researcher_note)) !== submittedNote) {
              throw new DomainError("VALIDATION_ERROR", "This AI synthesis request was already accepted with different text");
            }
          }
          return { decision: existing };
        }
        const aiResult = await result(requestId, tx); if (!aiResult || String(aiResult.outcome) !== "succeeded" || String(aiResult.candidate_state) !== "present") throw new DomainError("VALIDATION_ERROR", "Only a successful AI candidate can be accepted");
        const title = input.mode === "accept" ? (aiResult.proposed_title == null ? null : String(aiResult.proposed_title)) : (input.title ?? null);
        const statementText = input.mode === "accept" ? String(aiResult.proposed_statement_text ?? "") : String(input.statementText ?? "");
        const researcherNote = input.mode === "edit_and_accept" ? (input.researcherNote ?? null) : null;
        const values = finalizeSynthesisPreparationSchema.safeParse({ title: title ?? undefined, statementText, researcherNote: researcherNote ?? undefined });
        if (!values.success) throw new DomainError("VALIDATION_ERROR", "AI acceptance text failed canonical synthesis validation", values.error.issues);
        // Lock in the same order as the preparation finalization path: first the
        // preparation, then its field.  The separate field lock makes the
        // archived-at check true for the transaction that commits acceptance,
        // while avoiding a join lock-order inversion with field writers.
        const [prep] = await tx.execute(sql`select p.* from synthesis_preparations p where p.project_id=${projectId}::uuid and p.id=${String(req.preparation_id)}::uuid for update`) as unknown as Record<string, unknown>[];
        if (!prep || String(prep.status) !== "active") throw new DomainError("VALIDATION_ERROR", "The preparation changed; generate a new AI suggestion");
        const [field] = await tx.execute(sql`select id, name, description, field_type, archived_at from extraction_fields where project_id=${projectId}::uuid and id=${String(prep.extraction_field_id)}::uuid for update`) as unknown as Record<string, unknown>[];
        if (!field || field.archived_at != null) throw new DomainError("VALIDATION_ERROR", "The extraction field was archived; generate a new AI suggestion");
        if (String(prep.evidence_set_id) !== String(req.evidence_set_id) || String(prep.evidence_set_composition_revision_id) !== String(req.evidence_set_composition_revision_id) || String(prep.extraction_field_id) !== String(req.extraction_field_id) || String(field.name) !== String(req.field_name_snapshot) || (field.description == null ? null : String(field.description)) !== (req.field_description_snapshot == null ? null : String(req.field_description_snapshot)) || String(field.field_type) !== String(req.field_type) || (prep.target_synthesis_statement_id == null ? null : String(prep.target_synthesis_statement_id)) !== (req.target_synthesis_statement_id == null ? null : String(req.target_synthesis_statement_id))) throw new DomainError("VALIDATION_ERROR", "The preparation context changed; generate a new AI suggestion");
        const canonicalDecisionTitle = title ?? (prep.working_title == null ? null : String(prep.working_title));
        const canonicalDecisionNote = researcherNote ?? (prep.working_note == null ? null : String(prep.working_note));
        const finalizerOptions: FinalizeSynthesisPreparationTransactionOptions = { expectedSelectionIds: (await supportRows(req, tx)).map((support) => String(support.extraction_revision_id)) };
        if (req.target_synthesis_statement_id != null) finalizerOptions.expectedCurrentTargetRevisionId = req.target_baseline_synthesis_revision_id == null ? null : String(req.target_baseline_synthesis_revision_id);
        const finalized = await options.finalizePreparationInTransaction(tx, projectId, String(req.preparation_id), values.data, finalizerOptions);
        const decisionRows = rows(await tx.execute(sql`insert into ai_synthesis_decisions (project_id,request_id,decision,acceptance_mode,expected_current_target_revision_id,resulting_synthesis_revision_id,title,statement_text,researcher_note) values (${projectId}::uuid,${requestId}::uuid,'accepted',${input.mode},${req.target_baseline_synthesis_revision_id == null ? sql`null` : sql`${String(req.target_baseline_synthesis_revision_id)}::uuid`},${String(finalized.revision.id)}::uuid,${canonicalDecisionTitle},${statementText},${canonicalDecisionNote}) returning *`));
        return { decision: decisionRows[0], revision: finalized.revision, statement: finalized.statement };
      });
    },
  };
}
