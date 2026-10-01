/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import type { ResearchQuestionAnswerSnapshot } from "@/domain/types";
import type {
  ResearchQuestionAnswerBoundedCandidateType,
  ResearchQuestionAnswerBrowserSnapshot,
  ResearchQuestionAnswerCandidatePage,
  ResearchQuestionAnswerHistoryItem,
  ResearchQuestionAnswerHistoryPage,
  ResearchQuestionBoundedPage,
  ResearchQuestionClaimLinkRow,
  ResearchQuestionEvidenceSetLinkRow,
  ResearchQuestionExtractionCoveragePage,
  ResearchQuestionExtractionCoverageRow,
  ResearchQuestionExtractionLinkRow,
  ResearchQuestionFlagCounts,
  ResearchQuestionMatrixPage,
  ResearchQuestionMatrixPageOptions,
  ResearchQuestionMatrixPageRow,
  ResearchQuestionSynthesisLinkRow,
  ResearchQuestionTargetPickerPage,
  ResearchQuestionTargetPickerRow,
  ResearchQuestionTraceabilityHistoryEvent,
  ResearchQuestionTraceabilityTargetDetail,
  ResearchQuestionTraceabilityTargetType,
  ResearchQuestionWorkspace,
} from "./research-question-bounded-read-types";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_LIMIT = 2048;
const MAX_BIGINT = BigInt("9223372036854775807");
const MIN_BIGINT = BigInt("-9223372036854775808");
export const RESEARCH_QUESTION_MATRIX_DEFAULT_PAGE_SIZE = 50;
export const RESEARCH_QUESTION_MATRIX_MAX_PAGE_SIZE = 100;
export const RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE = 25;
export const RESEARCH_QUESTION_LINK_MAX_PAGE_SIZE = 50;
export const RESEARCH_QUESTION_TARGET_HISTORY_DEFAULT_PAGE_SIZE = 20;
export const RESEARCH_QUESTION_TARGET_HISTORY_MAX_PAGE_SIZE = 25;
export const RESEARCH_QUESTION_COVERAGE_DEFAULT_PAGE_SIZE = 25;
export const RESEARCH_QUESTION_COVERAGE_MAX_PAGE_SIZE = 100;
export const RESEARCH_QUESTION_ANSWER_HISTORY_DEFAULT_PAGE_SIZE = 10;
export const RESEARCH_QUESTION_ANSWER_HISTORY_MAX_PAGE_SIZE = 25;

const FLAG_CODES = [
  "no_linked_extraction_fields", "linked_field_without_current_data", "no_linked_evidence_sets",
  "linked_set_empty", "linked_set_contains_rejected_evidence", "no_linked_synthesis_statements",
  "linked_statement_without_current_active_revision", "linked_current_synthesis_without_support",
  "linked_current_synthesis_without_interpretation", "no_linked_claims",
  "linked_claim_without_current_active_revision", "linked_current_claim_unsupported",
  "linked_current_claim_not_placed",
] as const;

type CursorBase = { v: 1; kind: string; projectId: string; questionId?: string; pageSize: number };
type MatrixCursor = CursorBase & { kind: "rq-matrix"; status: string; sortOrder: number; id: string };
type LinkCursor = CursorBase & { kind: "rq-link"; targetType: ResearchQuestionTraceabilityTargetType; epoch: string; highWaterSequence: string; id: string };
type PickerCursor = CursorBase & { kind: "rq-picker"; targetType: ResearchQuestionTraceabilityTargetType; epoch: string; highWaterSequence: string; search: string; id: string };
type AnswerCandidateCursor = CursorBase & { kind: "rq-answer-candidate"; targetType: ResearchQuestionAnswerBoundedCandidateType; epoch: string; highWaterSequence: string; search: string; id: string };
type CoverageCursor = CursorBase & { kind: "rq-coverage"; epoch: string; highWaterSequence: string; fieldId: string; createdAt: string; id: string };
type HistoryCursor = CursorBase & { kind: "rq-answer-history"; highWaterSequence: string; sequence: string; id: string };
type TargetHistoryCursor = CursorBase & { kind: "rq-target-history"; targetType: ResearchQuestionTraceabilityTargetType; targetId: string; epoch: string; highWaterSequence: string; sequence: string; id: string };

function rows(value: unknown): Row[] { return value as Row[]; }
function uuid(value: unknown, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success || typeof value !== "string" || !UUID.test(value)) throw new DomainError("VALIDATION_ERROR", `${label} must be a valid UUID`);
  return parsed.data.toLowerCase();
}
function pageSize(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("VALIDATION_ERROR", "Page size must be a positive integer");
  return Math.min(value, maximum);
}
function int(value: unknown, label: string): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new DomainError("DATABASE_CONSTRAINT", `${label} is invalid`);
  return n;
}
function bool(value: unknown): boolean { return value === true || value === "t"; }
function date(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(d.getTime())) throw new DomainError("DATABASE_CONSTRAINT", "Database timestamp is invalid");
  return d;
}
function bigintText(value: unknown, label = "Sequence"): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new DomainError("DATABASE_CONSTRAINT", `${label} is invalid`);
  const n = BigInt(text);
  if (n > MAX_BIGINT) throw new DomainError("DATABASE_CONSTRAINT", `${label} is out of range`);
  return text;
}
function cursorBigint(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid cursor bigint");
  const n = BigInt(value);
  if (n > MAX_BIGINT || n < MIN_BIGINT) throw new Error("invalid cursor bigint");
  return value;
}
function cursorInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new Error("invalid cursor integer");
  return value;
}
function cursorUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("invalid cursor uuid");
  return value.toLowerCase();
}
function cursorTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid cursor timestamp");
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (!match) throw new Error("invalid cursor timestamp");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const offsetHour = Number(offsetHourText), offsetMinute = Number(offsetMinuteText ?? "0");
  const days = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59 || offsetHour > 15 || offsetMinute > 59 || (offsetHour === 15 && offsetMinute > 59)) throw new Error("invalid cursor timestamp");
  return value;
}
function parseCursor<T extends Record<string, unknown>>(token: string | null | undefined): T | null {
  if (token == null) return null;
  if (typeof token !== "string" || token.length > CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
  }
  try {
    const decodedText = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decodedText, "utf8").toString("base64url") !== token) throw new Error("non-canonical cursor");
    const decoded: unknown = JSON.parse(decodedText);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid cursor");
    return decoded as T;
  } catch {
    throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
  }
}
function encodeCursor(value: object): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (encoded.length > CURSOR_LIMIT) throw new DomainError("DATABASE_CONSTRAINT", "Page cursor exceeds its size limit");
  return encoded;
}
function bindCursor<T extends CursorBase>(token: string | null | undefined, expected: { kind: string; projectId: string; questionId?: string; pageSize: number }, parse: (raw: Record<string, unknown>) => T): T | null {
  const raw = parseCursor<Record<string, unknown>>(token);
  if (!raw) return null;
  try {
    if (raw.v !== 1 || raw.kind !== expected.kind || raw.projectId !== expected.projectId || raw.questionId !== expected.questionId || raw.pageSize !== expected.pageSize) throw new Error("scope mismatch");
    const parsed = parse(raw);
    if (JSON.stringify(parsed) !== JSON.stringify(raw)) throw new Error("non-canonical object");
    return parsed;
  } catch {
    throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
  }
}
function validateSearch(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new DomainError("VALIDATION_ERROR", "Search text must be text");
  const normalized = input.trim();
  if (Array.from(normalized).length > 200) throw new DomainError("VALIDATION_ERROR", "Search text cannot exceed 200 Unicode code points");
  return normalized;
}
function escapedLike(input: string): string { return input.replace(/[\\%_]/g, "\\$&"); }
function diagnosticCounts(row: Row | undefined): ResearchQuestionFlagCounts {
  const section = (prefix: string) => Object.fromEntries(FLAG_CODES.filter((code) => code.startsWith(prefix) ||
    (prefix === "linked_set" && code.startsWith("linked_set")) ||
    (prefix === "linked_statement" && code.startsWith("linked_statement")) ||
    (prefix === "linked_current_synthesis" && code.startsWith("linked_current_synthesis")) ||
    (prefix === "linked_claim" && code.startsWith("linked_claim")) ||
    (prefix === "linked_current_claim" && code.startsWith("linked_current_claim")))
    .map((code) => [code, int(row?.[code], code)]).filter(([, count]) => Number(count) > 0)) as Partial<Record<(typeof FLAG_CODES)[number], number>>;
  const extraction = section("linked_field");
  if (int(row?.linked_extraction_fields, "Linked extraction field count") === 0) extraction.no_linked_extraction_fields = 1;
  const evidenceSets = section("linked_set");
  if (int(row?.linked_evidence_sets, "Linked Evidence Set count") === 0) evidenceSets.no_linked_evidence_sets = 1;
  const synthesis = section("linked_statement");
  Object.assign(synthesis, section("linked_current_synthesis"));
  if (int(row?.linked_synthesis_statements, "Linked Synthesis count") === 0) synthesis.no_linked_synthesis_statements = 1;
  const claims = section("linked_claim");
  Object.assign(claims, section("linked_current_claim"));
  if (int(row?.linked_claims, "Linked Claim count") === 0) claims.no_linked_claims = 1;
  return { extraction, evidenceSets, synthesis, claims, fullyCovered: false };
}
const LINK_SPECS: Record<ResearchQuestionTraceabilityTargetType, { table: string; column: string }> = {
  "extraction-field": { table: "research_question_extraction_field_events", column: "extraction_field_id" },
  "evidence-set": { table: "research_question_evidence_set_events", column: "evidence_set_id" },
  "synthesis-statement": { table: "research_question_synthesis_statement_events", column: "synthesis_statement_id" },
  claim: { table: "research_question_claim_events", column: "claim_id" },
};

export function createResearchQuestionBoundedReadServices(db: Database) {
  async function readQuestionScope(tx: any, projectId: string, questionId: string, labelLimit = 280) {
    const result = rows(await tx.execute(sql`
      select p.id as project_id,left(p.title,240) as project_title,
        q.id as question_id,left(q.identifier,100) as identifier,left(q.label,${labelLimit}) as label,q.sort_order,q.archived_at,q.traceability_epoch::text as traceability_epoch,
        (select count(*)::int from search_strategies ss where ss.project_id=p.id and ss.archived_at is null) as strategy_count,
        (select count(*)::int from search_runs sr where sr.project_id=p.id) as run_count,
        (select count(*)::int from research_question_answers a where a.project_id=p.id and a.research_question_id=q.id and a.finalized_at is not null) as answer_count,
        (select max(a.sequence)::text from research_question_answers a where a.project_id=p.id and a.research_question_id=q.id and a.finalized_at is not null) as latest_answer_sequence,
        (select count(*)::int from research_question_answer_claim_contexts c join research_question_answers a on a.project_id=c.project_id and a.id=c.answer_id and a.finalized_at is not null where c.project_id=p.id and c.research_question_id=q.id) as claim_context_count,
        (select count(*)::int from research_question_answer_synthesis_contexts c join research_question_answers a on a.project_id=c.project_id and a.id=c.answer_id and a.finalized_at is not null where c.project_id=p.id and c.research_question_id=q.id) as synthesis_context_count,
        coalesce((select max(e.sequence)::text from research_question_extraction_field_events e where e.project_id=p.id and e.research_question_id=q.id),'0') as extraction_high_water,
        coalesce((select max(e.sequence)::text from research_question_evidence_set_events e where e.project_id=p.id and e.research_question_id=q.id),'0') as evidence_set_high_water,
        coalesce((select max(e.sequence)::text from research_question_synthesis_statement_events e where e.project_id=p.id and e.research_question_id=q.id),'0') as synthesis_high_water,
        coalesce((select max(e.sequence)::text from research_question_claim_events e where e.project_id=p.id and e.research_question_id=q.id),'0') as claim_high_water
      from projects p left join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid
      where p.id=${projectId}::uuid limit 1
    `));
    if (!result[0]) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    if (result[0].question_id == null) throw new DomainError("NOT_FOUND", "Research question was not found");
    return result[0];
  }

  function linkRowFlags(targetType: ResearchQuestionTraceabilityTargetType, row: Row): string[] {
    if (targetType === "extraction-field") return bool(row.has_current_data) ? [] : ["linked_field_without_current_data"];
    if (targetType === "evidence-set") {
      const flags: string[] = [];
      if (int(row.member_count, "Evidence Set member count") === 0) flags.push("linked_set_empty");
      if (int(row.rejected_count, "Rejected Evidence count") > 0) flags.push("linked_set_contains_rejected_evidence");
      return flags;
    }
    if (targetType === "synthesis-statement") {
      if (row.current_state !== "active") return ["linked_statement_without_current_active_revision"];
      const flags: string[] = [];
      if (int(row.support_count, "Synthesis support count") === 0) flags.push("linked_current_synthesis_without_support");
      if (!bool(row.interpretation_available)) flags.push("linked_current_synthesis_without_interpretation");
      return flags;
    }
    if (row.current_state !== "active") return ["linked_claim_without_current_active_revision"];
    const flags: string[] = [];
    if (int(row.support_count, "Claim support count") === 0) flags.push("linked_current_claim_unsupported");
    if (int(row.placement_count, "Current Claim placement count") === 0) flags.push("linked_current_claim_not_placed");
    return flags;
  }

  async function readLinkPageRows(tx: any, projectId: string, questionId: string, targetType: ResearchQuestionTraceabilityTargetType, size: number, afterId: string | null, highWaterSequence: string): Promise<Row[]> {
    const targetAlias = targetType === "extraction-field" ? "f" : targetType === "evidence-set" ? "s" : targetType === "synthesis-statement" ? "s" : "c";
    const after = afterId == null ? sql`` : sql`and ${sql.raw(targetAlias)}.id>${afterId}::uuid`;
    if (targetType === "extraction-field") return rows(await tx.execute(sql`
      with latest_link as (select distinct on(e.extraction_field_id) e.extraction_field_id,e.action from research_question_extraction_field_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.extraction_field_id,e.sequence desc,e.id desc), linked as(select extraction_field_id from latest_link where action='linked'),
      included as(select p.id from papers p join(select distinct on(project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId}::uuid and stage='title_abstract' order by project_id,paper_id,sequence desc) ta on ta.project_id=p.project_id and ta.paper_id=p.id and ta.decision='include' join(select distinct on(project_id,paper_id) project_id,paper_id,decision from full_text_screening_decisions where project_id=${projectId}::uuid order by project_id,paper_id,sequence desc) ft on ft.project_id=p.project_id and ft.paper_id=p.id and ft.decision='include' where p.project_id=${projectId}::uuid), current_value as(select distinct on(ev.paper_id,ev.field_id) ev.field_id,r.value_state from extraction_values ev join included i on i.id=ev.paper_id join extraction_value_revisions r on r.project_id=ev.project_id and r.extraction_value_id=ev.id and r.finalized_at is not null where ev.project_id=${projectId}::uuid order by ev.paper_id,ev.field_id,r.sequence desc)
      select f.id,left(f.name,160) as name,f.field_type,f.archived_at,
        exists(select 1 from current_value cv where cv.field_id=f.id and cv.value_state in('present','not_reported','not_applicable')) as has_current_data
      from linked l join extraction_fields f on f.project_id=${projectId}::uuid and f.id=l.extraction_field_id
      where true ${after} order by f.id limit ${size + 1}
    `));
    if (targetType === "evidence-set") return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.evidence_set_id) e.evidence_set_id,e.action from research_question_evidence_set_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.evidence_set_id,e.sequence desc,e.id desc), linked as(select evidence_set_id from latest_link where action='linked')
      select s.id,left(s.name,120) as name,s.archived_at,coalesce(comp.id::text,null) as latest_composition_revision_id,coalesce(stats.member_count,0)::int as member_count,coalesce(stats.rejected_count,0)::int as rejected_count
      from linked l join evidence_sets s on s.project_id=${projectId}::uuid and s.id=l.evidence_set_id
      left join lateral(select r.id,r.set_ordinal from evidence_set_composition_revisions r where r.project_id=${projectId}::uuid and r.evidence_set_id=s.id order by r.set_ordinal desc limit 1) comp on true
      left join lateral(select count(*)::int as member_count,count(*) filter(where rv.decision='rejected')::int as rejected_count from evidence_set_membership_order_versions v join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id join evidence e on e.project_id=m.project_id and e.id=m.evidence_id left join lateral(select d.decision from evidence_review_decisions d where d.project_id=e.project_id and d.evidence_id=e.id order by d.sequence desc limit 1) rv on true where v.project_id=${projectId}::uuid and v.evidence_set_id=s.id and comp.id is not null and v.valid_from_ordinal<=comp.set_ordinal and(v.valid_to_ordinal is null or comp.set_ordinal<v.valid_to_ordinal)) stats on true
      where true ${after} order by s.id limit ${size + 1}
    `));
    if (targetType === "synthesis-statement") return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.synthesis_statement_id) e.synthesis_statement_id,e.action from research_question_synthesis_statement_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.synthesis_statement_id,e.sequence desc,e.id desc), linked as(select synthesis_statement_id from latest_link where action='linked')
      select s.id,coalesce(left(r.title,200),left(r.statement_text,200),'Untitled Statement') as current_title,r.id as current_revision_id,r.state as current_state,
        case when r.state='active' then coalesce(support.n,0)::int else 0 end as support_count,
        case when r.state='active' then exists(select 1 from synthesis_interpretations i where i.project_id=s.project_id and i.synthesis_revision_id=r.id and i.finalized_at is not null) else false end as interpretation_available
      from linked l join synthesis_statements s on s.project_id=${projectId}::uuid and s.id=l.synthesis_statement_id
      left join lateral(select r.id,r.state,r.title,r.statement_text from synthesis_revisions r where r.project_id=s.project_id and r.synthesis_statement_id=s.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true
      left join lateral(select count(*)::int as n from synthesis_revision_supports x where x.project_id=s.project_id and x.synthesis_revision_id=r.id) support on true
      where true ${after} order by s.id limit ${size + 1}
    `));
    return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.claim_id) e.claim_id,e.action from research_question_claim_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.claim_id,e.sequence desc,e.id desc), linked as(select claim_id from latest_link where action='linked')
      select c.id,coalesce(left(r.claim_text,240),case when r.state='withdrawn' then 'Withdrawn Claim' else 'Claim without finalized revision' end) as current_claim_text,r.id as current_revision_id,r.state as current_state,
        case when r.state='active' then coalesce(support.n,0)::int else 0 end as support_count,
        case when r.state='active' then coalesce(placement.n,0)::int else 0 end as placement_count
      from linked l join claims c on c.project_id=${projectId}::uuid and c.id=l.claim_id
      left join lateral(select r.id,r.state,r.claim_text from claim_revisions r where r.project_id=c.project_id and r.claim_id=c.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true
      left join lateral(select (select count(*) from claim_revision_evidence_supports x where x.project_id=c.project_id and x.claim_revision_id=r.id)+(select count(*) from claim_revision_extraction_supports x where x.project_id=c.project_id and x.claim_revision_id=r.id)+(select count(*) from claim_revision_synthesis_supports x where x.project_id=c.project_id and x.claim_revision_id=r.id) as n) support on true
      left join lateral(select count(distinct p.id)::int as n from manuscript_claim_placements p join manuscript_section_item_claims sic on sic.project_id=p.project_id and sic.placement_id=p.id join manuscript_section_items i on i.project_id=sic.project_id and i.id=sic.section_item_id join manuscript_sections s on s.project_id=i.project_id and s.id=i.section_id where p.project_id=c.project_id and p.claim_id=c.id and p.claim_revision_id=r.id and p.removed_at is null and i.removed_at is null and s.archived_at is null) placement on true
      where true ${after} order by c.id limit ${size + 1}
    `));
  }

  async function readPickerRows(tx: any, projectId: string, questionId: string, targetType: ResearchQuestionTraceabilityTargetType, size: number, afterId: string | null, highWaterSequence: string, search: string): Promise<Row[]> {
    const targetAlias = targetType === "extraction-field" ? "t" : targetType === "evidence-set" ? "t" : targetType === "synthesis-statement" ? "t" : "t";
    const after = afterId == null ? sql`` : sql`and ${sql.raw(targetAlias)}.id>${afterId}::uuid`;
    const searchPattern = `%${escapedLike(search)}%`;
    const searchClause = (expression: SQL) => search ? sql`and ${expression} ilike ${searchPattern} escape E'\\\\'` : sql``;
    if (targetType === "extraction-field") return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.extraction_field_id) e.extraction_field_id,e.action from research_question_extraction_field_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.extraction_field_id,e.sequence desc,e.id desc)
      select 'extraction-field'::text as target_type,t.id,left(t.name,240) as label,t.field_type,null::text as state,t.archived_at,(l.action='linked') as is_currently_linked
      from extraction_fields t left join latest_link l on l.extraction_field_id=t.id where t.project_id=${projectId}::uuid and l.action is distinct from 'linked' ${searchClause(sql`t.name`)} ${after} order by t.id limit ${size + 1}
    `));
    if (targetType === "evidence-set") return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.evidence_set_id) e.evidence_set_id,e.action from research_question_evidence_set_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.evidence_set_id,e.sequence desc,e.id desc)
      select 'evidence-set'::text as target_type,t.id,left(t.name,240) as label,null::text as field_type,null::text as state,t.archived_at,(l.action='linked') as is_currently_linked
      from evidence_sets t left join latest_link l on l.evidence_set_id=t.id where t.project_id=${projectId}::uuid and l.action is distinct from 'linked' ${searchClause(sql`t.name`)} ${after} order by t.id limit ${size + 1}
    `));
    if (targetType === "synthesis-statement") return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.synthesis_statement_id) e.synthesis_statement_id,e.action from research_question_synthesis_statement_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.synthesis_statement_id,e.sequence desc,e.id desc)
      select 'synthesis-statement'::text as target_type,t.id,coalesce(left(r.title,240),left(r.statement_text,240),'Untitled Statement') as label,null::text as field_type,r.state,null::timestamptz as archived_at,(l.action='linked') as is_currently_linked
      from synthesis_statements t left join latest_link l on l.synthesis_statement_id=t.id left join lateral(select r.title,r.statement_text,r.state from synthesis_revisions r where r.project_id=t.project_id and r.synthesis_statement_id=t.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true
      where t.project_id=${projectId}::uuid and l.action is distinct from 'linked' ${searchClause(sql`coalesce(r.title,r.statement_text,'Untitled Statement')`)} ${after} order by t.id limit ${size + 1}
    `));
    return rows(await tx.execute(sql`
      with latest_link as(select distinct on(e.claim_id) e.claim_id,e.action from research_question_claim_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.claim_id,e.sequence desc,e.id desc)
      select 'claim'::text as target_type,t.id,coalesce(left(r.claim_text,240),case when r.state='withdrawn' then 'Withdrawn Claim' else 'Claim without finalized revision' end) as label,null::text as field_type,r.state,null::timestamptz as archived_at,(l.action='linked') as is_currently_linked
      from claims t left join latest_link l on l.claim_id=t.id left join lateral(select r.claim_text,r.state from claim_revisions r where r.project_id=t.project_id and r.claim_id=t.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true
      where t.project_id=${projectId}::uuid and l.action is distinct from 'linked' ${searchClause(sql`coalesce(r.claim_text,case when r.state='withdrawn' then 'Withdrawn Claim' else 'Claim without finalized revision' end)`)} ${after} order by t.id limit ${size + 1}
    `));
  }

  async function readDimensionSummary(tx: any, projectId: string, questionId: string, targetType: ResearchQuestionTraceabilityTargetType, highWaterSequence: string): Promise<Row> {
    if (targetType === "extraction-field") {
      const result = rows(await tx.execute(sql`with latest_link as(select distinct on(e.extraction_field_id) e.extraction_field_id,e.action from research_question_extraction_field_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.extraction_field_id,e.sequence desc,e.id desc), linked as(select extraction_field_id from latest_link where action='linked'), included as(select p.id from papers p join(select distinct on(project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId}::uuid and stage='title_abstract' order by project_id,paper_id,sequence desc) ta on ta.project_id=p.project_id and ta.paper_id=p.id and ta.decision='include' join(select distinct on(project_id,paper_id) project_id,paper_id,decision from full_text_screening_decisions where project_id=${projectId}::uuid order by project_id,paper_id,sequence desc) ft on ft.project_id=p.project_id and ft.paper_id=p.id and ft.decision='include' where p.project_id=${projectId}::uuid), current_value as(select distinct on(ev.paper_id,ev.field_id) ev.field_id,r.value_state from extraction_values ev join extraction_value_revisions r on r.project_id=ev.project_id and r.extraction_value_id=ev.id and r.finalized_at is not null join included i on i.id=ev.paper_id where ev.project_id=${projectId}::uuid order by ev.paper_id,ev.field_id,r.sequence desc), state as(select l.extraction_field_id,bool_or(v.value_state in('present','not_reported','not_applicable')) as has_data from linked l left join current_value v on v.field_id=l.extraction_field_id group by l.extraction_field_id) select count(*)::int as linked_extraction_fields,count(*) filter(where not coalesce(s.has_data,false))::int as linked_field_without_current_data from linked l left join state s on s.extraction_field_id=l.extraction_field_id`));
      return result[0] ?? {};
    }
    if (targetType === "evidence-set") {
      const result = rows(await tx.execute(sql`with latest_link as(select distinct on(e.evidence_set_id) e.evidence_set_id,e.action from research_question_evidence_set_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.evidence_set_id,e.sequence desc,e.id desc), linked as(select evidence_set_id from latest_link where action='linked'), latest_comp as(select distinct on(r.evidence_set_id) r.evidence_set_id,r.id,r.set_ordinal from evidence_set_composition_revisions r where r.project_id=${projectId}::uuid and r.evidence_set_id in(select evidence_set_id from linked) order by r.evidence_set_id,r.set_ordinal desc), state as(select l.evidence_set_id,count(m.evidence_id)::int as member_count,count(*) filter(where rv.decision='rejected')::int as rejected_count from linked l left join latest_comp c on c.evidence_set_id=l.evidence_set_id left join evidence_set_membership_order_versions v on v.project_id=${projectId}::uuid and v.evidence_set_id=l.evidence_set_id and c.id is not null and v.valid_from_ordinal<=c.set_ordinal and(v.valid_to_ordinal is null or c.set_ordinal<v.valid_to_ordinal) left join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id left join lateral(select d.decision from evidence_review_decisions d where d.project_id=m.project_id and d.evidence_id=m.evidence_id order by d.sequence desc limit 1) rv on true group by l.evidence_set_id) select count(*)::int as linked_evidence_sets,count(*) filter(where s.member_count=0)::int as linked_set_empty,count(*) filter(where s.rejected_count>0)::int as linked_set_contains_rejected_evidence from linked l left join state s on s.evidence_set_id=l.evidence_set_id`));
      return result[0] ?? {};
    }
    if (targetType === "synthesis-statement") {
      const result = rows(await tx.execute(sql`with latest_link as(select distinct on(e.synthesis_statement_id) e.synthesis_statement_id,e.action from research_question_synthesis_statement_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.synthesis_statement_id,e.sequence desc,e.id desc), linked as(select synthesis_statement_id from latest_link where action='linked'), current_rev as(select distinct on(r.synthesis_statement_id) r.synthesis_statement_id,r.id,r.state from synthesis_revisions r where r.project_id=${projectId}::uuid and r.finalized_at is not null and r.synthesis_statement_id in(select synthesis_statement_id from linked) order by r.synthesis_statement_id,r.sequence desc), state as(select l.synthesis_statement_id,r.id,r.state,(select count(*) from synthesis_revision_supports s where s.project_id=${projectId}::uuid and s.synthesis_revision_id=r.id)::int as support_n,exists(select 1 from synthesis_interpretations i where i.project_id=${projectId}::uuid and i.synthesis_revision_id=r.id and i.finalized_at is not null) as interpreted from linked l left join current_rev r on r.synthesis_statement_id=l.synthesis_statement_id) select count(*)::int as linked_synthesis_statements,count(*) filter(where s.id is not null and s.state='active')::int as active_synthesis_statements,count(*) filter(where s.id is not null and s.state='active' and s.interpreted)::int as interpretations,count(*) filter(where s.id is null or s.state<>'active')::int as linked_statement_without_current_active_revision,count(*) filter(where s.id is not null and s.state='active' and s.support_n=0)::int as linked_current_synthesis_without_support,count(*) filter(where s.id is not null and s.state='active' and not s.interpreted)::int as linked_current_synthesis_without_interpretation from linked l left join state s on s.synthesis_statement_id=l.synthesis_statement_id`));
      return result[0] ?? {};
    }
    const result = rows(await tx.execute(sql`with latest_link as(select distinct on(e.claim_id) e.claim_id,e.action from research_question_claim_events e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint order by e.claim_id,e.sequence desc,e.id desc), linked as(select claim_id from latest_link where action='linked'), current_rev as(select distinct on(r.claim_id) r.claim_id,r.id,r.state from claim_revisions r where r.project_id=${projectId}::uuid and r.finalized_at is not null and r.claim_id in(select claim_id from linked) order by r.claim_id,r.sequence desc), state as(select l.claim_id,r.id,r.state,(select count(*) from claim_revision_evidence_supports x where x.project_id=${projectId}::uuid and x.claim_revision_id=r.id)+(select count(*) from claim_revision_extraction_supports x where x.project_id=${projectId}::uuid and x.claim_revision_id=r.id)+(select count(*) from claim_revision_synthesis_supports x where x.project_id=${projectId}::uuid and x.claim_revision_id=r.id) as support_n,exists(select 1 from manuscript_claim_placements p join manuscript_section_item_claims sic on sic.project_id=p.project_id and sic.placement_id=p.id join manuscript_section_items i on i.project_id=sic.project_id and i.id=sic.section_item_id join manuscript_sections s on s.project_id=i.project_id and s.id=i.section_id where p.project_id=${projectId}::uuid and p.claim_id=l.claim_id and p.claim_revision_id=r.id and p.removed_at is null and i.removed_at is null and s.archived_at is null) as placed from linked l left join current_rev r on r.claim_id=l.claim_id) select count(*)::int as linked_claims,count(*) filter(where s.id is not null and s.state='active')::int as active_claims,count(*) filter(where s.id is not null and s.state='active' and s.placed)::int as current_manuscript_placements,count(*) filter(where s.id is null or s.state<>'active')::int as linked_claim_without_current_active_revision,count(*) filter(where s.id is not null and s.state='active' and s.support_n=0)::int as linked_current_claim_unsupported,count(*) filter(where s.id is not null and s.state='active' and not s.placed)::int as linked_current_claim_not_placed from linked l left join state s on s.claim_id=l.claim_id`));
    return result[0] ?? {};
  }

  async function readAnswerHistoryPage(tx: any, projectId: string, questionId: string, size: number, cursor: HistoryCursor | null): Promise<ResearchQuestionAnswerHistoryPage> {
    const boundary = cursor ? sql`and (a.sequence,a.id)<(${cursor.sequence}::bigint,${cursor.id}::uuid)` : sql``;
    const highWater = cursor ? sql`${cursor.highWaterSequence}::bigint` : sql`(select coalesce(max(x.sequence),0) from research_question_answers x where x.project_id=${projectId}::uuid and x.research_question_id=${questionId}::uuid and x.finalized_at is not null)`;
    const result = rows(await tx.execute(sql`
      with total as(select count(*)::int as total_count,max(a.sequence)::text as latest_sequence from research_question_answers a where a.project_id=${projectId}::uuid and a.research_question_id=${questionId}::uuid and a.finalized_at is not null), answer_page as(
        select a.id,a.sequence::text as sequence,a.finalized_at,left(a.answer_text,300) as text_preview
        from research_question_answers a where a.project_id=${projectId}::uuid and a.research_question_id=${questionId}::uuid and a.finalized_at is not null and a.sequence<=${highWater} ${boundary}
        order by a.sequence desc,a.id desc limit ${size + 1}
      ) select t.total_count,t.latest_sequence,(${highWater})::text as high_water_sequence,p.id,p.sequence,p.finalized_at,p.text_preview,
        coalesce(f.claim_context_count,0)::int as claim_context_count,coalesce(f.synthesis_context_count,0)::int as synthesis_context_count,coalesce(f.drifted_context_count,0)::int as drifted_context_count
      from total t left join answer_page p on true left join lateral(
        select count(*) filter(where d.context_type='claim')::int as claim_context_count,count(*) filter(where d.context_type='synthesis')::int as synthesis_context_count,count(*) filter(where d.superseded or d.withdrawn or d.unlinked)::int as drifted_context_count
        from (
          select 'claim'::text as context_type,(cur.id is distinct from c.claim_revision_id) as superseded,(cur.state='withdrawn') as withdrawn,((select e.action from research_question_claim_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.claim_id=c.claim_id order by e.sequence desc,e.id desc limit 1) is distinct from 'linked') as unlinked
          from research_question_answer_claim_contexts c left join lateral(select r.id,r.state from claim_revisions r where r.project_id=c.project_id and r.claim_id=c.claim_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true where p.id is not null and c.project_id=${projectId}::uuid and c.research_question_id=${questionId}::uuid and c.answer_id=p.id
          union all
          select 'synthesis',(cur.id is distinct from c.synthesis_revision_id),(cur.state='withdrawn'),((select e.action from research_question_synthesis_statement_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.synthesis_statement_id=c.synthesis_statement_id order by e.sequence desc,e.id desc limit 1) is distinct from 'linked')
          from research_question_answer_synthesis_contexts c left join lateral(select r.id,r.state from synthesis_revisions r where r.project_id=c.project_id and r.synthesis_statement_id=c.synthesis_statement_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true where p.id is not null and c.project_id=${projectId}::uuid and c.research_question_id=${questionId}::uuid and c.answer_id=p.id
        ) d
      ) f on true
    `));
    const total = int(result[0]?.total_count, "Answer count");
    const highWaterSequence = bigintText(result[0]?.high_water_sequence ?? "0", "Answer high-water sequence");
    const pageRows = result.filter((row) => row.id != null);
    const items = pageRows.map((row): ResearchQuestionAnswerHistoryItem => ({
      id: String(row.id), sequence: bigintText(row.sequence, "Answer sequence"), finalizedAt: date(row.finalized_at)!, textPreview: String(row.text_preview),
      claimContextCount: int(row.claim_context_count, "Claim context count"), synthesisContextCount: int(row.synthesis_context_count, "Synthesis context count"), driftedContextCount: int(row.drifted_context_count, "Drifted context count"),
    }));
    const hasMore = items.length > size;
    const visibleItems = hasMore ? items.slice(0, size) : items;
    const last = visibleItems[visibleItems.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: "rq-answer-history", projectId, questionId, pageSize: size, highWaterSequence, sequence: last.sequence, id: last.id }) : null;
    return { items: visibleItems, pageSize: size, hasMore, nextCursor, highWaterSequence, totalCount: total, latestAnswerSequence: result[0]?.latest_sequence == null ? null : bigintText(result[0].latest_sequence) };
  }

  async function readDriftedContextCount(tx: any, projectId: string, questionId: string): Promise<number> {
    const result = rows(await tx.execute(sql`with context_drift as(
      select c.answer_id,c.claim_revision_id as pinned_revision_id,(cur.id is distinct from c.claim_revision_id) as superseded,(cur.state='withdrawn') as withdrawn,((select e.action from research_question_claim_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.claim_id=c.claim_id order by e.sequence desc,e.id desc limit 1) is distinct from 'linked') as unlinked
      from research_question_answer_claim_contexts c join research_question_answers a on a.project_id=c.project_id and a.id=c.answer_id and a.finalized_at is not null left join lateral(select r.id,r.state from claim_revisions r where r.project_id=c.project_id and r.claim_id=c.claim_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true where c.project_id=${projectId}::uuid and c.research_question_id=${questionId}::uuid
      union all
      select c.answer_id,c.synthesis_revision_id,(cur.id is distinct from c.synthesis_revision_id),(cur.state='withdrawn'),((select e.action from research_question_synthesis_statement_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.synthesis_statement_id=c.synthesis_statement_id order by e.sequence desc,e.id desc limit 1) is distinct from 'linked')
      from research_question_answer_synthesis_contexts c join research_question_answers a on a.project_id=c.project_id and a.id=c.answer_id and a.finalized_at is not null left join lateral(select r.id,r.state from synthesis_revisions r where r.project_id=c.project_id and r.synthesis_statement_id=c.synthesis_statement_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true where c.project_id=${projectId}::uuid and c.research_question_id=${questionId}::uuid
    ) select count(*) filter(where superseded or withdrawn or unlinked)::int as count from context_drift`));
    return int(result[0]?.count, "Drifted Answer context count");
  }

  async function readTargetDetailRow(tx: any, projectId: string, questionId: string, targetType: ResearchQuestionTraceabilityTargetType, targetId: string): Promise<Row | undefined> {
    const spec = LINK_SPECS[targetType];
    const metadata = sql`,q.traceability_epoch::text as traceability_epoch,
      coalesce((select max(e.sequence)::text from ${sql.raw(spec.table)} e where e.project_id=p.id and e.research_question_id=q.id),'0') as high_water_sequence,
      exists(select 1 from ${sql.raw(spec.table)} e where e.project_id=p.id and e.research_question_id=q.id and e.${sql.raw(spec.column)}=t.id) as has_relationship,
      (select e.action from ${sql.raw(spec.table)} e where e.project_id=p.id and e.research_question_id=q.id and e.${sql.raw(spec.column)}=t.id order by e.sequence desc,e.id desc limit 1)='linked' as currently_linked`;
    let result: Row[];
    if (targetType === "extraction-field") result = rows(await tx.execute(sql`with included as(select p.id from papers p join(select distinct on(project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId}::uuid and stage='title_abstract' order by project_id,paper_id,sequence desc) ta on ta.project_id=p.project_id and ta.paper_id=p.id and ta.decision='include' join(select distinct on(project_id,paper_id) project_id,paper_id,decision from full_text_screening_decisions where project_id=${projectId}::uuid order by project_id,paper_id,sequence desc) ft on ft.project_id=p.project_id and ft.paper_id=p.id and ft.decision='include' where p.project_id=${projectId}::uuid), current_value as(select distinct on(ev.paper_id,ev.field_id) ev.field_id,r.value_state from extraction_values ev join extraction_value_revisions r on r.project_id=ev.project_id and r.extraction_value_id=ev.id and r.finalized_at is not null join included i on i.id=ev.paper_id where ev.project_id=${projectId}::uuid order by ev.paper_id,ev.field_id,r.sequence desc) select p.id as project_id,left(p.title,240) as project_title,q.id as question_id,left(q.identifier,100) as identifier,left(q.label,280) as question_label,t.id,left(t.name,160) as name,t.field_type,t.archived_at,exists(select 1 from current_value v where v.field_id=t.id and v.value_state in('present','not_reported','not_applicable')) as has_current_data ${metadata} from projects p join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid join extraction_fields t on t.project_id=p.id and t.id=${targetId}::uuid where p.id=${projectId}::uuid limit 1`));
    else if (targetType === "evidence-set") result = rows(await tx.execute(sql`select p.id as project_id,left(p.title,240) as project_title,q.id as question_id,left(q.identifier,100) as identifier,left(q.label,280) as question_label,t.id,left(t.name,120) as name,t.archived_at,comp.id::text as latest_composition_revision_id,coalesce(stats.member_count,0)::int as member_count,coalesce(stats.rejected_count,0)::int as rejected_count ${metadata} from projects p join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid join evidence_sets t on t.project_id=p.id and t.id=${targetId}::uuid left join lateral(select r.id,r.set_ordinal from evidence_set_composition_revisions r where r.project_id=p.id and r.evidence_set_id=t.id order by r.set_ordinal desc limit 1) comp on true left join lateral(select count(*)::int as member_count,count(*) filter(where rv.decision='rejected')::int as rejected_count from evidence_set_membership_order_versions v join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id left join lateral(select d.decision from evidence_review_decisions d where d.project_id=m.project_id and d.evidence_id=m.evidence_id order by d.sequence desc limit 1) rv on true where v.project_id=p.id and v.evidence_set_id=t.id and comp.id is not null and v.valid_from_ordinal<=comp.set_ordinal and(v.valid_to_ordinal is null or comp.set_ordinal<v.valid_to_ordinal)) stats on true where p.id=${projectId}::uuid limit 1`));
    else if (targetType === "synthesis-statement") result = rows(await tx.execute(sql`select p.id as project_id,left(p.title,240) as project_title,q.id as question_id,left(q.identifier,100) as identifier,left(q.label,280) as question_label,t.id,r.id as current_revision_id,r.state as current_state,coalesce(left(r.title,200),left(r.statement_text,200),'Untitled Statement') as current_title,case when r.state='active' then coalesce(support.n,0)::int else 0 end as support_count,case when r.state='active' then exists(select 1 from synthesis_interpretations i where i.project_id=p.id and i.synthesis_revision_id=r.id and i.finalized_at is not null) else false end as interpretation_available ${metadata} from projects p join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid join synthesis_statements t on t.project_id=p.id and t.id=${targetId}::uuid left join lateral(select r.id,r.state,r.title,r.statement_text from synthesis_revisions r where r.project_id=p.id and r.synthesis_statement_id=t.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true left join lateral(select count(*)::int as n from synthesis_revision_supports x where x.project_id=p.id and x.synthesis_revision_id=r.id) support on true where p.id=${projectId}::uuid limit 1`));
    else result = rows(await tx.execute(sql`select p.id as project_id,left(p.title,240) as project_title,q.id as question_id,left(q.identifier,100) as identifier,left(q.label,280) as question_label,t.id,r.id as current_revision_id,r.state as current_state,coalesce(left(r.claim_text,240),case when r.state='withdrawn' then 'Withdrawn Claim' else 'Claim without finalized revision' end) as current_claim_text,case when r.state='active' then coalesce(support.n,0)::int else 0 end as support_count,case when r.state='active' then coalesce(placement.n,0)::int else 0 end as placement_count ${metadata} from projects p join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid join claims t on t.project_id=p.id and t.id=${targetId}::uuid left join lateral(select r.id,r.state,r.claim_text from claim_revisions r where r.project_id=p.id and r.claim_id=t.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true left join lateral(select (select count(*) from claim_revision_evidence_supports x where x.project_id=p.id and x.claim_revision_id=r.id)+(select count(*) from claim_revision_extraction_supports x where x.project_id=p.id and x.claim_revision_id=r.id)+(select count(*) from claim_revision_synthesis_supports x where x.project_id=p.id and x.claim_revision_id=r.id) as n) support on true left join lateral(select count(distinct pl.id)::int as n from manuscript_claim_placements pl join manuscript_section_item_claims sic on sic.project_id=pl.project_id and sic.placement_id=pl.id join manuscript_section_items i on i.project_id=sic.project_id and i.id=sic.section_item_id join manuscript_sections s on s.project_id=i.project_id and s.id=i.section_id where pl.project_id=p.id and pl.claim_id=t.id and pl.claim_revision_id=r.id and pl.removed_at is null and i.removed_at is null and s.archived_at is null) placement on true where p.id=${projectId}::uuid limit 1`));
    return result[0];
  }

  async function readTargetHistory(tx: any, projectId: string, questionId: string, targetType: ResearchQuestionTraceabilityTargetType, targetId: string, size: number, cursor: TargetHistoryCursor | null, epoch: string, highWaterSequence: string): Promise<ResearchQuestionBoundedPage<ResearchQuestionTraceabilityHistoryEvent>> {
    const spec = LINK_SPECS[targetType];
    const boundary = cursor ? sql`and (e.sequence,e.id)>(${cursor.sequence}::bigint,${cursor.id}::uuid)` : sql``;
    const eventRows = rows(await tx.execute(sql`select e.id,e.sequence::text as sequence,e.action,e.note,e.created_at from ${sql.raw(spec.table)} e where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.${sql.raw(spec.column)}=${targetId}::uuid and e.sequence<=${highWaterSequence}::bigint ${boundary} order by e.sequence,e.id limit ${size + 1}`));
    const items = eventRows.map((row): ResearchQuestionTraceabilityHistoryEvent => ({ id: String(row.id), sequence: bigintText(row.sequence, "Traceability event sequence"), action: row.action as "linked" | "unlinked", note: row.note == null ? null : String(row.note), createdAt: date(row.created_at)! }));
    const hasMore = items.length > size;
    const visible = hasMore ? items.slice(0, size) : items;
    const last = visible[visible.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: "rq-target-history", projectId, questionId, pageSize: size, targetType, targetId, epoch, highWaterSequence, sequence: last.sequence, id: last.id }) : null;
    return { items: visible, pageSize: size, hasMore, nextCursor };
  }

  function mapLinkPageRow(targetType: ResearchQuestionTraceabilityTargetType, row: Row): ResearchQuestionExtractionLinkRow | ResearchQuestionEvidenceSetLinkRow | ResearchQuestionSynthesisLinkRow | ResearchQuestionClaimLinkRow {
    const diagnosticFlags = linkRowFlags(targetType, row) as any;
    if (targetType === "extraction-field") return { id: String(row.id), name: String(row.name), fieldType: String(row.field_type), archivedAt: date(row.archived_at), hasCurrentData: bool(row.has_current_data), diagnosticFlags };
    if (targetType === "evidence-set") return { id: String(row.id), name: String(row.name), archivedAt: date(row.archived_at), latestCompositionRevisionId: row.latest_composition_revision_id == null ? null : String(row.latest_composition_revision_id), memberCount: int(row.member_count, "Evidence Set member count"), rejectedEvidenceCount: int(row.rejected_count, "Rejected Evidence count"), diagnosticFlags };
    if (targetType === "synthesis-statement") return { id: String(row.id), currentActiveRevisionId: row.current_state === "active" ? String(row.current_revision_id) : null, currentTitle: String(row.current_title), currentState: row.current_state == null ? null : String(row.current_state), supportCount: int(row.support_count, "Synthesis support count"), interpretationAvailable: bool(row.interpretation_available), diagnosticFlags };
    const supportCount = int(row.support_count, "Claim support count");
    return { id: String(row.id), currentActiveRevisionId: row.current_state === "active" ? String(row.current_revision_id) : null, currentClaimText: String(row.current_claim_text), currentState: row.current_state == null ? null : String(row.current_state), supportCount, supportStatus: row.current_state === "active" && supportCount > 0 ? "supported" : "unsupported", currentPlacementCount: int(row.placement_count, "Current Claim placement count"), isCurrentlyPlaced: int(row.placement_count, "Current Claim placement count") > 0, diagnosticFlags };
  }

  async function getResearchQuestionMatrixPage(projectIdInput: string, options: ResearchQuestionMatrixPageOptions = {}): Promise<ResearchQuestionMatrixPage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_MATRIX_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_MATRIX_MAX_PAGE_SIZE);
    const status = options.status ?? "all";
    if (status !== "all" && status !== "active" && status !== "archived") throw new DomainError("VALIDATION_ERROR", "Question status is invalid");
    const cursor = bindCursor<MatrixCursor>(options.cursor, { kind: "rq-matrix", projectId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-matrix", projectId, pageSize: size, status: String(raw.status),
      sortOrder: cursorInt(raw.sortOrder), id: cursorUuid(raw.id),
    }));
    if (cursor && cursor.status !== status) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      const questionRows = rows(await tx.execute(sql`
        with project_scope as materialized (
          select p.id as project_id,left(p.title,240) as project_title,
          (select count(*)::int from search_strategies ss where ss.project_id=p.id and ss.archived_at is null) as strategy_count,
          (select count(*)::int from search_runs sr where sr.project_id=p.id) as run_count,
          (select count(*)::int from research_questions rq where rq.project_id=p.id and rq.archived_at is null) as active_count,
          (select count(*)::int from research_questions rq where rq.project_id=p.id and rq.archived_at is not null) as archived_count
          from projects p where p.id=${projectId}::uuid
        )
        select p.project_id,p.project_title,p.strategy_count,p.run_count,p.active_count,p.archived_count,
          page.id,page.project_id,left(page.identifier,100) as identifier,left(page.label,280) as label,page.sort_order,page.archived_at
        from project_scope p
        left join lateral (
          select rq.id,rq.project_id,rq.identifier,rq.label,rq.sort_order,rq.archived_at from research_questions rq
          where rq.project_id=p.project_id
            and (${status}='all' or (${status}='active' and archived_at is null) or (${status}='archived' and archived_at is not null))
            and (${cursor?.sortOrder ?? null}::int is null or (rq.sort_order,rq.id) > (${cursor?.sortOrder ?? null}::int,${cursor?.id ?? null}::uuid))
          order by rq.sort_order,rq.id limit ${size + 1}
        ) page on true
        order by page.sort_order,page.id
      `));
      if (!questionRows.length) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      const head = questionRows[0]!;
      const visibleQuestions = questionRows.filter((r) => r.id != null);
      const selected = visibleQuestions.slice(0, size);
      if (!selected.length) return {
        project: { id: projectId, title: String(head.project_title) }, rows: [], pageSize: size, hasMore: false,
        nextCursor: null, questionCounts: { active: int(head.active_count, "Active Question count"), archived: int(head.archived_count, "Archived Question count") },
        protocolContext: { searchStrategyCount: int(head.strategy_count, "Strategy count"), searchRunCount: int(head.run_count, "SearchRun count") },
      };
      const questionIds = selected.map((r) => sql`${String(r.id)}::uuid`);
      const linkedCte = (table: string, column: string) => sql`
        select distinct on (e.research_question_id,e.${sql.raw(column)}) e.research_question_id,e.${sql.raw(column)} as target_id,e.action
        from ${sql.raw(table)} e
        where e.project_id=${projectId}::uuid and e.research_question_id in (${sql.join(questionIds, sql`, `)})
        order by e.research_question_id,e.${sql.raw(column)},e.sequence desc,e.id desc`;
      // Four dimension aggregates use the same latest-event-first reducer and
      // return one compact diagnostic/count row per visible Question.
      const [extraction, evidence, synthesis, claims] = await Promise.all([
        tx.execute(sql`with latest_link as (${linkedCte(LINK_SPECS["extraction-field"].table, LINK_SPECS["extraction-field"].column)}), linked as (select l.research_question_id,l.target_id from latest_link l where l.action='linked'),
          included as (select p.id from papers p join (select distinct on (project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId}::uuid and stage='title_abstract' order by project_id,paper_id,sequence desc) ta on ta.project_id=p.project_id and ta.paper_id=p.id and ta.decision='include' join (select distinct on (project_id,paper_id) project_id,paper_id,decision from full_text_screening_decisions where project_id=${projectId}::uuid order by project_id,paper_id,sequence desc) ft on ft.project_id=p.project_id and ft.paper_id=p.id and ft.decision='include' where p.project_id=${projectId}::uuid), current_values as (select distinct on (ev.paper_id,ev.field_id) ev.paper_id,ev.field_id,r.value_state from extraction_values ev join extraction_value_revisions r on r.project_id=ev.project_id and r.extraction_value_id=ev.id and r.finalized_at is not null join included i on i.id=ev.paper_id order by ev.paper_id,ev.field_id,r.sequence desc), field_state as (select l.research_question_id,l.target_id,bool_or(cv.value_state in ('present','not_reported','not_applicable')) as has_data from linked l left join current_values cv on cv.field_id=l.target_id group by l.research_question_id,l.target_id)
          select q.id as research_question_id,count(f.target_id)::int as linked_extraction_fields,count(*) filter(where f.target_id is not null and not coalesce(f.has_data,false))::int as linked_field_without_current_data from research_questions q left join linked l on l.research_question_id=q.id left join field_state f on f.research_question_id=q.id and f.target_id=l.target_id where q.id in (${sql.join(questionIds, sql`, `)}) group by q.id`),
        tx.execute(sql`with latest_link as (${linkedCte(LINK_SPECS["evidence-set"].table, LINK_SPECS["evidence-set"].column)}), linked as (select l.research_question_id,l.target_id from latest_link l where l.action='linked'), latest_comp as (select distinct on (r.evidence_set_id) r.evidence_set_id,r.id,r.set_ordinal from evidence_set_composition_revisions r where r.project_id=${projectId}::uuid and r.evidence_set_id in (select target_id from linked) order by r.evidence_set_id,r.set_ordinal desc), members as (select lc.evidence_set_id,m.evidence_id from latest_comp lc join evidence_set_membership_order_versions v on v.project_id=${projectId}::uuid and v.evidence_set_id=lc.evidence_set_id and v.valid_from_ordinal<=lc.set_ordinal and (v.valid_to_ordinal is null or lc.set_ordinal<v.valid_to_ordinal) join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id), review as (select distinct on(d.evidence_id) d.evidence_id,d.decision from evidence_review_decisions d where d.project_id=${projectId}::uuid and exists(select 1 from members m where m.evidence_id=d.evidence_id) order by d.evidence_id,d.sequence desc), set_state as (select l.research_question_id,l.target_id,count(m.evidence_id)::int as member_count,count(*) filter(where r.decision='rejected')::int as rejected_count from linked l left join latest_comp lc on lc.evidence_set_id=l.target_id left join members m on m.evidence_set_id=l.target_id left join review r on r.evidence_id=m.evidence_id group by l.research_question_id,l.target_id)
          select q.id as research_question_id,count(s.target_id)::int as linked_evidence_sets,count(*) filter(where s.member_count=0)::int as linked_set_empty,count(*) filter(where s.rejected_count>0)::int as linked_set_contains_rejected_evidence from research_questions q left join set_state s on s.research_question_id=q.id where q.id in (${sql.join(questionIds, sql`, `)}) group by q.id`),
        tx.execute(sql`with latest_link as (${linkedCte(LINK_SPECS["synthesis-statement"].table, LINK_SPECS["synthesis-statement"].column)}), linked as (select l.research_question_id,l.target_id from latest_link l where l.action='linked'), current_rev as (select distinct on(r.synthesis_statement_id) r.synthesis_statement_id,r.id,r.state from synthesis_revisions r where r.project_id=${projectId}::uuid and r.finalized_at is not null and r.synthesis_statement_id in(select target_id from linked) order by r.synthesis_statement_id,r.sequence desc), support as(select synthesis_revision_id,count(*)::int as n from synthesis_revision_supports where project_id=${projectId}::uuid and synthesis_revision_id in(select id from current_rev where state='active') group by synthesis_revision_id), flags as(select l.research_question_id,l.target_id,cr.id,cr.state,coalesce(s.n,0)::int as support_n,exists(select 1 from synthesis_interpretations i where i.project_id=${projectId}::uuid and i.synthesis_revision_id=cr.id and i.finalized_at is not null) as has_interpretation from linked l left join current_rev cr on cr.synthesis_statement_id=l.target_id left join support s on s.synthesis_revision_id=cr.id)
          select q.id as research_question_id,count(f.target_id)::int as linked_synthesis_statements,count(*) filter(where f.id is not null and f.state='active')::int as active_synthesis_statements,count(*) filter(where f.id is not null and f.state='active' and f.has_interpretation)::int as interpretations,count(*) filter(where f.target_id is not null and (f.id is null or f.state<>'active'))::int as linked_statement_without_current_active_revision,count(*) filter(where f.id is not null and f.state='active' and f.support_n=0)::int as linked_current_synthesis_without_support,count(*) filter(where f.id is not null and f.state='active' and not f.has_interpretation)::int as linked_current_synthesis_without_interpretation from research_questions q left join flags f on f.research_question_id=q.id where q.id in (${sql.join(questionIds, sql`, `)}) group by q.id`),
        tx.execute(sql`with latest_link as (${linkedCte(LINK_SPECS.claim.table, LINK_SPECS.claim.column)}), linked as (select l.research_question_id,l.target_id from latest_link l where l.action='linked'), current_rev as (select distinct on(r.claim_id) r.claim_id,r.id,r.state from claim_revisions r where r.project_id=${projectId}::uuid and r.finalized_at is not null and r.claim_id in(select target_id from linked) order by r.claim_id,r.sequence desc), support as(select claim_revision_id,count(*)::int as n from (select claim_revision_id from claim_revision_evidence_supports where project_id=${projectId}::uuid union all select claim_revision_id from claim_revision_extraction_supports where project_id=${projectId}::uuid union all select claim_revision_id from claim_revision_synthesis_supports where project_id=${projectId}::uuid) x group by claim_revision_id), placements as(select distinct p.claim_id,p.claim_revision_id from manuscript_claim_placements p join manuscript_section_item_claims sic on sic.project_id=p.project_id and sic.placement_id=p.id join manuscript_section_items i on i.project_id=sic.project_id and i.id=sic.section_item_id join manuscript_sections s on s.project_id=i.project_id and s.id=i.section_id where p.project_id=${projectId}::uuid and p.removed_at is null and i.removed_at is null and s.archived_at is null), flags as(select l.research_question_id,l.target_id,cr.id,cr.state,coalesce(s.n,0)::int as support_n,exists(select 1 from placements p where p.claim_id=l.target_id and p.claim_revision_id=cr.id) as placed from linked l left join current_rev cr on cr.claim_id=l.target_id left join support s on s.claim_revision_id=cr.id)
          select q.id as research_question_id,count(f.target_id)::int as linked_claims,count(*) filter(where f.id is not null and f.state='active')::int as active_claims,count(*) filter(where f.id is not null and f.state='active' and f.placed)::int as current_manuscript_placements,count(*) filter(where f.target_id is not null and (f.id is null or f.state<>'active'))::int as linked_claim_without_current_active_revision,count(*) filter(where f.id is not null and f.state='active' and f.support_n=0)::int as linked_current_claim_unsupported,count(*) filter(where f.id is not null and f.state='active' and not f.placed)::int as linked_current_claim_not_placed from research_questions q left join flags f on f.research_question_id=q.id where q.id in (${sql.join(questionIds, sql`, `)}) group by q.id`),
      ]);
      // Answer counts/context drift are an independent bounded aggregate over
      // the already-bounded Question page.
      const answers = rows(await tx.execute(sql`
        with page_q as (select unnest(array[${sql.join(questionIds, sql`, `)}]::uuid[]) as id), finalized as (
          select a.research_question_id,count(*)::int as answer_count,max(a.sequence)::text as latest_sequence
          from research_question_answers a join page_q q on q.id=a.research_question_id where a.project_id=${projectId}::uuid and a.finalized_at is not null group by a.research_question_id
        ), context_drift as (
          select c.research_question_id,c.answer_id,c.claim_revision_id as pinned_revision_id,'claim'::text as context_type,
            (cur.id is distinct from pin.id) as superseded,(cur.state='withdrawn') as withdrawn,
            ((select e.action from research_question_claim_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.claim_id=c.claim_id order by e.sequence desc,e.id desc limit 1) is distinct from 'linked') as unlinked
          from research_question_answer_claim_contexts c join research_question_answers a on a.project_id=c.project_id and a.id=c.answer_id and a.finalized_at is not null
          join page_q q on q.id=c.research_question_id join claim_revisions pin on pin.project_id=c.project_id and pin.claim_id=c.claim_id and pin.id=c.claim_revision_id
          left join lateral(select r.id,r.state from claim_revisions r where r.project_id=c.project_id and r.claim_id=c.claim_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true
          union all
          select c.research_question_id,c.answer_id,c.synthesis_revision_id,'synthesis'::text,
            (cur.id is distinct from pin.id),(cur.state='withdrawn'),
            ((select e.action from research_question_synthesis_statement_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.synthesis_statement_id=c.synthesis_statement_id order by e.sequence desc,e.id desc limit 1) is distinct from 'linked')
          from research_question_answer_synthesis_contexts c join research_question_answers a on a.project_id=c.project_id and a.id=c.answer_id and a.finalized_at is not null
          join page_q q on q.id=c.research_question_id join synthesis_revisions pin on pin.project_id=c.project_id and pin.synthesis_statement_id=c.synthesis_statement_id and pin.id=c.synthesis_revision_id
          left join lateral(select r.id,r.state from synthesis_revisions r where r.project_id=c.project_id and r.synthesis_statement_id=c.synthesis_statement_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true
        ), contexts as (
          select research_question_id,count(*) filter(where context_type='claim')::int as claim_contexts,count(*) filter(where context_type='synthesis')::int as synthesis_contexts from context_drift group by research_question_id
        ), drift as (
          select research_question_id,count(*) filter(where superseded or withdrawn or unlinked)::int as drifted_contexts from context_drift group by research_question_id
        ) select q.id as research_question_id,coalesce(f.answer_count,0)::int as finalized_answers,f.latest_sequence,coalesce(c.claim_contexts,0)::int as claim_contexts,coalesce(c.synthesis_contexts,0)::int as synthesis_contexts,coalesce(d.drifted_contexts,0)::int as drifted_contexts from page_q q left join finalized f on f.research_question_id=q.id left join contexts c on c.research_question_id=q.id left join drift d on d.research_question_id=q.id
      `));
      const mapRows = (value: unknown) => new Map(rows(value).map((r) => [String(r.research_question_id), r]));
      const dimensionMaps = [extraction, evidence, synthesis, claims, answers].map(mapRows);
      const resultRows: ResearchQuestionMatrixPageRow[] = selected.map((q) => {
        const qid = String(q.id); const ex = dimensionMaps[0]!.get(qid); const ev = dimensionMaps[1]!.get(qid); const sy = dimensionMaps[2]!.get(qid); const cl = dimensionMaps[3]!.get(qid); const an = dimensionMaps[4]!.get(qid);
        const diag = diagnosticCounts({ ...ex, ...ev, ...sy, ...cl });
        diag.fullyCovered = Object.values({ ...diag.extraction, ...diag.evidenceSets, ...diag.synthesis, ...diag.claims }).length === 0;
        return { question: { id: qid, projectId, identifier: String(q.identifier), label: String(q.label), sortOrder: int(q.sort_order, "Question sort order"), archivedAt: date(q.archived_at) }, counts: {
          linkedExtractionFields: int(ex?.linked_extraction_fields, "Extraction field count"), linkedEvidenceSets: int(ev?.linked_evidence_sets, "Evidence Set count"), linkedSynthesisStatements: int(sy?.linked_synthesis_statements, "Synthesis count"), activeSynthesisStatements: int(sy?.active_synthesis_statements, "Active Synthesis count"), interpretations: int(sy?.interpretations, "Interpretation count"), linkedClaims: int(cl?.linked_claims, "Claim count"), activeClaims: int(cl?.active_claims, "Active Claim count"), currentManuscriptPlacements: int(cl?.current_manuscript_placements, "Placement count"), finalizedAnswers: int(an?.finalized_answers, "Answer count"), claimAnswerContexts: int(an?.claim_contexts, "Claim context count"), synthesisAnswerContexts: int(an?.synthesis_contexts, "Synthesis context count"), latestAnswerSequence: an?.latest_sequence == null ? null : bigintText(an.latest_sequence), driftedAnswerContexts: int(an?.drifted_contexts, "Drifted context count"),
        }, diagnostics: diag };
      });
      const extra = visibleQuestions.length > size;
      const last = selected[selected.length - 1];
      return { project: { id: projectId, title: String(head.project_title) }, rows: resultRows, pageSize: size, hasMore: extra, nextCursor: extra && last ? encodeCursor({ v: 1, kind: "rq-matrix", projectId, pageSize: size, status, sortOrder: int(last.sort_order, "Question sort order"), id: String(last.id) }) : null,
        questionCounts: { active: int(head.active_count, "Active Question count"), archived: int(head.archived_count, "Archived Question count") }, protocolContext: { searchStrategyCount: int(head.strategy_count, "Strategy count"), searchRunCount: int(head.run_count, "SearchRun count") } };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function listResearchQuestionLinkPage(projectIdInput: string, questionIdInput: string, targetTypeInput: ResearchQuestionTraceabilityTargetType, options: { pageSize?: number; cursor?: string | null } = {}) {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    if (!Object.hasOwn(LINK_SPECS, targetTypeInput)) throw new DomainError("VALIDATION_ERROR", "Traceability target type is invalid");
    const targetType = targetTypeInput;
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_LINK_MAX_PAGE_SIZE);
    const cursor = bindCursor<LinkCursor>(options.cursor, { kind: "rq-link", projectId, questionId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-link", projectId, questionId, pageSize: size,
      targetType: String(raw.targetType) as ResearchQuestionTraceabilityTargetType,
      epoch: cursorBigint(raw.epoch), highWaterSequence: cursorBigint(raw.highWaterSequence), id: cursorUuid(raw.id),
    }));
    if (cursor && cursor.targetType !== targetType) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      const scope = await readQuestionScope(tx, projectId, questionId);
      const epoch = bigintText(scope.traceability_epoch, "Traceability epoch");
      if (cursor && cursor.epoch !== epoch) throw new DomainError("CONCURRENT_MODIFICATION", "Question links changed. Refresh the link list.");
      const highWaterKey = targetType === "extraction-field" ? "extraction_high_water" : targetType === "evidence-set" ? "evidence_set_high_water" : targetType === "synthesis-statement" ? "synthesis_high_water" : "claim_high_water";
      const highWaterSequence = bigintText(scope[highWaterKey], "Traceability event high-water sequence");
      if (cursor && cursor.highWaterSequence !== highWaterSequence) throw new DomainError("CONCURRENT_MODIFICATION", "Question links changed. Refresh the link list.");
      const fetched = await readLinkPageRows(tx, projectId, questionId, targetType, size, cursor?.id ?? null, highWaterSequence);
      const mapped = fetched.map((row) => mapLinkPageRow(targetType, row));
      const hasMore = mapped.length > size;
      const items = hasMore ? mapped.slice(0, size) : mapped;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: "rq-link", projectId, questionId, pageSize: size, targetType, epoch, highWaterSequence, id: last.id }) : null;
      return { items, pageSize: size, hasMore, nextCursor, traceabilityEpoch: epoch };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function getResearchQuestionWorkspace(projectIdInput: string, questionIdInput: string): Promise<ResearchQuestionWorkspace> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    return db.transaction(async (tx) => {
      const scope = await readQuestionScope(tx, projectId, questionId, 10_000);
      const epoch = bigintText(scope.traceability_epoch, "Traceability epoch");
      const dimensionType = ["extraction-field", "evidence-set", "synthesis-statement", "claim"] as const;
      const highWaters = [scope.extraction_high_water, scope.evidence_set_high_water, scope.synthesis_high_water, scope.claim_high_water].map((value) => bigintText(value, "Traceability event high-water sequence"));
      const summaries = await Promise.all(dimensionType.map((type, index) => readDimensionSummary(tx, projectId, questionId, type, highWaters[index]!)));
      const linkRows = await Promise.all(dimensionType.map((type, index) => readLinkPageRows(tx, projectId, questionId, type, RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE, null, highWaters[index]!)));
      const driftedContextCount = await readDriftedContextCount(tx, projectId, questionId);
      const answerHistory = await readAnswerHistoryPage(tx, projectId, questionId, RESEARCH_QUESTION_ANSWER_HISTORY_DEFAULT_PAGE_SIZE, null);
      const [ex, ev, sy, cl] = summaries;
      const diagnostics = diagnosticCounts({ ...ex, ...ev, ...sy, ...cl });
      diagnostics.fullyCovered = Object.keys({ ...diagnostics.extraction, ...diagnostics.evidenceSets, ...diagnostics.synthesis, ...diagnostics.claims }).length === 0;
      const pageFor = (targetType: ResearchQuestionTraceabilityTargetType, index: number) => {
        const all = linkRows[index]!.map((row) => mapLinkPageRow(targetType, row));
        const hasMore = all.length > RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE;
        const items = hasMore ? all.slice(0, RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE) : all;
        const last = items[items.length - 1];
        return { items, pageSize: RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: 1, kind: "rq-link", projectId, questionId, pageSize: RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE, targetType, epoch, highWaterSequence: highWaters[index], id: last.id }) : null };
      };
      const extractionPage = pageFor("extraction-field", 0) as ResearchQuestionBoundedPage<ResearchQuestionExtractionLinkRow>;
      const evidencePage = pageFor("evidence-set", 1) as ResearchQuestionBoundedPage<ResearchQuestionEvidenceSetLinkRow>;
      const synthesisPage = pageFor("synthesis-statement", 2) as ResearchQuestionBoundedPage<ResearchQuestionSynthesisLinkRow>;
      const claimPage = pageFor("claim", 3) as ResearchQuestionBoundedPage<ResearchQuestionClaimLinkRow>;
      const answerSummary = {
        finalizedAnswerCount: int(scope.answer_count, "Answer count"),
        latestAnswerSequence: scope.latest_answer_sequence == null ? null : bigintText(scope.latest_answer_sequence, "Answer sequence"),
        claimContextCount: int(scope.claim_context_count, "Claim context count"),
        synthesisContextCount: int(scope.synthesis_context_count, "Synthesis context count"),
        driftedContextCount: driftedContextCount,
      };
      return {
        project: { id: projectId, title: String(scope.project_title) },
        question: { id: questionId, projectId, identifier: String(scope.identifier), label: String(scope.label), sortOrder: int(scope.sort_order, "Question sort order"), archivedAt: date(scope.archived_at) },
        protocolContext: { searchStrategyCount: int(scope.strategy_count, "Strategy count"), searchRunCount: int(scope.run_count, "SearchRun count") },
        traceabilityEpoch: epoch,
        currentLinkCounts: { extractionFields: int(ex.linked_extraction_fields, "Extraction field count"), evidenceSets: int(ev.linked_evidence_sets, "Evidence Set count"), synthesisStatements: int(sy.linked_synthesis_statements, "Synthesis count"), claims: int(cl.linked_claims, "Claim count") },
        diagnostics,
        answerSummary,
        links: { extractionFields: extractionPage, evidenceSets: evidencePage, synthesisStatements: synthesisPage, claims: claimPage },
        answerHistory,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function listResearchQuestionAnswerHistoryPage(projectIdInput: string, questionIdInput: string, options: { pageSize?: number; cursor?: string | null } = {}): Promise<ResearchQuestionAnswerHistoryPage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_ANSWER_HISTORY_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_ANSWER_HISTORY_MAX_PAGE_SIZE);
    const cursor = bindCursor<HistoryCursor>(options.cursor, { kind: "rq-answer-history", projectId, questionId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-answer-history", projectId, questionId, pageSize: size, highWaterSequence: cursorBigint(raw.highWaterSequence), sequence: cursorBigint(raw.sequence), id: cursorUuid(raw.id),
    }));
    if (cursor && BigInt(cursor.sequence) > BigInt(cursor.highWaterSequence)) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      await readQuestionScope(tx, projectId, questionId);
      return readAnswerHistoryPage(tx, projectId, questionId, size, cursor);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function getResearchQuestionTargetDetail(projectIdInput: string, questionIdInput: string, targetTypeInput: ResearchQuestionTraceabilityTargetType, targetIdInput: string, options: { pageSize?: number; cursor?: string | null } = {}): Promise<ResearchQuestionTraceabilityTargetDetail> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    const targetId = uuid(targetIdInput, "Traceability target identifier");
    if (!Object.hasOwn(LINK_SPECS, targetTypeInput)) throw new DomainError("VALIDATION_ERROR", "Traceability target type is invalid");
    const targetType = targetTypeInput;
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_TARGET_HISTORY_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_TARGET_HISTORY_MAX_PAGE_SIZE);
    const cursor = bindCursor<TargetHistoryCursor>(options.cursor, { kind: "rq-target-history", projectId, questionId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-target-history", projectId, questionId, pageSize: size,
      targetType: String(raw.targetType) as ResearchQuestionTraceabilityTargetType,
      targetId: cursorUuid(raw.targetId), epoch: cursorBigint(raw.epoch),
      highWaterSequence: cursorBigint(raw.highWaterSequence),
      sequence: (() => {
        const sequence = cursorBigint(raw.sequence);
        if (BigInt(sequence) > BigInt(cursorBigint(raw.highWaterSequence))) throw new Error("target history cursor exceeds its captured high-water sequence");
        return sequence;
      })(),
      id: cursorUuid(raw.id),
    }));
    if (cursor && (cursor.targetType !== targetType || cursor.targetId !== targetId)) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      const row = await readTargetDetailRow(tx, projectId, questionId, targetType, targetId);
      if (!row || !bool(row.has_relationship)) throw new DomainError("NOT_FOUND", "Traceability target was not found for this Research Question");
      const epoch = bigintText(row.traceability_epoch, "Traceability epoch");
      const highWaterSequence = bigintText(row.high_water_sequence, "Traceability event high-water sequence");
      if (cursor && (cursor.epoch !== epoch || cursor.highWaterSequence !== highWaterSequence)) throw new DomainError("CONCURRENT_MODIFICATION", "Question link history changed. Refresh the detail.");
      const history = await readTargetHistory(tx, projectId, questionId, targetType, targetId, size, cursor, epoch, highWaterSequence);
      const currentlyLinked = bool(row.currently_linked);
      const target = mapLinkPageRow(targetType, row);
      if (!currentlyLinked) target.diagnosticFlags = [];
      return {
        project: { id: projectId, title: String(row.project_title) },
        question: { id: questionId, identifier: String(row.identifier) },
        traceabilityEpoch: epoch,
        targetType,
        currentlyLinked,
        target,
        history,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function getResearchQuestionTargetPickerPage(projectIdInput: string, questionIdInput: string, targetTypeInput: ResearchQuestionTraceabilityTargetType, options: { pageSize?: number; cursor?: string | null; search?: string } = {}): Promise<ResearchQuestionTargetPickerPage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    if (!Object.hasOwn(LINK_SPECS, targetTypeInput)) throw new DomainError("VALIDATION_ERROR", "Traceability target type is invalid");
    const targetType = targetTypeInput;
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_LINK_MAX_PAGE_SIZE);
    const search = validateSearch(options.search);
    const cursor = bindCursor<PickerCursor>(options.cursor, { kind: "rq-picker", projectId, questionId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-picker", projectId, questionId, pageSize: size,
      targetType: String(raw.targetType) as ResearchQuestionTraceabilityTargetType,
      epoch: cursorBigint(raw.epoch), highWaterSequence: cursorBigint(raw.highWaterSequence),
      search: String(raw.search), id: cursorUuid(raw.id),
    }));
    if (cursor && (cursor.targetType !== targetType || cursor.search !== search)) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      const scope = await readQuestionScope(tx, projectId, questionId);
      const epoch = bigintText(scope.traceability_epoch, "Traceability epoch");
      const highWaterSequence = bigintText(scope[
        targetType === "extraction-field" ? "extraction_high_water" :
          targetType === "evidence-set" ? "evidence_set_high_water" :
            targetType === "synthesis-statement" ? "synthesis_high_water" : "claim_high_water"
      ], "Traceability event high-water sequence");
      if (cursor && (cursor.epoch !== epoch || cursor.highWaterSequence !== highWaterSequence)) throw new DomainError("CONCURRENT_MODIFICATION", "Question links changed. Refresh the picker.");
      const fetched = await readPickerRows(tx, projectId, questionId, targetType, size, cursor?.id ?? null, highWaterSequence, search);
      const hasMore = fetched.length > size;
      const visible = hasMore ? fetched.slice(0, size) : fetched;
      const items = visible.map((row): ResearchQuestionTargetPickerRow => ({
        targetType,
        id: String(row.id),
        label: String(row.label),
        ...(row.state == null ? {} : { state: String(row.state) }),
        ...(row.archived_at === undefined ? {} : { archivedAt: date(row.archived_at) }),
        ...(row.field_type == null ? {} : { fieldType: String(row.field_type) }),
        isCurrentlyLinked: bool(row.is_currently_linked),
      }));
      const last = visible[visible.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: "rq-picker", projectId, questionId, pageSize: size, targetType, epoch, highWaterSequence, search, id: String(last.id) }) : null;
      return { items, pageSize: size, hasMore, nextCursor, traceabilityEpoch: epoch, highWaterSequence, search };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function getResearchQuestionExtractionCoveragePage(projectIdInput: string, questionIdInput: string, fieldIdInput: string, options: { pageSize?: number; cursor?: string | null } = {}): Promise<ResearchQuestionExtractionCoveragePage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    const fieldId = uuid(fieldIdInput, "Extraction Field identifier");
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_COVERAGE_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_COVERAGE_MAX_PAGE_SIZE);
    const cursor = bindCursor<CoverageCursor>(options.cursor, { kind: "rq-coverage", projectId, questionId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-coverage", projectId, questionId, pageSize: size,
      epoch: cursorBigint(raw.epoch), highWaterSequence: cursorBigint(raw.highWaterSequence), fieldId: cursorUuid(raw.fieldId),
      createdAt: cursorTimestamp(raw.createdAt),
      id: cursorUuid(raw.id),
    }));
    if (cursor && cursor.fieldId !== fieldId) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      const boundary = cursor ? sql`and (p.created_at,p.id)>(${cursor.createdAt}::timestamptz,${cursor.id}::uuid)` : sql``;
      const result = rows(await tx.execute(sql`
        with scope as (
          select p.id as project_id,left(p.title,240) as project_title,q.id as question_id,left(q.identifier,100) as identifier,
            q.traceability_epoch::text as traceability_epoch,
            coalesce((select max(e.sequence)::text from research_question_extraction_field_events e where e.project_id=p.id and e.research_question_id=q.id),'0') as high_water_sequence,
            f.id as field_id,left(f.name,160) as field_name,f.field_type,
            exists(select 1 from research_question_extraction_field_events e where e.project_id=p.id and e.research_question_id=q.id and e.extraction_field_id=f.id) as has_relationship
          from projects p join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid
          join extraction_fields f on f.project_id=p.id and f.id=${fieldId}::uuid where p.id=${projectId}::uuid
        ), included as (
          select p.id,p.title,p.created_at from papers p
          join (select distinct on(project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId}::uuid and stage='title_abstract' order by project_id,paper_id,sequence desc) ta on ta.project_id=p.project_id and ta.paper_id=p.id and ta.decision='include'
          join (select distinct on(project_id,paper_id) project_id,paper_id,decision from full_text_screening_decisions where project_id=${projectId}::uuid order by project_id,paper_id,sequence desc) ft on ft.project_id=p.project_id and ft.paper_id=p.id and ft.decision='include'
          where p.project_id=${projectId}::uuid ${boundary}
        ), page as (
          select i.id,i.title,i.created_at from included i order by i.created_at,i.id limit ${size + 1}
        ), current_value as (
          select distinct on(ev.paper_id,ev.field_id) ev.paper_id,ev.field_id,r.id as revision_id,r.value_state,r.text_value,r.number_value,r.boolean_value,r.option_id,opt.label as option_label
          from extraction_values ev join extraction_value_revisions r on r.project_id=ev.project_id and r.extraction_value_id=ev.id and r.finalized_at is not null
          join page pg on pg.id=ev.paper_id left join extraction_options opt on opt.project_id=r.project_id and opt.id=r.option_id
          where ev.project_id=${projectId}::uuid and ev.field_id=${fieldId}::uuid order by ev.paper_id,ev.field_id,r.sequence desc
        )
        select s.*,pg.id as paper_id,left(pg.title,200) as paper_title,pg.created_at::text as cursor_created_at,cv.revision_id,cv.value_state,
          case when cv.revision_id is null then 'no_finalized_revision' else cv.value_state end as coverage_status,
          case when cv.value_state='present' then left(coalesce(cv.text_value,cv.number_value::text,cv.option_label,case when cv.boolean_value then 'Yes' when cv.boolean_value is false then 'No' else null end),240)
            when cv.value_state='not_reported' then 'Not Reported' when cv.value_state='not_applicable' then 'Not Applicable' else null end as display_value
        from scope s left join page pg on true left join current_value cv on cv.paper_id=pg.id and cv.field_id=s.field_id
        order by pg.created_at,pg.id
      `));
      const scope = result[0];
      if (!scope) throw new DomainError("NOT_FOUND", "Extraction coverage scope was not found");
      if (!bool(scope.has_relationship)) throw new DomainError("NOT_FOUND", "Extraction Field was not linked to this Research Question");
      const epoch = bigintText(scope.traceability_epoch, "Traceability epoch");
      const highWaterSequence = bigintText(scope.high_water_sequence, "Traceability event high-water sequence");
      if (cursor && (cursor.epoch !== epoch || cursor.highWaterSequence !== highWaterSequence)) throw new DomainError("CONCURRENT_MODIFICATION", "Question links changed. Refresh extraction coverage.");
      const paperRows = result.filter((row) => row.paper_id != null);
      const hasMore = paperRows.length > size;
      const visible = hasMore ? paperRows.slice(0, size) : paperRows;
      const items = visible.map((row): ResearchQuestionExtractionCoverageRow => ({
        paperId: String(row.paper_id), paperTitle: String(row.paper_title),
        revisionId: row.revision_id == null ? null : String(row.revision_id),
        status: String(row.coverage_status) as ResearchQuestionExtractionCoverageRow["status"],
        displayValue: row.display_value == null ? null : String(row.display_value),
      }));
      const last = visible[visible.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: "rq-coverage", projectId, questionId, pageSize: size, epoch, highWaterSequence, fieldId, createdAt: String(last.cursor_created_at), id: String(last.paper_id) }) : null;
      return {
        items, pageSize: size, hasMore, nextCursor,
        project: { id: projectId, title: String(scope.project_title) },
        question: { id: questionId, identifier: String(scope.identifier) },
        field: { id: fieldId, name: String(scope.field_name), fieldType: String(scope.field_type) },
        traceabilityEpoch: epoch, highWaterSequence,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function listResearchQuestionAnswerCandidatePage(projectIdInput: string, questionIdInput: string, targetTypeInput: ResearchQuestionAnswerBoundedCandidateType, options: { pageSize?: number; cursor?: string | null; search?: string } = {}): Promise<ResearchQuestionAnswerCandidatePage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    if (targetTypeInput !== "claim" && targetTypeInput !== "synthesis") throw new DomainError("VALIDATION_ERROR", "Answer candidate type is invalid");
    const targetType = targetTypeInput;
    const size = pageSize(options.pageSize, RESEARCH_QUESTION_LINK_DEFAULT_PAGE_SIZE, RESEARCH_QUESTION_LINK_MAX_PAGE_SIZE);
    const search = validateSearch(options.search);
    const cursor = bindCursor<AnswerCandidateCursor>(options.cursor, { kind: "rq-answer-candidate", projectId, questionId, pageSize: size }, (raw) => ({
      v: 1, kind: "rq-answer-candidate", projectId, questionId, pageSize: size,
      targetType: String(raw.targetType) as ResearchQuestionAnswerBoundedCandidateType,
      epoch: cursorBigint(raw.epoch), highWaterSequence: cursorBigint(raw.highWaterSequence), search: String(raw.search), id: cursorUuid(raw.id),
    }));
    if (cursor && (cursor.targetType !== targetType || cursor.search !== search)) throw new DomainError("VALIDATION_ERROR", "Page link expired or invalid. Start from the first page.");
    return db.transaction(async (tx) => {
      const scope = await readQuestionScope(tx, projectId, questionId);
      const epoch = bigintText(scope.traceability_epoch, "Traceability epoch");
      const highWaterSequence = bigintText(scope[targetType === "claim" ? "claim_high_water" : "synthesis_high_water"], "Traceability event high-water sequence");
      if (cursor && (cursor.epoch !== epoch || cursor.highWaterSequence !== highWaterSequence)) throw new DomainError("CONCURRENT_MODIFICATION", "Question links changed. Refresh Answer candidates.");
      const after = cursor ? sql`and t.id>${cursor.id}::uuid` : sql``;
      const searchPattern = `%${escapedLike(search)}%`;
      const searchClause = (expression: SQL) => search ? sql`and ${expression} ilike ${searchPattern} escape E'\\\\'` : sql``;
      let candidateRows: Row[];
      if (targetType === "claim") {
        candidateRows = rows(await tx.execute(sql`
          with latest_link as (
            select distinct on(e.claim_id) e.claim_id,e.action from research_question_claim_events e
            where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint
            order by e.claim_id,e.sequence desc,e.id desc
          ), members as (
            select t.id from latest_link l join claims t on t.project_id=${projectId}::uuid and t.id=l.claim_id
            left join lateral(select x.claim_text,x.state from claim_revisions x where x.project_id=t.project_id and x.claim_id=t.id and x.finalized_at is not null order by x.sequence desc limit 1) r on true
            where l.action='linked' ${after} ${searchClause(sql`coalesce(r.claim_text,case when r.state='withdrawn' then 'Withdrawn Claim' else 'Claim without finalized revision' end)`)}
            order by t.id limit ${size + 1}
          )
          select t.id,coalesce(left(r.claim_text,240),case when r.state='withdrawn' then 'Withdrawn Claim' else 'Claim without finalized revision' end) as label,
            r.id as revision_id,r.sequence::text as revision_sequence,r.state as revision_state,r.finalized_at,
            coalesce(support.n,0)::int as support_count,
            case when r.state='active' and coalesce(support.n,0)>0 then 'supported' else 'unsupported' end as support_status,
            case when r.id is null then 'no_finalized_revision' when r.state='withdrawn' then 'withdrawn'
              when r.state<>'active' or coalesce(support.n,0)=0 then 'unsupported' else null end as reason,
            (r.id is not null and r.state='active' and coalesce(support.n,0)>0) as selectable
          from members m join claims t on t.project_id=${projectId}::uuid and t.id=m.id
          left join lateral(select x.id,x.sequence,x.state,x.claim_text,x.finalized_at from claim_revisions x where x.project_id=t.project_id and x.claim_id=t.id and x.finalized_at is not null order by x.sequence desc limit 1) r on true
          left join lateral(select (select count(*) from claim_revision_evidence_supports x where x.project_id=t.project_id and x.claim_revision_id=r.id)+(select count(*) from claim_revision_extraction_supports x where x.project_id=t.project_id and x.claim_revision_id=r.id)+(select count(*) from claim_revision_synthesis_supports x where x.project_id=t.project_id and x.claim_revision_id=r.id) as n) support on true
          where true order by t.id
        `));
      } else {
        candidateRows = rows(await tx.execute(sql`
          with latest_link as (
            select distinct on(e.synthesis_statement_id) e.synthesis_statement_id,e.action from research_question_synthesis_statement_events e
            where e.project_id=${projectId}::uuid and e.research_question_id=${questionId}::uuid and e.sequence<=${highWaterSequence}::bigint
            order by e.synthesis_statement_id,e.sequence desc,e.id desc
          ), members as (
            select t.id from latest_link l join synthesis_statements t on t.project_id=${projectId}::uuid and t.id=l.synthesis_statement_id
            left join lateral(select x.title,x.statement_text,x.state from synthesis_revisions x where x.project_id=t.project_id and x.synthesis_statement_id=t.id and x.finalized_at is not null order by x.sequence desc limit 1) r on true
            where l.action='linked' ${after} ${searchClause(sql`coalesce(r.title,r.statement_text,'Untitled Statement')`)}
            order by t.id limit ${size + 1}
          )
          select t.id,coalesce(left(r.title,240),left(r.statement_text,240),'Untitled Statement') as label,
            r.id as revision_id,r.sequence::text as revision_sequence,r.state as revision_state,r.finalized_at,
            coalesce(support.n,0)::int as support_count,
            case when coalesce(support.n,0)>0 then 'supported' else 'unsupported' end as support_status,
            case when r.id is null then 'no_finalized_revision' when r.state='withdrawn' then 'withdrawn'
              when coalesce(support.n,0)=0 then 'unsupported' else null end as reason,
            (r.id is not null and r.state<>'withdrawn' and coalesce(support.n,0)>0) as selectable,
            case when r.id is not null then exists(select 1 from synthesis_interpretations i where i.project_id=t.project_id and i.synthesis_revision_id=r.id and i.finalized_at is not null) else false end as interpretation_available
          from members m join synthesis_statements t on t.project_id=${projectId}::uuid and t.id=m.id
          left join lateral(select x.id,x.sequence,x.state,x.title,x.statement_text,x.finalized_at from synthesis_revisions x where x.project_id=t.project_id and x.synthesis_statement_id=t.id and x.finalized_at is not null order by x.sequence desc limit 1) r on true
          left join lateral(select count(*)::int as n from synthesis_revision_supports x where x.project_id=t.project_id and x.synthesis_revision_id=r.id) support on true
          where true order by t.id
        `));
      }
      const hasMore = candidateRows.length > size;
      const visible = hasMore ? candidateRows.slice(0, size) : candidateRows;
      const items = visible.map((row) => ({
        targetType, targetId: String(row.id), label: String(row.label),
        revisionId: row.revision_id == null ? null : String(row.revision_id),
        revisionSequence: row.revision_sequence == null ? null : bigintText(row.revision_sequence, "Revision sequence"),
        revisionState: row.revision_state == null ? null : String(row.revision_state),
        finalizedAt: date(row.finalized_at), isCurrentlyLinked: true as const, isCurrentRevision: row.revision_id != null,
        supportStatus: String(row.support_status) as "supported" | "unsupported", supportCount: int(row.support_count, "Support count"),
        isSelectable: bool(row.selectable), reason: row.reason == null ? null : String(row.reason) as ResearchQuestionAnswerCandidatePage["items"][number]["reason"],
        ...(targetType === "synthesis" ? { interpretationAvailable: bool(row.interpretation_available) } : {}),
      }));
      const last = visible[visible.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: "rq-answer-candidate", projectId, questionId, pageSize: size, targetType, epoch, highWaterSequence, search, id: String(last.id) }) : null;
      return { items, pageSize: size, hasMore, nextCursor, traceabilityEpoch: epoch };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function getResearchQuestionAnswerBrowserSnapshot(projectIdInput: string, questionIdInput: string, answerIdInput: string): Promise<ResearchQuestionAnswerBrowserSnapshot> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const questionId = uuid(questionIdInput, "Research Question identifier");
    const answerId = uuid(answerIdInput, "Answer identifier");
    return db.transaction(async (tx) => {
      const headerRows = rows(await tx.execute(sql`
        select p.id as project_id,left(p.title,240) as project_title,q.id as question_id,left(q.identifier,100) as identifier,
          q.traceability_epoch::text as traceability_epoch,a.id as answer_id,a.sequence::text as answer_sequence,
          a.answer_text,a.researcher_note,a.created_at,a.finalized_at
        from projects p join research_questions q on q.project_id=p.id and q.id=${questionId}::uuid
        join research_question_answers a on a.project_id=p.id and a.research_question_id=q.id and a.id=${answerId}::uuid and a.finalized_at is not null
        where p.id=${projectId}::uuid limit 1
      `));
      const header = headerRows[0];
      if (!header) throw new DomainError("NOT_FOUND", "Finalized Research Question Answer was not found");
      const claimRows = rows(await tx.execute(sql`
        select c.project_id,c.research_question_id,c.answer_id,c.claim_id,c.claim_revision_id,c.sort_order,c.created_at,
          exact.claim_text,exact.sequence::text as exact_sequence,exact.state as exact_state,
          cur.id as current_revision_id,cur.sequence::text as current_sequence,cur.state as current_state,
          (cur.id=exact.id) as is_current_revision,
          coalesce(support.n,0)::int as support_count,
          (select e.action from research_question_claim_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.claim_id=c.claim_id order by e.sequence desc,e.id desc limit 1)='linked' as currently_linked
        from research_question_answer_claim_contexts c
        join claims t on t.project_id=c.project_id and t.id=c.claim_id
        join claim_revisions exact on exact.project_id=c.project_id and exact.claim_id=c.claim_id and exact.id=c.claim_revision_id and exact.finalized_at is not null
        left join lateral(select r.id,r.sequence,r.state from claim_revisions r where r.project_id=c.project_id and r.claim_id=c.claim_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true
        left join lateral(select (select count(*) from claim_revision_evidence_supports x where x.project_id=c.project_id and x.claim_revision_id=exact.id)+(select count(*) from claim_revision_extraction_supports x where x.project_id=c.project_id and x.claim_revision_id=exact.id)+(select count(*) from claim_revision_synthesis_supports x where x.project_id=c.project_id and x.claim_revision_id=exact.id) as n) support on true
        where c.project_id=${projectId}::uuid and c.research_question_id=${questionId}::uuid and c.answer_id=${answerId}::uuid
        order by c.sort_order,c.claim_revision_id
      `));
      const synthesisRows = rows(await tx.execute(sql`
        select c.project_id,c.research_question_id,c.answer_id,c.synthesis_statement_id,c.synthesis_revision_id,c.sort_order,c.created_at,
          exact.title,exact.statement_text,exact.sequence::text as exact_sequence,exact.state as exact_state,
          cur.id as current_revision_id,cur.sequence::text as current_sequence,cur.state as current_state,
          (cur.id=exact.id) as is_current_revision,
          coalesce(support.n,0)::int as support_count,
          exists(select 1 from synthesis_interpretations i where i.project_id=c.project_id and i.synthesis_revision_id=exact.id and i.finalized_at is not null) as interpretation_available,
          (select e.action from research_question_synthesis_statement_events e where e.project_id=c.project_id and e.research_question_id=c.research_question_id and e.synthesis_statement_id=c.synthesis_statement_id order by e.sequence desc,e.id desc limit 1)='linked' as currently_linked
        from research_question_answer_synthesis_contexts c
        join synthesis_statements t on t.project_id=c.project_id and t.id=c.synthesis_statement_id
        join synthesis_revisions exact on exact.project_id=c.project_id and exact.synthesis_statement_id=c.synthesis_statement_id and exact.id=c.synthesis_revision_id and exact.finalized_at is not null
        left join lateral(select r.id,r.sequence,r.state from synthesis_revisions r where r.project_id=c.project_id and r.synthesis_statement_id=c.synthesis_statement_id and r.finalized_at is not null order by r.sequence desc limit 1) cur on true
        left join lateral(select count(*)::int as n from synthesis_revision_supports x where x.project_id=c.project_id and x.synthesis_revision_id=exact.id) support on true
        where c.project_id=${projectId}::uuid and c.research_question_id=${questionId}::uuid and c.answer_id=${answerId}::uuid
        order by c.sort_order,c.synthesis_revision_id
      `));
      const claimContexts = claimRows.map((row) => {
        const exactState = String(row.exact_state) as ResearchQuestionAnswerSnapshot["claimContexts"][number]["claimRevisionState"];
        const currentState = row.current_state == null ? null : String(row.current_state) as ResearchQuestionAnswerSnapshot["claimContexts"][number]["currentRevisionState"];
        const isCurrentRevision = bool(row.is_current_revision);
        const currentlyLinked = bool(row.currently_linked);
        const flags: ResearchQuestionAnswerSnapshot["claimContexts"][number]["driftFlags"] = [];
        if (!isCurrentRevision) flags.push("referenced_claim_revision_superseded");
        if (currentState === "withdrawn") flags.push("referenced_claim_now_withdrawn");
        if (!currentlyLinked) flags.push("referenced_claim_no_longer_linked_to_rq");
        const supportCount = int(row.support_count, "Claim support count");
        const exactSequence = bigintText(row.exact_sequence, "Claim revision sequence");
        const currentSequence = row.current_sequence == null ? null : bigintText(row.current_sequence, "Current Claim revision sequence");
        return {
          projectId: String(row.project_id), researchQuestionId: String(row.research_question_id), answerId: String(row.answer_id),
          claimId: String(row.claim_id), claimRevisionId: String(row.claim_revision_id), sortOrder: int(row.sort_order, "Claim context sort order"), createdAt: date(row.created_at)!,
          claimText: row.claim_text == null ? null : String(row.claim_text), claimRevisionSequence: exactSequence,
          claimRevisionState: exactState, isCurrentRevision, currentRevisionId: row.current_revision_id == null ? null : String(row.current_revision_id),
          currentRevisionSequence: currentSequence, currentRevisionState: currentState,
          isCurrentlyLinked: currentlyLinked, supportStatus: exactState === "active" && supportCount > 0 ? "supported" as const : "unsupported" as const, driftFlags: flags,
        };
      });
      const synthesisContexts = synthesisRows.map((row) => {
        const exactState = String(row.exact_state) as ResearchQuestionAnswerSnapshot["synthesisContexts"][number]["synthesisRevisionState"];
        const currentState = row.current_state == null ? null : String(row.current_state) as ResearchQuestionAnswerSnapshot["synthesisContexts"][number]["currentRevisionState"];
        const isCurrentRevision = bool(row.is_current_revision);
        const currentlyLinked = bool(row.currently_linked);
        const flags: ResearchQuestionAnswerSnapshot["synthesisContexts"][number]["driftFlags"] = [];
        if (!isCurrentRevision) flags.push("referenced_synthesis_revision_superseded");
        if (currentState === "withdrawn") flags.push("referenced_synthesis_now_withdrawn");
        if (!currentlyLinked) flags.push("referenced_synthesis_no_longer_linked_to_rq");
        const exactSequence = bigintText(row.exact_sequence, "Synthesis revision sequence");
        const currentSequence = row.current_sequence == null ? null : bigintText(row.current_sequence, "Current Synthesis revision sequence");
        const supportCount = int(row.support_count, "Synthesis support count");
        return {
          projectId: String(row.project_id), researchQuestionId: String(row.research_question_id), answerId: String(row.answer_id),
          synthesisStatementId: String(row.synthesis_statement_id), synthesisRevisionId: String(row.synthesis_revision_id), sortOrder: int(row.sort_order, "Synthesis context sort order"), createdAt: date(row.created_at)!,
          title: row.title == null ? null : String(row.title), statementText: row.statement_text == null ? null : String(row.statement_text),
          synthesisRevisionSequence: exactSequence, synthesisRevisionState: exactState,
          isCurrentRevision, currentRevisionId: row.current_revision_id == null ? null : String(row.current_revision_id),
          currentRevisionSequence: currentSequence, currentRevisionState: currentState,
          isCurrentlyLinked: currentlyLinked, supportStatus: supportCount > 0 ? "supported" as const : "unsupported" as const,
          interpretationAvailable: bool(row.interpretation_available), driftFlags: flags,
        };
      });
      const answerSequence = bigintText(header.answer_sequence, "Answer sequence");
      const snapshot = {
        id: String(header.answer_id), sequence: answerSequence,
        projectId, researchQuestionId: questionId, answerText: String(header.answer_text), researcherNote: header.researcher_note == null ? null : String(header.researcher_note),
        createdAt: date(header.created_at)!, finalizedAt: date(header.finalized_at)!, claimContexts, synthesisContexts,
      } satisfies ResearchQuestionAnswerBrowserSnapshot["snapshot"];
      return {
        project: { id: projectId, title: String(header.project_title) },
        question: { id: questionId, identifier: String(header.identifier) },
        traceabilityEpoch: bigintText(header.traceability_epoch, "Traceability epoch"), snapshot,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  return { getResearchQuestionMatrixPage, listResearchQuestionLinkPage, getResearchQuestionWorkspace, listResearchQuestionAnswerHistoryPage, getResearchQuestionTargetDetail, getResearchQuestionTargetPickerPage, getResearchQuestionExtractionCoveragePage, listResearchQuestionAnswerCandidatePage, getResearchQuestionAnswerBrowserSnapshot };
}

export type ResearchQuestionBoundedReadServices = ReturnType<typeof createResearchQuestionBoundedReadServices>;
