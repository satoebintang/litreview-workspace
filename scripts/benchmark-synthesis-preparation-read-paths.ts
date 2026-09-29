import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";
import { createReviewServices } from "@/application/services";
import { createSynthesisPreparationReadServices, type SynthesisPreparationCandidate } from "@/application/synthesis-preparation-read-services";
import type { Database } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";

const EXPLAIN_ONLY_50K = process.env.SYNTHESIS_PREPARATION_READ_BENCHMARK_EXPLAIN_50K_ONLY === "1";
const BENCHMARK_ONLY_50K = process.env.SYNTHESIS_PREPARATION_READ_BENCHMARK_50K_ONLY === "1";
const AI_CONTEXT_ONLY_50K = process.env.SYNTHESIS_PREPARATION_READ_BENCHMARK_AI_CONTEXT_50K_ONLY === "1";
const POPULATION_SIZES = EXPLAIN_ONLY_50K || BENCHMARK_ONLY_50K || AI_CONTEXT_ONLY_50K
  ? [50_000] as const
  : process.env.SYNTHESIS_PREPARATION_READ_BENCHMARK_50K === "0"
  ? [1_000, 10_000] as const
  : [1_000, 10_000, 50_000] as const;
const CANDIDATE_PAGE_SIZE = 50;
const LEDGER_PAGE_SIZE = 50;
const TARGET_PAGE_SIZE = 20;
const AI_HISTORY_PAGE_SIZE = 25;
const STATEMENT_TIMEOUT_MS = 120_000;
const CANDIDATE_READ_TIMEOUT_MS = 30_000;
const SEED_STATEMENT_TIMEOUT_MS = 600_000;
const SOURCE_TEXT = "Synthetic source excerpt for the Slice 47 history benchmark.";
const SOURCE_HASH = createHash("sha256").update(SOURCE_TEXT, "utf8").digest("hex");

type CapturedQuery = { query: string; params: unknown[] };
type QuerySink = { queries: CapturedQuery[] };
type Measurement<T> = {
  value: T | null;
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  payloadBytes: number | null;
  returnedItems: number | null;
  queries: CapturedQuery[];
  error?: string;
};
type Scenario = {
  size: number;
  projectId: string;
  fieldId: string;
  setId: string;
  compositionRevisionId: string;
  preparationId: string;
  firstCandidateId: string;
  firstCandidatePaperId: string;
  firstCandidateValueId: string;
  firstCandidateValue: string;
  firstEvidenceId: string;
  firstMembershipId: string;
  firstEvidenceReviewState: "unreviewed" | "needs_review" | "accepted" | "rejected";
  denseCandidateId: string;
  moderateCandidateId: string;
  sparseCandidateId: string;
  sparseCandidatePaperId: string;
  sparseCandidateValueId: string;
  sparseCandidateValue: string;
  sparseEvidenceId: string;
  sparseMembershipId: string;
  sparseMembershipOrder: number;
};

function statementCounts(queries: CapturedQuery[]) {
  return {
    statementCount: queries.length,
    selectCount: queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim())).length,
    insertCount: queries.filter(({ query }) => /^insert\b/i.test(query.trim())).length,
    deleteCount: queries.filter(({ query }) => /^delete\b/i.test(query.trim())).length,
    updateCount: queries.filter(({ query }) => /^update\b/i.test(query.trim())).length,
  };
}

function comparableTimestamp(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return value;
}

function legacyCandidateProjection(input: unknown) {
  const candidate = input as Record<string, unknown>;
  const revision = candidate.extractionRevision as Record<string, unknown>;
  const paper = candidate.paper as Record<string, unknown>;
  const connecting = candidate.connectingEvidence as Array<Record<string, unknown>>;
  const state = String(revision.valueState);
  const value = state !== "present"
    ? state.replaceAll("_", " ")
    : revision.textValue != null ? String(revision.textValue)
      : revision.numberValue != null ? String(revision.numberValue)
        : revision.booleanValue != null ? Boolean(revision.booleanValue) ? "Yes" : "No" : null;
  return {
    extractionRevisionId: String(revision.id),
    extractionValueId: String(revision.extractionValueId),
    sequence: Number(revision.sequence),
    finalizedAt: comparableTimestamp(revision.finalizedAt),
    valueState: state,
    value,
    optionId: revision.optionId == null ? null : String(revision.optionId),
    optionLabel: null as string | null,
    paper: { id: String(paper.id), title: String(paper.title) },
    isFinallyIncluded: Boolean(candidate.isFinallyIncluded),
    isCurrentExtractionRevision: Boolean(candidate.isCurrentExtractionRevision),
    selected: Boolean(candidate.selected),
    selectable: Boolean(candidate.selectable),
    membershipOrder: Math.min(...connecting.map((item) => Number(item.membershipOrder))),
    eligibilityReasons: candidate.eligibilityReasons as string[],
    warnings: candidate.warnings as string[],
  };
}

function boundedCandidateProjection(candidate: SynthesisPreparationCandidate) {
  return {
    extractionRevisionId: candidate.extractionRevisionId,
    extractionValueId: candidate.extractionValueId,
    sequence: candidate.sequence,
    finalizedAt: comparableTimestamp(candidate.finalizedAt),
    valueState: candidate.valueState,
    value: candidate.value,
    optionId: candidate.optionId,
    optionLabel: candidate.optionLabel,
    paper: candidate.paper,
    isFinallyIncluded: candidate.isFinallyIncluded,
    isCurrentExtractionRevision: candidate.isCurrentExtractionRevision,
    selected: candidate.selected,
    selectable: candidate.selectable,
    membershipOrder: candidate.membershipOrder,
    eligibilityReasons: candidate.eligibilityReasons,
    warnings: candidate.warnings,
  };
}

function quoteIdentifier(value: string) {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}

function safeError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } }
    : null;
  const message = typeof record?.cause?.message === "string"
    ? String(record?.name ?? "Error") + ": " + record.cause.message + (record.cause.code ? " (SQLSTATE " + String(record.cause.code) + ")" : "")
    : error instanceof Error ? error.name + ": " + error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\S+/gi, "[redacted database URL]").slice(0, 1_000);
}

function isTimeout(error: unknown) {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown; cause?: { code?: unknown } } : null;
  return record?.code === "57014" || record?.cause?.code === "57014" || /statement timeout|canceling statement/i.test(safeError(error));
}

function captureQueries(client: postgres.Sql, sink: QuerySink): Database {
  return drizzle(client, {
    schema,
    logger: { logQuery(query, params) { sink.queries.push({ query, params: [...params] }); } },
  }) as Database;
}

async function measure<T extends { items?: unknown[] }>(sink: QuerySink, run: () => Promise<T>): Promise<Measurement<T>> {
  sink.queries.length = 0;
  const started = process.hrtime.bigint();
  try {
    const value = await run();
    const queries = [...sink.queries];
    return {
      value,
      status: "completed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      selectCount: queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim())).length,
      payloadBytes: Buffer.byteLength(JSON.stringify(value)),
      returnedItems: Array.isArray(value.items) ? value.items.length : null,
      queries,
    };
  } catch (error) {
    const queries = [...sink.queries];
    return {
      value: null,
      status: isTimeout(error) ? "timed_out" : "failed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      selectCount: queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim())).length,
      payloadBytes: null,
      returnedItems: null,
      queries,
      error: safeError(error),
    };
  }
}

function hashedUuidSql(expression: string) {
  const digest = "md5(" + expression + ")";
  return "(substring(" + digest + " from 1 for 12) || '5' || substring(" + digest + " from 14 for 3) || 'a' || substring(" + digest + " from 18 for 15))::uuid";
}

function deterministicUuid(value: string) {
  const digest = createHash("md5").update(value, "utf8").digest("hex");
  const hex = digest.slice(0, 12) + "5" + digest.slice(13, 16) + "a" + digest.slice(17, 32);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function hashCanonical(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function textHash(value: string) {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function summarizePlan(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const root = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
  const nodes: Array<Record<string, unknown>> = [];
  function visit(node: unknown) {
    if (typeof node !== "object" || node === null) return;
    const current = node as Record<string, unknown>;
    nodes.push({
      nodeType: current["Node Type"],
      relation: current["Relation Name"],
      index: current["Index Name"],
      actualRows: current["Actual Rows"],
      loops: current["Actual Loops"],
      rowsRemovedByFilter: current["Rows Removed by Filter"],
      filter: current.Filter,
      indexCondition: current["Index Cond"],
      sortMethod: current["Sort Method"],
      sortSpaceUsed: current["Sort Space Used"],
      sortSpaceType: current["Sort Space Type"],
      sharedHitBlocks: current["Shared Hit Blocks"],
      sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"],
      tempWrittenBlocks: current["Temp Written Blocks"],
    });
    if (Array.isArray(current.Plans)) for (const child of current.Plans) visit(child);
  }
  visit(root?.Plan);
  return { planningTimeMs: root?.["Planning Time"], executionTimeMs: root?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, label: string, query: CapturedQuery | undefined) {
  if (!query) return { label, status: "missing_query" as const, plan: null };
  const started = process.hrtime.bigint();
  try {
    const result = await client.unsafe("explain (analyze, buffers, format json) " + query.query, query.params as never) as unknown as Array<Record<string, unknown>>;
    const rawPlan = result[0]?.["QUERY PLAN"] ?? null;
    return {
      label,
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sql: query.query,
      parameterCount: query.params.length,
      sqlBytes: Buffer.byteLength(query.query),
      plan: summarizePlan(rawPlan),
      rawExplainJson: rawPlan,
    };
  } catch (error) {
    return {
      label,
      status: isTimeout(error) ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sql: query.query,
      parameterCount: query.params.length,
      sqlBytes: Buffer.byteLength(query.query),
      plan: null,
      error: safeError(error),
    };
  }
}

async function explainEstimate(client: postgres.Sql, label: string, query: CapturedQuery | undefined) {
  if (!query) return { label, status: "missing_query" as const, rawExplainJson: null };
  const started = process.hrtime.bigint();
  try {
    const result = await client.unsafe("explain (format json) " + query.query, query.params as never) as unknown as Array<Record<string, unknown>>;
    const rawPlan = result[0]?.["QUERY PLAN"] ?? null;
    return {
      label,
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sql: query.query,
      params: query.params,
      parameterCount: query.params.length,
      sqlBytes: Buffer.byteLength(query.query),
      rawExplainJson: rawPlan,
    };
  } catch (error) {
    return {
      label,
      status: isTimeout(error) ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sql: query.query,
      params: query.params,
      parameterCount: query.params.length,
      sqlBytes: Buffer.byteLength(query.query),
      rawExplainJson: null,
      error: safeError(error),
    };
  }
}

async function setStatementTimeout(client: postgres.Sql, milliseconds: number) {
  await client.unsafe("set statement_timeout = '" + milliseconds + "ms'");
}

function briefPlan(plan: Record<string, unknown>) {
  const summary = plan.plan as { planningTimeMs?: number; executionTimeMs?: number; nodes?: Array<Record<string, unknown>> } | null;
  return {
    label: plan.label,
    status: plan.status,
    wallTimeMs: plan.wallTimeMs,
    executionTimeMs: summary?.executionTimeMs ?? null,
    nodes: summary?.nodes?.map((node) => ({
      nodeType: node.nodeType,
      relation: node.relation,
      index: node.index,
      actualRows: node.actualRows,
      rowsRemovedByFilter: node.rowsRemovedByFilter,
      sortMethod: node.sortMethod,
      tempReadBlocks: node.tempReadBlocks,
      tempWrittenBlocks: node.tempWrittenBlocks,
    })) ?? [],
  };
}

function requestHistoryAccess(plan: Record<string, unknown>) {
  const summary = plan.plan as { executionTimeMs?: number; nodes?: Array<Record<string, unknown>> } | null;
  const requestNode = summary?.nodes?.find((node) => node.relation === "ai_synthesis_requests");
  const rows = typeof requestNode?.actualRows === "number" ? requestNode.actualRows : null;
  const loops = typeof requestNode?.loops === "number" ? requestNode.loops : null;
  return {
    executionTimeMs: summary?.executionTimeMs ?? null,
    requestNodeType: requestNode?.nodeType ?? null,
    requestIndex: requestNode?.index ?? null,
    requestRowsVisitedOrReturned: rows !== null && loops !== null ? rows * loops : rows,
  };
}

async function seedPopulation(args: {
  client: postgres.Sql;
  services: ReturnType<typeof createReviewServices>;
  reads: ReturnType<typeof createSynthesisPreparationReadServices>;
  size: number;
}): Promise<Scenario> {
  const { client, services, reads, size } = args;
  const project = await services.createProject({ title: "Slice 47 read benchmark " + size + " " + randomUUID() });
  const field = await services.createExtractionField(project.id, { name: "Benchmark finding", fieldType: "short_text" });
  const set = (await services.createEvidenceSet(project.id, { name: "Benchmark pinned composition " + size })).set;
  const rootRevision = await client.unsafe(
    "select id from evidence_set_composition_revisions where project_id=$1::uuid and evidence_set_id=$2::uuid order by set_ordinal limit 1",
    [project.id, set.id],
  ) as unknown as Array<{ id: string }>;
  assert(rootRevision.length === 1, "Evidence Set root composition revision was not created.");

  const paperId = hashedUuidSql("$1::text || ':paper:' || " + size + "::text || ':' || g.n::text");
  const evidenceId = hashedUuidSql("$1::text || ':evidence:' || " + size + "::text || ':' || g.n::text");
  const valueId = hashedUuidSql("$1::text || ':value:' || " + size + "::text || ':' || g.n::text");
  const revisionId = hashedUuidSql("$1::text || ':revision:' || " + size + "::text || ':' || g.n::text");
  const membershipId = hashedUuidSql("$1::text || ':membership:' || " + size + "::text || ':' || g.n::text");
  const compositionId = hashedUuidSql("$1::text || ':composition:' || " + size + "::text || ':' || g.n::text");
  const insertTargets = [
    "papers", "evidence", "extraction_values", "extraction_value_revisions", "extraction_revision_evidence",
    "screening_decisions", "full_text_screening_decisions", "full_text_retrieval_attempts",
    "evidence_set_memberships", "evidence_set_composition_revisions", "evidence_set_membership_order_versions",
  ];
  await client.begin(async (tx) => {
    for (const table of insertTargets) await tx.unsafe("alter table " + quoteIdentifier(table) + " disable trigger user");
    try {
      await tx.unsafe(
        "insert into papers (id,project_id,title,authors,created_at,updated_at) " +
        "select " + paperId + ",$1::uuid,'Synthetic benchmark Paper '||g.n::text,array['Synthetic author']," +
        "timestamp with time zone '2026-09-01 00:00:00+00' + g.n*interval '1 millisecond'," +
        "timestamp with time zone '2026-09-01 00:00:00+00' + g.n*interval '1 millisecond' " +
        "from generate_series(1,$2::integer) g(n)", [project.id, size]);
      await tx.unsafe(
        "insert into evidence (id,project_id,paper_id,source_text,page_number,created_at,updated_at) " +
        "select " + evidenceId + ",$1::uuid," + paperId + ",'Synthetic benchmark source evidence '||g.n::text,1," +
        "timestamp with time zone '2026-09-01 00:00:00+00' + g.n*interval '1 millisecond'," +
        "timestamp with time zone '2026-09-01 00:00:00+00' + g.n*interval '1 millisecond' " +
        "from generate_series(1,$2::integer) g(n)", [project.id, size]);
      await tx.unsafe(
        "insert into extraction_values (id,project_id,paper_id,field_id,created_at,updated_at) " +
        "select " + valueId + ",$1::uuid," + paperId + ",$2::uuid,now(),now() from generate_series(1,$3::integer) g(n)",
        [project.id, field.id, size]);
      await tx.unsafe(
        "insert into extraction_value_revisions (id,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,created_at,finalized_at) " +
        "select " + revisionId + ",$1::uuid," + paperId + ",$2::uuid," + valueId + ",'short_text','present','Synthetic extraction value '||g.n::text,now()," +
        "timestamp with time zone '2026-09-01 00:00:00+00' + g.n*interval '1 millisecond' " +
        "from generate_series(1,$3::integer) g(n)", [project.id, field.id, size]);
      await tx.unsafe(
        "insert into extraction_revision_evidence (project_id,paper_id,revision_id,evidence_id,created_at) " +
        "select $1::uuid," + paperId + "," + revisionId + "," + evidenceId + ",now() from generate_series(1,$2::integer) g(n)",
        [project.id, size]);
      await tx.unsafe(
        "insert into screening_decisions (project_id,paper_id,decision,created_at) " +
        "select $1::uuid,p.id,'include',now() from papers p where p.project_id=$1::uuid", [project.id]);
      await tx.unsafe(
        "insert into full_text_screening_decisions (project_id,paper_id,decision,created_at) " +
        "select $1::uuid,p.id,'include',now() from papers p where p.project_id=$1::uuid", [project.id]);
      await tx.unsafe(
        "insert into full_text_retrieval_attempts (project_id,paper_id,outcome,attempted_at,created_at) " +
        "select $1::uuid,p.id,'retrieved',now(),now() from papers p where p.project_id=$1::uuid", [project.id]);
      await tx.unsafe(
        "insert into evidence_set_memberships (id,project_id,evidence_set_id,evidence_id,created_at) " +
        "select " + membershipId + ",$1::uuid,$2::uuid," + evidenceId + ",transaction_timestamp() from generate_series(1,$3::integer) g(n)",
        [project.id, set.id, size]);
      await tx.unsafe(
        "insert into evidence_set_composition_revisions (id,set_ordinal,project_id,evidence_set_id,operation_kind,previous_revision_id,head_membership_id,tail_membership_id,member_count,distinct_paper_count,target_membership_id,created_at) " +
        "select " + compositionId + ",g.n+1,$1::uuid,$2::uuid,'added'," +
        "case when g.n=1 then $4::uuid else " + compositionId.replaceAll("g.n::text", "(g.n-1)::text") + " end," +
        membershipId.replaceAll("g.n::text", "'1'") + "," + membershipId + ",g.n,g.n," + membershipId + ",transaction_timestamp() " +
        "from generate_series(1,$3::integer) g(n)", [project.id, set.id, size, String(rootRevision[0].id)]);
      await tx.unsafe(
        "insert into evidence_set_membership_order_versions (project_id,evidence_set_id,membership_id,next_membership_id,valid_from_ordinal,valid_to_ordinal) " +
        "select $1::uuid,$2::uuid," + membershipId + ",null,g.n+1,case when g.n<$3::integer then g.n+2 else null end " +
        "from generate_series(1,$3::integer) g(n)", [project.id, set.id, size]);
      if (size > 1) {
        await tx.unsafe(
          "insert into evidence_set_membership_order_versions (project_id,evidence_set_id,membership_id,next_membership_id,valid_from_ordinal,valid_to_ordinal) " +
          "select $1::uuid,$2::uuid," + membershipId + "," + membershipId.replaceAll("g.n::text", "(g.n+1)::text") + ",g.n+2,null " +
          "from generate_series(1,$3::integer-1) g(n)", [project.id, set.id, size]);
      }
    } finally {
      for (const table of insertTargets) await tx.unsafe("alter table " + quoteIdentifier(table) + " enable trigger user");
    }
  });
  await client.unsafe("analyze papers");
  await client.unsafe("analyze evidence");
  await client.unsafe("analyze extraction_value_revisions");
  await client.unsafe("analyze extraction_revision_evidence");
  await client.unsafe("analyze evidence_set_memberships");
  await client.unsafe("analyze evidence_set_membership_order_versions");
  await client.unsafe("analyze screening_decisions");
  await client.unsafe("analyze full_text_screening_decisions");
  await client.unsafe("analyze full_text_retrieval_attempts");

  // Keep the primary candidate population sparse (one pinned Evidence per
  // candidate), then add representative denser candidates at the head/middle/
  // tail of the same exact composition. This gives bounded connecting/direct
  // Evidence pages both shallow and deep cursors without multiplying every
  // candidate's linked-list history by the densest fan-out.
  const densePaperId = deterministicUuid(project.id + ":paper:" + size + ":1");
  const denseRevisionId = deterministicUuid(project.id + ":revision:" + size + ":1");
  const moderateIndex = Math.max(2, Math.floor(size / 2));
  const moderatePaperId = deterministicUuid(project.id + ":paper:" + size + ":" + moderateIndex);
  const moderateRevisionId = deterministicUuid(project.id + ":revision:" + size + ":" + moderateIndex);
  const sparsePaperId = deterministicUuid(project.id + ":paper:" + size + ":" + size);
  const sparseRevisionId = deterministicUuid(project.id + ":revision:" + size + ":" + size);
  const latestCompositionRows = await client.unsafe(
    "select id from evidence_set_composition_revisions where project_id=$1::uuid and evidence_set_id=$2::uuid order by set_ordinal desc limit 1",
    [project.id, set.id],
  ) as unknown as Array<{ id: string }>;
  let latestCompositionRevisionId = String(latestCompositionRows[0]?.id ?? "");
  assert(latestCompositionRevisionId, "Synthetic Evidence Set is missing its latest composition revision.");
  const revisionEvidenceLinks: Array<{ project_id: string; paper_id: string; revision_id: string; evidence_id: string }> = [];
  for (const density of [
    { label: "dense", paperId: densePaperId, revisionId: denseRevisionId, extraPinned: 50 },
    { label: "moderate", paperId: moderatePaperId, revisionId: moderateRevisionId, extraPinned: 4 },
  ]) {
    for (let ordinal = 2; ordinal <= density.extraPinned + 1; ordinal += 1) {
      const evidence = await services.recordEvidence(project.id, {
        paperId: density.paperId,
        sourceText: "Synthetic " + density.label + " linked passage " + ordinal,
        pageNumber: ordinal,
      });
      revisionEvidenceLinks.push({ project_id: project.id, paper_id: density.paperId, revision_id: density.revisionId, evidence_id: evidence.id });
      const added = await services.addEvidenceToSet(project.id, set.id, {
        evidenceId: evidence.id,
        expectedRevisionId: latestCompositionRevisionId,
      });
      latestCompositionRevisionId = added.revision.id;
    }
  }
  // Outside-pin direct Evidence creates a separate direct-evidence fan-out
  // while keeping candidate reachability restricted to the pinned sources.
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const evidence = await services.recordEvidence(project.id, {
      paperId: densePaperId,
      sourceText: "Synthetic direct-only passage " + ordinal,
      pageNumber: 100 + ordinal,
    });
    revisionEvidenceLinks.push({ project_id: project.id, paper_id: densePaperId, revision_id: denseRevisionId, evidence_id: evidence.id });
  }
  await client.begin(async (tx) => {
    await tx.unsafe("alter table extraction_revision_evidence disable trigger user");
    try {
      await tx.unsafe(
        "insert into extraction_revision_evidence (project_id,paper_id,revision_id,evidence_id,created_at) " +
        "select link.project_id,link.paper_id,link.revision_id,link.evidence_id,now() " +
        "from jsonb_to_recordset($1::jsonb) as link(project_id uuid,paper_id uuid,revision_id uuid,evidence_id uuid)",
        [JSON.stringify(revisionEvidenceLinks)],
      );
    } finally {
      await tx.unsafe("alter table extraction_revision_evidence enable trigger user");
    }
  });
  await client.unsafe("analyze extraction_revision_evidence");

  const preparation = await services.createSynthesisPreparation(project.id, {
    evidenceSetId: set.id,
    extractionFieldId: field.id,
  });
  // The estimate-only 50k path must not execute the expensive candidate CTE
  // while validating the fixture. Its rows are generated from deterministic
  // IDs above, so derive the probe candidate and pinned Evidence identities
  // directly and let plain EXPLAIN inspect the candidate query later.
  let firstCandidateId = deterministicUuid(project.id + ":revision:" + size + ":1");
  let firstCandidatePaperId = deterministicUuid(project.id + ":paper:" + size + ":1");
  let firstCandidateValueId = deterministicUuid(project.id + ":value:" + size + ":1");
  let firstCandidateValue = "Synthetic extraction value 1";
  let firstEvidenceId = deterministicUuid(project.id + ":evidence:" + size + ":1");
  let firstMembershipId = deterministicUuid(project.id + ":membership:" + size + ":1");
  let firstEvidenceReviewState: Scenario["firstEvidenceReviewState"] = "unreviewed";
  if (!EXPLAIN_ONLY_50K && !BENCHMARK_ONLY_50K && !AI_CONTEXT_ONLY_50K) {
    const candidatePage = await reads.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 1 });
    assert(candidatePage.candidateCount === size && candidatePage.items.length === 1, "Candidate fixture did not produce the requested exact count at " + size + ".");
    const candidate = candidatePage.items[0];
    const evidencePage = await reads.listSynthesisPreparationConnectingEvidence(project.id, preparation.id, candidate.extractionRevisionId, { pageSize: 1 });
    assert(evidencePage.items.length === 1 && evidencePage.items[0].membershipId, "Candidate fixture lacks its pinned connecting Evidence membership.");
    firstCandidateId = candidate.extractionRevisionId;
    firstCandidatePaperId = candidate.paper.id;
    firstCandidateValueId = candidate.extractionValueId;
    firstCandidateValue = candidate.value ?? firstCandidateValue;
    firstEvidenceId = evidencePage.items[0].id;
    firstMembershipId = String(evidencePage.items[0].membershipId);
    firstEvidenceReviewState = evidencePage.items[0].reviewState;
  }

  // The bulk-created ledger rows share the valid set and field but remain unselected.
  const prepId = hashedUuidSql("$1::text || ':ledger-preparation:' || $2::text || ':' || g.n::text");
  if (size > 1) {
    await client.unsafe(
      "insert into synthesis_preparations (id,project_id,evidence_set_id,evidence_set_composition_revision_id,extraction_field_id,working_title,working_note,status,created_at,updated_at) " +
      "select " + prepId + ",$1::uuid,$2::uuid,$3::uuid,$4::uuid,'Synthetic ledger preparation '||g.n::text,null,'active'," +
      "now()-g.n*interval '1 millisecond',now()-g.n*interval '1 millisecond' from generate_series(1,$5::integer) g(n)",
      [project.id, set.id, preparation.evidenceSetCompositionRevisionId, field.id, size - 1],
    );
  }

  // Same-Project target picker population: one finalized current revision per target.
  const statementId = hashedUuidSql("$1::text || ':statement:' || $2::text || ':' || g.n::text");
  const synthesisRevisionId = hashedUuidSql("$1::text || ':statement-revision:' || $2::text || ':' || g.n::text");
  const targetCreatedAt = "timestamp with time zone '2026-09-01 00:00:00+00' + g.n*interval '1 millisecond'";
  const targetTables = ["synthesis_statements", "synthesis_revisions"];
  await client.begin(async (tx) => {
    for (const table of targetTables) await tx.unsafe("alter table " + quoteIdentifier(table) + " disable trigger user");
    try {
      await tx.unsafe(
        "insert into synthesis_statements (id,project_id,created_at) select " + statementId + ",$1::uuid," + targetCreatedAt +
        " from generate_series(1,$3::integer) g(n)", [project.id, size, size]);
      await tx.unsafe(
        "insert into synthesis_revisions (id,project_id,synthesis_statement_id,state,title,statement_text,created_at,finalized_at) " +
        "select " + synthesisRevisionId + ",$1::uuid," + statementId + ",'active','Synthetic benchmark target '||g.n::text," +
        "'Synthetic target statement body '||g.n::text," + targetCreatedAt + "," + targetCreatedAt + " from generate_series(1,$3::integer) g(n)",
        [project.id, size, size]);
    } finally {
      for (const table of targetTables) await tx.unsafe("alter table " + quoteIdentifier(table) + " enable trigger user");
    }
  });
  await client.unsafe("analyze synthesis_preparations");
  await client.unsafe("analyze synthesis_statements");
  await client.unsafe("analyze synthesis_revisions");

  return {
    size,
    projectId: project.id,
    fieldId: field.id,
    setId: set.id,
    compositionRevisionId: preparation.evidenceSetCompositionRevisionId,
    preparationId: preparation.id,
    firstCandidateId,
    firstCandidatePaperId,
    firstCandidateValueId,
    firstCandidateValue,
    firstEvidenceId,
    firstMembershipId,
    firstEvidenceReviewState,
    denseCandidateId: denseRevisionId,
    moderateCandidateId: moderateRevisionId,
    sparseCandidateId: sparseRevisionId,
    sparseCandidatePaperId: sparsePaperId,
    sparseCandidateValueId: deterministicUuid(project.id + ":value:" + size + ":" + size),
    sparseCandidateValue: "Synthetic extraction value " + size,
    sparseEvidenceId: deterministicUuid(project.id + ":evidence:" + size + ":" + size),
    sparseMembershipId: deterministicUuid(project.id + ":membership:" + size + ":" + size),
    sparseMembershipOrder: size,
  };
}

async function seedAiHistory(client: postgres.Sql, scenario: Scenario, historyCount = scenario.size) {
  const size = scenario.size;
  const requestId = hashedUuidSql("$1::text || ':ai-request:' || $2::text || ':' || g.n::text");
  const idempotencyId = hashedUuidSql("$1::text || ':ai-idempotency:' || $2::text || ':' || g.n::text");
  const supportRowTime = "now()-g.n*interval '1 millisecond'";
  await client.begin(async (tx) => {
    await tx.unsafe("alter table ai_synthesis_requests disable trigger ai_synthesis_requests_manifest_guard");
    try {
      await tx.unsafe(
        "insert into ai_synthesis_requests (id,project_id,project_title_snapshot,preparation_id,evidence_set_id,evidence_set_composition_revision_id,extraction_field_id,target_synthesis_statement_id,target_baseline_synthesis_revision_id,target_title_snapshot,target_statement_text_snapshot,idempotency_key,source_state_hash,intent_hash,field_name_snapshot,field_description_snapshot,field_type,provider,configured_model,configured_reasoning_effort,prompt_version,response_schema_version,grounding_resolver_version,context_selection_version,source_coverage_state,support_count,source_count,source_character_count,source_byte_size,source_manifest_hash,external_transmission_acknowledged,disclosure_version,created_at,undispatched_expires_at) " +
        "select " + requestId + ",$1::uuid,'Slice 47 benchmark Project',$2::uuid,$3::uuid,$4::uuid,$5::uuid,null,null,null,null," +
        idempotencyId + ",repeat('a',64),repeat('b',64),'Benchmark finding',null,'short_text','synthetic','benchmark-model','low','benchmark-prompt-v1','benchmark-schema-v1','benchmark-grounding-v1','benchmark-context-v1','complete',1,1,$6::integer,$6::integer,repeat('c',64),true,'slice47-benchmark'," +
        supportRowTime + "," + supportRowTime + "+interval '5 minutes' from generate_series(1,$7::integer) g(n)",
        [scenario.projectId, scenario.preparationId, scenario.setId, scenario.compositionRevisionId, scenario.fieldId, Buffer.byteLength(SOURCE_TEXT), historyCount],
      );
      await tx.unsafe(
        "insert into ai_synthesis_request_supports (project_id,request_id,extraction_revision_id,support_ordinal,paper_id,extraction_field_id,extraction_value_id,field_type,value_state,text_value,number_value,boolean_value,option_id,option_label_snapshot,researcher_note,paper_title_snapshot,paper_publication_year_snapshot,created_at) " +
        "select $1::uuid," + requestId + ",$3::uuid,0,$4::uuid,$5::uuid,$6::uuid,'short_text','present',$7::text,null,null,null,null,null,'Synthetic benchmark Paper " + size + "',null," + supportRowTime + " from generate_series(1,$8::integer) g(n)",
        [scenario.projectId, scenario.preparationId, scenario.sparseCandidateId, scenario.sparseCandidatePaperId, scenario.fieldId, scenario.sparseCandidateValueId, scenario.sparseCandidateValue, historyCount],
      );
      await tx.unsafe(
        "insert into ai_synthesis_request_sources (id,project_id,request_id,extraction_revision_id,evidence_id,paper_id,source_ordinal,membership_id,membership_sort_order,page_number,source_text,source_text_sha256,source_character_count,source_byte_size,evidence_review_state,evidence_note_snapshot,created_at) " +
        "select " + hashedUuidSql("$1::text || ':ai-source:' || $2::text || ':' || g.n::text") + ",$1::uuid," + requestId + ",$3::uuid,$4::uuid,$5::uuid,0,$6::uuid,$11::integer,1,$7::text,$8::text,$9::integer,$9::integer,$10::text,null," + supportRowTime + " from generate_series(1,$12::integer) g(n)",
        [scenario.projectId, scenario.preparationId, scenario.sparseCandidateId, scenario.sparseEvidenceId, scenario.sparseCandidatePaperId,
          scenario.sparseMembershipId, SOURCE_TEXT, SOURCE_HASH, Buffer.byteLength(SOURCE_TEXT), scenario.firstEvidenceReviewState, scenario.sparseMembershipOrder, historyCount],
      );
    } finally {
      await tx.unsafe("alter table ai_synthesis_requests enable trigger ai_synthesis_requests_manifest_guard");
    }
  });
  await client.unsafe("analyze ai_synthesis_requests");
  await client.unsafe("analyze ai_synthesis_request_supports");
  await client.unsafe("analyze ai_synthesis_request_sources");
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to PostgreSQL 16 credentials that can create/drop a unique disposable database and own the migrated benchmark schema.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = "litreview_synthesis_preparation_read_" + process.pid + "_" + Date.now() + "_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = "/" + databaseName;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  const sink: QuerySink = { queries: [] };
  let created = false;
  let client: postgres.Sql | undefined;
  let postgresServerVersion: string | null = null;
  let postgresServerVersionNum: number | null = null;
  try {
    const versions = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const version = Number(versions[0]?.version);
    if (Math.floor(version / 10_000) !== 16) throw new Error("Requires PostgreSQL 16; connected server version number is " + version + ".");
    await admin.unsafe("create database " + quoteIdentifier(databaseName));
    created = true;
    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }
    // The legacy create-preparation service opens a transaction and performs
    // one Field lookup through the outer Database pool, so a single connection
    // would self-deadlock while the transaction holds it.
    client = postgres(benchmarkUrl.toString(), { max: 4, prepare: false, onnotice: () => {} });
    const serverVersionRows = await client.unsafe("show server_version") as unknown as Array<{ server_version: string }>;
    const serverVersionNumRows = await client.unsafe("show server_version_num") as unknown as Array<{ server_version_num: string }>;
    postgresServerVersion = String(serverVersionRows[0]?.server_version ?? "");
    postgresServerVersionNum = Number(serverVersionNumRows[0]?.server_version_num);
    if (!postgresServerVersion || !Number.isSafeInteger(postgresServerVersionNum)) {
      throw new Error("The benchmark database did not return valid PostgreSQL server version metadata.");
    }
    await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
    const proposedIndexName = "ai_synthesis_requests_project_preparation_created_id_idx";
    const proposedIndexDdl = `CREATE INDEX "${proposedIndexName}" ON "ai_synthesis_requests" USING btree ("project_id","preparation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST)`;
    await client.unsafe("drop index if exists " + quoteIdentifier(proposedIndexName));
    await client.unsafe("analyze ai_synthesis_requests");
    const readDb = captureQueries(client, sink);
    const services = createReviewServices(readDb);
    const reads = createSynthesisPreparationReadServices(readDb);
    const ai = createAiSynthesisSuggestionServices(readDb, undefined, {
      finalizePreparationInTransaction: async () => { throw new Error("The read benchmark must not finalize a preparation."); },
    });

    console.log(JSON.stringify({
      benchmark: "Slice 47 bounded SynthesisPreparation reads",
      postgresMajor: 16,
      populationSizes: POPULATION_SIZES,
      candidatePageSize: CANDIDATE_PAGE_SIZE,
      ledgerPageSize: LEDGER_PAGE_SIZE,
      targetPageSize: TARGET_PAGE_SIZE,
      aiHistoryPageSize: AI_HISTORY_PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      seedStatementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      note: "Synthetic, relationally consistent fixtures live only in one uniquely named migrated database that is force-dropped in finally. User triggers are temporarily disabled only for fixture composition/link inserts and generated AI history rows; foreign keys and CHECK constraints remain active. AI manifest validation is bypassed for compact-history rows; one normal begin-only call per size measures selected-support/pinned-source context, and no provider dispatch occurs. Legacy full-workspace parity/payload is measured at 1k and 10k; 50k is skipped because it materializes all candidate/Evidence/composition objects in Node. CandidateCount means frozen all-epoch candidates; filter applies to items and hasMore. Timings are diagnostic evidence, not thresholds.",
      aiPageIndexTest: { baseline: "Slice 46-equivalent history index state; the migrated 0036 index is dropped before measurement", simulatedIndex: proposedIndexDdl },
    }));

    const scenarios: Scenario[] = [];
    const populationMeasurements: Array<Record<string, unknown>> = [];
    let highCardReachabilityQuery: CapturedQuery | undefined;
    for (const size of POPULATION_SIZES) {
      await setStatementTimeout(client, SEED_STATEMENT_TIMEOUT_MS);
      const scenario = await seedPopulation({ client, services, reads, size });
      await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
      scenarios.push(scenario);
      if (AI_CONTEXT_ONLY_50K) continue;

      if (EXPLAIN_ONLY_50K && size === 50_000) {
        // A prior high-cardinality run showed the first candidate SELECT can
        // be long when a plan changes shape. Capture its exact Drizzle SQL by
        // allowing only a brief attempt, then obtain a non-executing estimate
        // from the same seeded fixture before choosing any ANALYZE retry.
        const probeClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
        try {
          await setStatementTimeout(probeClient, 10);
          const probeSink: QuerySink = { queries: [] };
          const probeReads = createSynthesisPreparationReadServices(captureQueries(probeClient, probeSink));
          const probe = await measure(probeSink, () => probeReads.listSynthesisPreparationCandidates(scenario.projectId, scenario.preparationId, { pageSize: CANDIDATE_PAGE_SIZE }));
          const candidateQuery = probe.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()));
          await setStatementTimeout(probeClient, SEED_STATEMENT_TIMEOUT_MS);
          assert(candidateQuery, "Could not capture the 50k candidate-page SQL for estimate-only EXPLAIN.");
          const candidatePlan50kEstimate = await explainEstimate(probeClient, "candidates.50000.first-page.estimate-only", candidateQuery);
          const planCheckpointPath = resolve(process.cwd(), "work/slice47-candidate-plan-50k-estimate.json");
          mkdirSync(dirname(planCheckpointPath), { recursive: true });
          writeFileSync(planCheckpointPath, JSON.stringify({
            benchmark: "Slice 47 bounded SynthesisPreparation reads",
            postgresMajor: 16,
            generatedAt: new Date().toISOString(),
            populationSize: size,
            candidateProbe: {
              status: probe.status,
              wallTimeMs: probe.wallTimeMs,
              statementCount: probe.statementCount,
              selectCount: probe.selectCount,
              error: probe.error,
            },
            explainEstimate: candidatePlan50kEstimate,
          }, null, 2) + "\n", "utf8");
          console.log(JSON.stringify({
            phase: "50k-estimate-plan",
            planCheckpointPath,
            candidateProbeStatus: probe.status,
            candidateProbeWallTimeMs: probe.wallTimeMs,
            planStatus: candidatePlan50kEstimate.status,
            planWallTimeMs: candidatePlan50kEstimate.wallTimeMs,
            plan: candidatePlan50kEstimate.rawExplainJson,
          }));
          return;
        } finally {
          await probeClient.end({ timeout: 1 });
        }
      }

      await setStatementTimeout(client, CANDIDATE_READ_TIMEOUT_MS);
      const candidate = await measure(sink, () => reads.listSynthesisPreparationCandidates(scenario.projectId, scenario.preparationId, { pageSize: CANDIDATE_PAGE_SIZE }));
      await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
      assert(candidate.status === "completed" && candidate.value, "Candidate first page failed at " + size + ": " + candidate.error);
      assert(candidate.selectCount === 1 && candidate.value.items.length <= CANDIDATE_PAGE_SIZE, "Candidate page exceeded its one-SELECT/row-bound contract at " + size + ".");
      assert(candidate.value.candidateCount === size, "Candidate count mismatch at " + size + ".");
      assert(candidate.value.items[0]?.extractionRevisionId === scenario.denseCandidateId, "Dense sample is not first in the pinned membership order at " + size + ".");
      const candidateFirstQuery = candidate.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()));
      let candidatePlan10k = null;
      if (size === 10_000) {
        await setStatementTimeout(client, SEED_STATEMENT_TIMEOUT_MS);
        candidatePlan10k = await explain(client, "candidates.10000.first-page", candidateFirstQuery);
        await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
        const planCheckpointPath = resolve(process.cwd(), "work/slice47-candidate-plan-10k.json");
        mkdirSync(dirname(planCheckpointPath), { recursive: true });
        writeFileSync(planCheckpointPath, JSON.stringify({
          benchmark: "Slice 47 bounded SynthesisPreparation reads",
          postgresMajor: 16,
          generatedAt: new Date().toISOString(),
          populationSize: size,
          candidatePage: {
            wallTimeMs: candidate.wallTimeMs,
            statementCount: candidate.statementCount,
            selectCount: candidate.selectCount,
            returnedItems: candidate.returnedItems,
            candidateCount: candidate.value.candidateCount,
            payloadBytes: candidate.payloadBytes,
          },
          explainAnalyzeBuffersFormatJson: candidatePlan10k,
        }, null, 2) + "\n", "utf8");
      }
      let candidateContinuation: Measurement<Awaited<ReturnType<typeof reads.listSynthesisPreparationCandidates>>> | null = null;
      let candidateDeepPage: Measurement<Awaited<ReturnType<typeof reads.listSynthesisPreparationCandidates>>> | null = null;
      if (candidate.value.nextCursor) {
        await setStatementTimeout(client, CANDIDATE_READ_TIMEOUT_MS);
        candidateContinuation = await measure(sink, () => reads.listSynthesisPreparationCandidates(scenario.projectId, scenario.preparationId, {
          pageSize: CANDIDATE_PAGE_SIZE,
          cursor: candidate.value!.nextCursor,
        }));
        await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
        assert(candidateContinuation.status === "completed" && candidateContinuation.value, "Candidate continuation failed at " + size + ": " + candidateContinuation.error);
        assert(candidateContinuation.selectCount === 1 && candidateContinuation.value.candidateCount === size, "Candidate continuation did not reuse its epoch count at " + size + ".");
        if (size === 50_000) {
          let cursor = candidateContinuation.value.nextCursor;
          let pageNumber = 2;
          while (cursor && pageNumber < 10) {
            await setStatementTimeout(client, CANDIDATE_READ_TIMEOUT_MS);
            candidateDeepPage = await measure(sink, () => reads.listSynthesisPreparationCandidates(scenario.projectId, scenario.preparationId, {
              pageSize: CANDIDATE_PAGE_SIZE,
              cursor,
            }));
            await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
            assert(candidateDeepPage.status === "completed" && candidateDeepPage.value, "Candidate deep cursor failed at page " + (pageNumber + 1) + ": " + candidateDeepPage.error);
            assert(candidateDeepPage.selectCount === 1 && candidateDeepPage.value.candidateCount === size, "Candidate deep cursor did not preserve its one-SELECT epoch at page " + (pageNumber + 1) + ".");
            cursor = candidateDeepPage.value.nextCursor;
            pageNumber += 1;
          }
          assert(pageNumber === 10 && candidateDeepPage?.value, "Candidate keyset benchmark did not reach page 10.");
        }
      }

      let legacyWorkspace: Measurement<Awaited<ReturnType<typeof services.getSynthesisPreparationWorkspace>>> | null = null;
      let legacyComparison: Record<string, unknown>;
      if (size <= 10_000) {
        legacyWorkspace = await measure(sink, () => services.getSynthesisPreparationWorkspace(scenario.projectId, scenario.preparationId));
        assert(legacyWorkspace.status === "completed" && legacyWorkspace.value, "Legacy full workspace failed at practical size " + size + ": " + legacyWorkspace.error);
        const legacyPage = legacyWorkspace.value.candidates.slice(0, candidate.value.items.length).map(legacyCandidateProjection);
        const boundedPage = candidate.value.items.map(boundedCandidateProjection);
        const mismatchIndex = legacyPage.findIndex((legacy, index) => JSON.stringify(legacy) !== JSON.stringify(boundedPage[index]));
        if (mismatchIndex >= 0) {
          const legacy = legacyPage[mismatchIndex] as Record<string, unknown>;
          const bounded = boundedPage[mismatchIndex] as Record<string, unknown>;
          const differences = Object.keys(legacy).filter((key) => JSON.stringify(legacy[key]) !== JSON.stringify(bounded[key]))
            .map((key) => ({ field: key, legacy: legacy[key], bounded: bounded[key] }));
          throw new Error("Bounded first-page legacy comparison differed at " + size + " candidates, item " + mismatchIndex + ": " + JSON.stringify(differences));
        }
        legacyComparison = {
          status: legacyWorkspace.status,
          wallTimeMs: legacyWorkspace.wallTimeMs,
          statementCount: legacyWorkspace.statementCount,
          selectCount: legacyWorkspace.selectCount,
          returnedCandidates: legacyWorkspace.value.candidates.length,
          payloadBytes: legacyWorkspace.payloadBytes,
          boundedPageItems: candidate.value.items.length,
          boundedPayloadBytes: candidate.payloadBytes,
          firstPageIdentityOrderAndLiveAnnotationParity: true,
        };
        // Drop the full-workspace object before measuring further rows.
        legacyWorkspace.value = null;
      } else {
        legacyComparison = {
          status: "not_run",
          reason: "The released API materializes all 50,000 candidate objects, connecting Evidence arrays, and composition members in Node. The old path was measured and parity-checked at 1,000 and 10,000; 50,000 legacy materialization was skipped to avoid an uncontrolled memory spike.",
        };
      }

      const selectedCountSeeded = Math.min(size - 3, Math.max(10, Math.floor(size / 100)));
      const selectedIds = await client.unsafe(
        "select r.id from extraction_value_revisions r where r.project_id=$1::uuid and r.field_id=$2::uuid and r.finalized_at is not null and r.id not in ($3::uuid,$4::uuid,$5::uuid) order by r.id limit $6::integer",
        [scenario.projectId, scenario.fieldId, scenario.denseCandidateId, scenario.moderateCandidateId, scenario.sparseCandidateId, selectedCountSeeded],
      ) as unknown as Array<{ id: string }>;
      assert(selectedIds.length === selectedCountSeeded, "Could not create the requested varying selected-set cardinality at " + size + ".");
      await client.unsafe(
        "insert into synthesis_preparation_selections (project_id,preparation_id,extraction_revision_id,created_at) select $1::uuid,$2::uuid,selected.id::uuid,now() from jsonb_array_elements_text($3::jsonb) selected(id)",
        [scenario.projectId, scenario.preparationId, JSON.stringify(selectedIds.map(({ id }) => id))],
      );
      await setStatementTimeout(client, CANDIDATE_READ_TIMEOUT_MS);
      const selectedCandidates = await measure(sink, () => reads.listSynthesisPreparationCandidates(scenario.projectId, scenario.preparationId, {
        pageSize: CANDIDATE_PAGE_SIZE,
        filter: "selected",
      }));
      await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
      assert(selectedCandidates.status === "completed" && selectedCandidates.value, "Selected candidate filter failed at " + size + ": " + selectedCandidates.error);
      assert(selectedCandidates.selectCount === 1 && selectedCandidates.value.candidateCount === size
        && selectedCandidates.value.items.length <= CANDIDATE_PAGE_SIZE,
      "Selected candidate page violated its bounded-row/all-epoch-count contract at " + size + ".");

      const ledger = await measure(sink, () => reads.listSynthesisPreparationLedger(scenario.projectId, { pageSize: LEDGER_PAGE_SIZE }));
      assert(ledger.status === "completed" && ledger.value, "Preparation ledger failed at " + size + ": " + ledger.error);
      assert(ledger.selectCount === 2 && ledger.value.items.length <= LEDGER_PAGE_SIZE, "Preparation ledger exceeded its two-SELECT/row-bound contract at " + size + ".");
      assert(ledger.value.items.every((item) => !("candidateCount" in item)), "Ledger unexpectedly contains candidate counts.");

      const target = await measure(sink, () => reads.listSynthesisTargetStatementOptions(scenario.projectId, { pageSize: TARGET_PAGE_SIZE }));
      assert(target.status === "completed" && target.value, "Target browse failed at " + size + ": " + target.error);
      assert(target.selectCount === 1 && target.value.items.length <= TARGET_PAGE_SIZE, "Target browse exceeded its one-SELECT/row-bound contract at " + size + ".");

      const targetSearch = await measure(sink, () => reads.listSynthesisTargetStatementOptions(scenario.projectId, { pageSize: TARGET_PAGE_SIZE, query: "target statement " + size }));
      assert(targetSearch.status === "completed" && targetSearch.value, "Target search failed at " + size + ": " + targetSearch.error);
      assert(targetSearch.selectCount === 1 && targetSearch.value.items.length <= TARGET_PAGE_SIZE, "Target search exceeded its one-SELECT/row-bound contract at " + size + ".");

      const connectingSparse = await measure(sink, () => reads.listSynthesisPreparationConnectingEvidence(scenario.projectId, scenario.preparationId, scenario.sparseCandidateId, { pageSize: 25 }));
      const connectingModerate = await measure(sink, () => reads.listSynthesisPreparationConnectingEvidence(scenario.projectId, scenario.preparationId, scenario.moderateCandidateId, { pageSize: 25 }));
      const connectingDenseFirst = await measure(sink, () => reads.listSynthesisPreparationConnectingEvidence(scenario.projectId, scenario.preparationId, scenario.denseCandidateId, { pageSize: 25 }));
      assert(connectingSparse.status === "completed" && connectingSparse.value?.items.length === 1 && !connectingSparse.value.hasMore, "Sparse pinned Evidence fixture was not measured as one item at " + size + ".");
      assert(connectingModerate.status === "completed" && connectingModerate.value?.items.length === 5 && !connectingModerate.value.hasMore, "Moderate pinned Evidence fixture was not measured as five items at " + size + ".");
      assert(connectingDenseFirst.status === "completed" && connectingDenseFirst.value?.items.length === 25 && connectingDenseFirst.value.hasMore, "Dense pinned Evidence page one violated its 25-row bound at " + size + ".");
      let connectingDenseSecond: Measurement<Awaited<ReturnType<typeof reads.listSynthesisPreparationConnectingEvidence>>> | null = null;
      let connectingDenseThird: Measurement<Awaited<ReturnType<typeof reads.listSynthesisPreparationConnectingEvidence>>> | null = null;
      if (connectingDenseFirst.value.nextCursor) {
        connectingDenseSecond = await measure(sink, () => reads.listSynthesisPreparationConnectingEvidence(scenario.projectId, scenario.preparationId, scenario.denseCandidateId, {
          pageSize: 25,
          cursor: connectingDenseFirst.value!.nextCursor,
        }));
      }
      if (connectingDenseSecond?.value?.nextCursor) {
        connectingDenseThird = await measure(sink, () => reads.listSynthesisPreparationConnectingEvidence(scenario.projectId, scenario.preparationId, scenario.denseCandidateId, {
          pageSize: 25,
          cursor: connectingDenseSecond!.value!.nextCursor,
        }));
      }
      assert(connectingDenseSecond?.status === "completed" && connectingDenseSecond.value?.items.length === 25 && connectingDenseSecond.value.hasMore,
        "Dense pinned Evidence page two was not reached at " + size + ".");
      assert(connectingDenseThird?.status === "completed" && connectingDenseThird.value?.items.length === 1 && !connectingDenseThird.value.hasMore,
        "Dense pinned Evidence deep page three was not reached at " + size + ".");

      const directDenseFirst = await measure(sink, () => reads.listSynthesisPreparationDirectEvidence(scenario.projectId, scenario.preparationId, scenario.denseCandidateId, { pageSize: 25 }));
      assert(directDenseFirst.status === "completed" && directDenseFirst.value?.items.length === 25 && directDenseFirst.value.hasMore,
        "Dense direct Evidence page one violated its 25-row bound at " + size + ".");
      let directDenseSecond: Measurement<Awaited<ReturnType<typeof reads.listSynthesisPreparationDirectEvidence>>> | null = null;
      let directDenseThird: Measurement<Awaited<ReturnType<typeof reads.listSynthesisPreparationDirectEvidence>>> | null = null;
      if (directDenseFirst.value.nextCursor) {
        directDenseSecond = await measure(sink, () => reads.listSynthesisPreparationDirectEvidence(scenario.projectId, scenario.preparationId, scenario.denseCandidateId, {
          pageSize: 25,
          cursor: directDenseFirst.value!.nextCursor,
        }));
      }
      if (directDenseSecond?.value?.nextCursor) {
        directDenseThird = await measure(sink, () => reads.listSynthesisPreparationDirectEvidence(scenario.projectId, scenario.preparationId, scenario.denseCandidateId, {
          pageSize: 25,
          cursor: directDenseSecond!.value!.nextCursor,
        }));
      }
      assert(directDenseSecond?.status === "completed" && directDenseSecond.value?.items.length === 25 && directDenseSecond.value.hasMore,
        "Dense direct Evidence page two was not reached at " + size + ".");
      assert(directDenseThird?.status === "completed" && directDenseThird.value?.items.length === 4 && !directDenseThird.value.hasMore,
        "Dense direct Evidence deep page three was not reached at " + size + ".");

      const selectOne = await measure(sink, async () => ({
        selected: await services.selectSynthesisPreparationRevision(scenario.projectId, scenario.preparationId, {
          extractionRevisionId: scenario.firstCandidateId,
        }),
      }));
      assert(selectOne.status === "completed" && selectOne.value, "Select-one service path failed at " + size + ": " + selectOne.error);
      const selectCounts = statementCounts(selectOne.queries);
      const reachabilityQuery = selectOne.queries.find(({ query }) => /as is_reachable/i.test(query));
      assert(selectCounts.selectCount === 3 && selectCounts.insertCount === 1 && selectCounts.updateCount === 1 && selectCounts.deleteCount === 0 && reachabilityQuery,
        "Select-one service path did not contain its expected validation query and insert/update counts at " + size + ".");

      const deselectOne = await measure(sink, async () => ({
        selected: await services.deselectSynthesisPreparationRevision(scenario.projectId, scenario.preparationId, { extractionRevisionId: scenario.firstCandidateId }),
      }));
      assert(deselectOne.status === "completed" && deselectOne.value, "Deselect-one service path failed at " + size + ": " + deselectOne.error);
      const deselectCounts = statementCounts(deselectOne.queries);
      assert(deselectCounts.selectCount === 1 && deselectCounts.deleteCount === 1 && deselectCounts.updateCount === 1 && deselectCounts.insertCount === 0,
        "Deselect-one service path did not contain its expected delete/update counts at " + size + ".");
      if (size === 50_000) highCardReachabilityQuery = reachabilityQuery;

      // Restore one selection with the service so the generated compact AI
      // history rows describe a realistic selected candidate.
      await services.selectSynthesisPreparationRevision(scenario.projectId, scenario.preparationId, {
        extractionRevisionId: scenario.firstCandidateId,
      });

      const ledgerPageQuery = ledger.queries.find(({ query }) => /with\s+page_candidates\s+as\s+materialized/i.test(query.trim()));
      assert(ledgerPageQuery, "Preparation ledger page query was not captured for EXPLAIN.");
      const population = {
        requestedCandidates: size,
        requestedLedgerPreparations: size,
        requestedTargetStatements: size,
        candidateFirstPage: {
          status: candidate.status,
          wallTimeMs: candidate.wallTimeMs,
          statementCount: candidate.statementCount,
          selectCount: candidate.selectCount,
          returnedItems: candidate.returnedItems,
          candidateCount: candidate.value.candidateCount,
          payloadBytes: candidate.payloadBytes,
        },
        candidateContinuation: candidateContinuation ? {
          status: candidateContinuation.status,
          wallTimeMs: candidateContinuation.wallTimeMs,
          statementCount: candidateContinuation.statementCount,
          selectCount: candidateContinuation.selectCount,
          returnedItems: candidateContinuation.returnedItems,
          reusedCandidateCount: candidateContinuation.value?.candidateCount ?? null,
          payloadBytes: candidateContinuation.payloadBytes,
        } : null,
        candidateDeepPage10: candidateDeepPage ? {
          status: candidateDeepPage.status,
          wallTimeMs: candidateDeepPage.wallTimeMs,
          statementCount: candidateDeepPage.statementCount,
          selectCount: candidateDeepPage.selectCount,
          returnedItems: candidateDeepPage.returnedItems,
          reusedCandidateCount: candidateDeepPage.value?.candidateCount ?? null,
          payloadBytes: candidateDeepPage.payloadBytes,
        } : null,
        candidateCountSemantics: "candidateCount is the frozen all-epoch candidate-universe count; items, hasMore and nextCursor follow the requested live filter.",
        legacyWorkspaceComparison: legacyComparison,
        ledger: { status: ledger.status, wallTimeMs: ledger.wallTimeMs, statementCount: ledger.statementCount, selectCount: ledger.selectCount, returnedItems: ledger.returnedItems, payloadBytes: ledger.payloadBytes },
        targetBrowse: { status: target.status, wallTimeMs: target.wallTimeMs, statementCount: target.statementCount, selectCount: target.selectCount, returnedItems: target.returnedItems, payloadBytes: target.payloadBytes },
        targetSearch: { status: targetSearch.status, wallTimeMs: targetSearch.wallTimeMs, statementCount: targetSearch.statementCount, selectCount: targetSearch.selectCount, returnedItems: targetSearch.returnedItems, payloadBytes: targetSearch.payloadBytes },
        linkedEvidenceDensity: {
          pinnedMembersPerCandidate: { sparse: 1, moderate: 5, dense: 51 },
          directEvidencePerDenseCandidate: 54,
          connectingEvidence: {
            sparse: { status: connectingSparse.status, returnedItems: connectingSparse.returnedItems, statementCount: connectingSparse.statementCount, selectCount: connectingSparse.selectCount, payloadBytes: connectingSparse.payloadBytes },
            moderate: { status: connectingModerate.status, returnedItems: connectingModerate.returnedItems, statementCount: connectingModerate.statementCount, selectCount: connectingModerate.selectCount, payloadBytes: connectingModerate.payloadBytes },
            denseFirstPage: { status: connectingDenseFirst.status, returnedItems: connectingDenseFirst.returnedItems, hasMore: connectingDenseFirst.value?.hasMore, statementCount: connectingDenseFirst.statementCount, selectCount: connectingDenseFirst.selectCount, payloadBytes: connectingDenseFirst.payloadBytes },
            denseSecondPage: connectingDenseSecond ? { status: connectingDenseSecond.status, returnedItems: connectingDenseSecond.returnedItems, hasMore: connectingDenseSecond.value?.hasMore, statementCount: connectingDenseSecond.statementCount, selectCount: connectingDenseSecond.selectCount, payloadBytes: connectingDenseSecond.payloadBytes } : null,
            denseDeepPage3: connectingDenseThird ? { status: connectingDenseThird.status, returnedItems: connectingDenseThird.returnedItems, hasMore: connectingDenseThird.value?.hasMore, statementCount: connectingDenseThird.statementCount, selectCount: connectingDenseThird.selectCount, payloadBytes: connectingDenseThird.payloadBytes } : null,
          },
          directEvidence: {
            denseFirstPage: { status: directDenseFirst.status, returnedItems: directDenseFirst.returnedItems, hasMore: directDenseFirst.value?.hasMore, statementCount: directDenseFirst.statementCount, selectCount: directDenseFirst.selectCount, payloadBytes: directDenseFirst.payloadBytes },
            denseSecondPage: directDenseSecond ? { status: directDenseSecond.status, returnedItems: directDenseSecond.returnedItems, hasMore: directDenseSecond.value?.hasMore, statementCount: directDenseSecond.statementCount, selectCount: directDenseSecond.selectCount, payloadBytes: directDenseSecond.payloadBytes } : null,
            denseDeepPage3: directDenseThird ? { status: directDenseThird.status, returnedItems: directDenseThird.returnedItems, hasMore: directDenseThird.value?.hasMore, statementCount: directDenseThird.statementCount, selectCount: directDenseThird.selectCount, payloadBytes: directDenseThird.payloadBytes } : null,
          },
        },
        selectedFilter: {
          requestedSelectedCount: selectedCountSeeded,
          status: selectedCandidates.status,
          returnedItems: selectedCandidates.returnedItems,
          candidateCount: selectedCandidates.value.candidateCount,
          hasMore: selectedCandidates.value.hasMore,
          statementCount: selectedCandidates.statementCount,
          selectCount: selectedCandidates.selectCount,
          payloadBytes: selectedCandidates.payloadBytes,
        },
        selectionWrites: {
          note: "Counts are Drizzle service-level SQL statements; PostgreSQL trigger-internal SQL is not visible to this logger.",
          selectOne: { status: selectOne.status, wallTimeMs: selectOne.wallTimeMs, ...selectCounts },
          deselectOne: { status: deselectOne.status, wallTimeMs: deselectOne.wallTimeMs, ...deselectCounts },
          reachabilityQueryCaptured: Boolean(reachabilityQuery),
        },
        plans: [
          ...(candidatePlan10k ? [candidatePlan10k] : []),
          ...(size === 50_000 ? [
              await explain(client, "candidates.50000.first-page", candidateFirstQuery),
              await explain(client, "candidates.50000.continuation", candidateContinuation?.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "candidates.50000.page-10", candidateDeepPage?.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "selection.50000.reachability", highCardReachabilityQuery),
              await explain(client, "candidates.50000.selected-filter", selectedCandidates.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "evidence.50000.connecting-dense-page-1", connectingDenseFirst.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "evidence.50000.connecting-dense-page-3", connectingDenseThird?.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "evidence.50000.direct-dense-page-1", directDenseFirst.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "evidence.50000.direct-dense-page-3", directDenseThird?.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "ledger.50000", ledgerPageQuery),
              await explain(client, "target-browse.50000", target.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
              await explain(client, "target-search.50000", targetSearch.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()))),
            ] : []),
        ],
      };
      populationMeasurements.push(population);
      console.log(JSON.stringify({ populationScenario: {
        requestedCandidates: population.requestedCandidates,
        candidateFirstPage: population.candidateFirstPage,
        candidateContinuation: population.candidateContinuation,
        candidateDeepPage10: population.candidateDeepPage10,
        legacyWorkspaceComparison: population.legacyWorkspaceComparison,
        linkedEvidenceDensity: population.linkedEvidenceDensity,
        selectedFilter: population.selectedFilter,
        selectionWrites: population.selectionWrites,
        highCardinalityPlanCount: Array.isArray(population.plans) ? population.plans.length : 0,
      } }));
    }

    const aiHistoryMeasurements: Array<Record<string, unknown>> = [];
    const aiBeginMeasurements: Array<Record<string, unknown>> = [];
    let highCardHistoryQuery: CapturedQuery | undefined;
    let highCardAiSourceContextQuery: CapturedQuery | undefined;
    let highCardAiSupportContextQuery: CapturedQuery | undefined;
    const largest = scenarios.at(-1)!;
    if (AI_CONTEXT_ONLY_50K) {
      const scenario = largest;
      const selectedSupportIds = await client.unsafe(
        "select r.id from extraction_value_revisions r where r.project_id=$1::uuid and r.field_id=$2::uuid and r.finalized_at is not null and r.id not in ($3::uuid,$4::uuid,$5::uuid) order by r.id limit 20",
        [scenario.projectId, scenario.fieldId, scenario.denseCandidateId, scenario.moderateCandidateId, scenario.sparseCandidateId],
      ) as unknown as Array<{ id: string }>;
      assert(selectedSupportIds.length === 20, "Could not seed 20 same-Field candidate supports for the AI context-only run.");
      await client.unsafe(
        "insert into synthesis_preparation_selections (project_id,preparation_id,extraction_revision_id,created_at) select $1::uuid,$2::uuid,selected.id::uuid,now() from jsonb_array_elements_text($3::jsonb) selected(id)",
        [scenario.projectId, scenario.preparationId, JSON.stringify(selectedSupportIds.map(({ id }) => id))],
      );
    }
    for (const scenario of scenarios) {
      const selectedSupportCount = scenario.size >= 50_000 ? 20 : scenario.size >= 10_000 ? 10 : 1;
      const selectedSupportIds = await client.unsafe(
        "select extraction_revision_id as id from synthesis_preparation_selections where project_id=$1::uuid and preparation_id=$2::uuid and extraction_revision_id<>$3::uuid order by created_at,extraction_revision_id limit $4::integer",
        [scenario.projectId, scenario.preparationId, scenario.denseCandidateId, selectedSupportCount],
      ) as unknown as Array<{ id: string }>;
      assert(selectedSupportIds.length === selectedSupportCount, "AI selected-support context did not receive its planned support count at " + scenario.size + ".");
      await client.unsafe(
        "delete from synthesis_preparation_selections where project_id=$1::uuid and preparation_id=$2::uuid",
        [scenario.projectId, scenario.preparationId],
      );
      await client.unsafe(
        "insert into synthesis_preparation_selections (project_id,preparation_id,extraction_revision_id,created_at) select $1::uuid,$2::uuid,selected.id::uuid,now() from jsonb_array_elements_text($3::jsonb) selected(id)",
        [scenario.projectId, scenario.preparationId, JSON.stringify(selectedSupportIds.map(({ id }) => id))],
      );
      const aiBegin = await measure(sink, () => ai.beginAiSynthesisSuggestion({
        projectId: scenario.projectId,
        preparationId: scenario.preparationId,
        idempotencyKey: randomUUID(),
        externalTransmissionAcknowledged: true,
        disclosureVersion: "slice47-benchmark-no-dispatch",
      }));
      assert(aiBegin.status === "completed" && aiBegin.value, "AI begin selected-support context failed at " + scenario.size + ": " + aiBegin.error);
      const supportContextQuery = aiBegin.queries.find(({ query }) => /from synthesis_preparation_selections\s+s/i.test(query));
      const sourceContextQuery = aiBegin.queries.find(({ query }) => /connecting_sources as materialized/i.test(query));
      assert(supportContextQuery && sourceContextQuery, "AI begin did not expose selected-support and pinned-source context SELECTs at " + scenario.size + ".");
      const beginCounts = statementCounts(aiBegin.queries);
      const beginMeasurement = {
        requestedSelectedSupports: selectedSupportCount,
        status: aiBegin.status,
        wallTimeMs: aiBegin.wallTimeMs,
        ...beginCounts,
        payloadBytes: aiBegin.payloadBytes,
        supportContextQueryCaptured: Boolean(supportContextQuery),
        pinnedSourceContextQueryCaptured: Boolean(sourceContextQuery),
      };
      aiBeginMeasurements.push(beginMeasurement);
      console.log(JSON.stringify({ aiBeginScenario: beginMeasurement }));
      if (scenario.size === largest.size) {
        highCardAiSourceContextQuery = sourceContextQuery;
        highCardAiSupportContextQuery = supportContextQuery;
      }

      if (AI_CONTEXT_ONLY_50K) {
        const beginResult = aiBegin.value as Record<string, unknown>;
        const request = beginResult.request as Record<string, unknown>;
        const frozenSupports = await client.unsafe(
          "select support_ordinal,extraction_revision_id,paper_id,extraction_field_id,extraction_value_id,field_type,value_state,text_value,number_value,boolean_value,option_id,option_label_snapshot,researcher_note,paper_title_snapshot,paper_publication_year_snapshot from ai_synthesis_request_supports where project_id=$1::uuid and request_id=$2::uuid order by support_ordinal",
          [scenario.projectId, String(request.id)],
        ) as unknown as Array<Record<string, unknown>>;
        const frozenSources = await client.unsafe(
          "select source_ordinal,extraction_revision_id,evidence_id,paper_id,membership_id,membership_sort_order,page_number,source_text,evidence_review_state,evidence_note_snapshot,source_text_sha256 from ai_synthesis_request_sources where project_id=$1::uuid and request_id=$2::uuid order by membership_sort_order,page_number,evidence_id",
          [scenario.projectId, String(request.id)],
        ) as unknown as Array<Record<string, unknown>>;
        const supportManifest = frozenSupports.map((support, ordinal) => {
          const state = String(support.value_state);
          const fieldType = String(support.field_type);
          const canonicalValue = state !== "present"
            ? state
            : fieldType === "boolean" ? String(Boolean(support.boolean_value))
              : fieldType === "single_select" ? JSON.stringify({ optionId: support.option_id == null ? null : String(support.option_id), optionLabelSnapshot: support.option_label_snapshot == null ? null : String(support.option_label_snapshot) })
                : String(support.text_value ?? support.number_value ?? "");
          return {
            ordinal,
            extractionRevisionId: String(support.extraction_revision_id),
            paperId: String(support.paper_id),
            extractionFieldId: String(support.extraction_field_id),
            extractionValueId: String(support.extraction_value_id),
            fieldType,
            valueState: state,
            textValue: support.text_value == null ? null : String(support.text_value),
            numberValue: support.number_value == null ? null : Number(support.number_value),
            booleanValue: support.boolean_value == null ? null : Boolean(support.boolean_value),
            optionId: support.option_id == null ? null : String(support.option_id),
            optionLabelSnapshot: support.option_label_snapshot == null ? null : String(support.option_label_snapshot),
            researcherNote: support.researcher_note == null ? null : String(support.researcher_note),
            paperTitleSnapshot: String(support.paper_title_snapshot),
            paperPublicationYearSnapshot: support.paper_publication_year_snapshot == null ? null : Number(support.paper_publication_year_snapshot),
            valueCanonical: canonicalValue,
          };
        });
        const sourceManifest = frozenSources.map((source, ordinal) => {
          const sourceText = String(source.source_text);
          const computedTextHash = textHash(sourceText);
          assert(computedTextHash === String(source.source_text_sha256), "Frozen Evidence source text hash did not match its stored manifest at ordinal " + ordinal + ".");
          return {
            ordinal,
            sourceOrdinal: Number(source.source_ordinal),
            extractionRevisionId: String(source.extraction_revision_id),
            evidenceId: String(source.evidence_id),
            paperId: String(source.paper_id ?? ""),
            membershipId: String(source.membership_id),
            membershipSortOrder: Number(source.membership_sort_order),
            pageNumber: Number(source.page_number),
            sourceTextHash: computedTextHash,
            sourceText,
            evidenceReviewState: String(source.evidence_review_state),
            evidenceNoteSnapshot: source.evidence_note_snapshot == null ? null : String(source.evidence_note_snapshot),
          };
        });
        const sourceManifestHash = hashCanonical(sourceManifest);
        const sourceStateHash = hashCanonical({
          preparationId: String(request.preparationId),
          pinnedCompositionRevisionId: String(request.evidenceSetCompositionRevisionId),
          field: {
            id: String(request.extractionFieldId),
            name: String(request.fieldName),
            description: request.fieldDescription == null ? null : String(request.fieldDescription),
            type: String(request.fieldType),
          },
          targetStatementId: request.targetSynthesisStatementId == null ? null : String(request.targetSynthesisStatementId),
          targetBaselineRevisionId: request.targetBaselineRevisionId == null ? null : String(request.targetBaselineRevisionId),
          supports: supportManifest,
          sources: sourceManifest,
        });
        const hashParity = {
          supportCount: Number(request.supportCount) === selectedSupportCount && frozenSupports.length === selectedSupportCount,
          sourceCount: Number(request.sourceCount) === frozenSources.length,
          eachSourceTextHash: frozenSources.length === sourceManifest.length,
          sourceManifestHash: sourceManifestHash === String(request.sourceManifestHash),
          sourceStateHash: sourceStateHash === String(request.sourceStateHash),
        };
        assert(Object.values(hashParity).every(Boolean), "AI request manifest/hash parity failed for the 20-support 50k context run: " + JSON.stringify(hashParity));
        const supportPlan = await explain(client, "ai-begin.50000.selected-support-context.20-supports", supportContextQuery);
        const sourcePlan = await explain(client, "ai-begin.50000.pinned-source-context.20-supports", sourceContextQuery);
        const contextEvidence = {
          populationSize: 50_000,
          selectedSupports: selectedSupportCount,
          generatedAt: new Date().toISOString(),
          nodeVersion: process.version,
          postgresServerVersion,
          postgresServerVersionNum,
          beginMeasurement,
          manifest: {
            requestId: String(request.id),
            supportRows: frozenSupports.length,
            sourceRows: frozenSources.length,
            sourceCoverageState: request.sourceCoverageState,
            sourceManifestHash: request.sourceManifestHash,
            recomputedSourceManifestHash: sourceManifestHash,
            sourceStateHash: request.sourceStateHash,
            recomputedSourceStateHash: sourceStateHash,
            hashParity,
          },
          selectedSupportContextPlan: supportPlan,
          pinnedSourceContextPlan: sourcePlan,
        };
        const diagnosticPath = resolve(process.cwd(), "work/slice47-ai-context-50k.json");
        mkdirSync(dirname(diagnosticPath), { recursive: true });
        writeFileSync(diagnosticPath, JSON.stringify(contextEvidence, null, 2) + "\n", "utf8");
        const evidencePath = resolve(process.cwd(), "docs/benchmarks/slice47-synthesis-preparation-read-paths.json");
        const previous = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
        const historicalRows = (Array.isArray(previous.aiBeginSelectedSupportContext) ? previous.aiBeginSelectedSupportContext : [])
          .map((row) => {
            const value = row as Record<string, unknown>;
            return value.requestedSelectedSupports === 1
              ? { ...value, requestedCandidates: 50_000, harnessDeviation: "The first full 50k run used the first element of a one-size population list, so it measured one AI support; the corrected 20-support context run is recorded separately." }
              : value.requestedSelectedSupports === 10 ? { ...value, requestedCandidates: 10_000 } : value;
          });
        const correctedRow = { ...beginMeasurement, requestedCandidates: 50_000, requestedSelectedSupports: selectedSupportCount };
        const updatedReport = {
          ...previous,
          aiBeginSelectedSupportContext: [...historicalRows, correctedRow],
          aiBeginSelectedSupportPlans: contextEvidence,
        };
        writeFileSync(evidencePath, JSON.stringify(updatedReport, null, 2) + "\n", "utf8");
        console.log(JSON.stringify({ aiContextOnly50k: {
          diagnosticPath,
          evidencePath,
          selectedSupports: selectedSupportCount,
          sourceRows: frozenSources.length,
          wallTimeMs: beginMeasurement.wallTimeMs,
          hashParity,
          selectedSupportPlan: briefPlan(supportPlan),
          pinnedSourcePlan: briefPlan(sourcePlan),
        } }));
        return;
      }

      // The one real begin request plus N-1 compact synthetic history rows
      // gives the exact requested 1k/10k/50k history population.
      await setStatementTimeout(client, SEED_STATEMENT_TIMEOUT_MS);
      await seedAiHistory(client, scenario, scenario.size - 1);
      await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
      const history = await measure(sink, () => ai.listAiSynthesisSuggestionHistoryPage(scenario.projectId, scenario.preparationId, { pageSize: AI_HISTORY_PAGE_SIZE }));
      assert(history.status === "completed" && history.value, "AI history page failed at " + scenario.size + ": " + history.error);
      assert(history.selectCount === 1 && history.value.items.length <= AI_HISTORY_PAGE_SIZE, "AI history page exceeded its one-SELECT/row-bound contract at " + scenario.size + ".");
      if (scenario.size === largest.size) highCardHistoryQuery = history.queries.find(({ query }) => /^(with|select)\b/i.test(query.trim()));
      const historyMeasurement = {
        requestedRequests: scenario.size,
        status: history.status,
        wallTimeMs: history.wallTimeMs,
        statementCount: history.statementCount,
        selectCount: history.selectCount,
        returnedItems: history.returnedItems,
        payloadBytes: history.payloadBytes,
      };
      aiHistoryMeasurements.push(historyMeasurement);
      console.log(JSON.stringify({ aiHistoryScenario: historyMeasurement }));
    }

    await setStatementTimeout(client, SEED_STATEMENT_TIMEOUT_MS);
    const historyPlanBefore = await explain(client, "ai-history." + largest.size + ".before-0036-index", highCardHistoryQuery);
    await client.unsafe(proposedIndexDdl);
    await client.unsafe("analyze ai_synthesis_requests");
    const historyPlanAfter = await explain(client, "ai-history." + largest.size + ".after-simulated-0036-index", highCardHistoryQuery);
    const aiSourceContextPlan = await explain(client, "ai-begin." + largest.size + ".pinned-source-context", highCardAiSourceContextQuery);
    const aiSupportContextPlan = await explain(client, "ai-begin." + largest.size + ".selected-support-context", highCardAiSupportContextQuery);
    await setStatementTimeout(client, STATEMENT_TIMEOUT_MS);
    const historyAfter = await measure(sink, () => ai.listAiSynthesisSuggestionHistoryPage(largest.projectId, largest.preparationId, { pageSize: AI_HISTORY_PAGE_SIZE }));
    const historyAccessBefore = requestHistoryAccess(historyPlanBefore);
    const historyAccessAfter = requestHistoryAccess(historyPlanAfter);
    const indexServesBoundedPage = historyAccessAfter.requestIndex === proposedIndexName
      && historyAccessAfter.requestRowsVisitedOrReturned !== null
      && historyAccessAfter.requestRowsVisitedOrReturned <= AI_HISTORY_PAGE_SIZE + 1;
    const indexComparison = {
      proposedIndexDdl,
      beforePage: historyPlanBefore,
      afterPage: historyPlanAfter,
      aiBeginContextPlans: { pinnedSourceContext: aiSourceContextPlan, selectedSupportContext: aiSupportContextPlan },
      recommendation: {
        migration: "0036",
        decision: indexServesBoundedPage ? "add the proposed composite history index" : "defer the proposed composite history index",
        rationale: indexServesBoundedPage
          ? "On PostgreSQL 16 at 50,000 generated requests, the exact history query uses the proposed ordered index to produce only the page plus one row. The index was simulated only in the disposable benchmark database."
          : "On PostgreSQL 16 at 50,000 generated requests, the exact history query did not use the proposed index for a bounded request-page scan. This evidence does not support adding the migration.",
        before: historyAccessBefore,
        after: historyAccessAfter,
      },
      afterIndexRead: {
        status: historyAfter.status,
        wallTimeMs: historyAfter.wallTimeMs,
        statementCount: historyAfter.statementCount,
        selectCount: historyAfter.selectCount,
        returnedItems: historyAfter.returnedItems,
        payloadBytes: historyAfter.payloadBytes,
      },
    };
    console.log(JSON.stringify({ aiHistoryIndexComparison: {
      proposedIndexDdl: indexComparison.proposedIndexDdl,
      recommendation: indexComparison.recommendation,
      beforePage: briefPlan(historyPlanBefore),
      afterPage: briefPlan(historyPlanAfter),
      aiBeginContextPlans: {
        pinnedSourceContext: briefPlan(aiSourceContextPlan),
        selectedSupportContext: briefPlan(aiSupportContextPlan),
      },
      afterIndexRead: indexComparison.afterIndexRead,
    } }));
    const report = {
      benchmark: "Slice 47 bounded SynthesisPreparation reads",
      postgresMajor: 16,
      nodeVersion: process.version,
      postgresServerVersion,
      postgresServerVersionNum,
      generatedAt: new Date().toISOString(),
      populationSizes: POPULATION_SIZES,
      full50kRunEnabled: POPULATION_SIZES.includes(50_000),
      populations: populationMeasurements,
      aiHistory: aiHistoryMeasurements,
      aiBeginSelectedSupportContext: aiBeginMeasurements,
      aiHistoryIndexComparison: indexComparison,
    };
    const evidencePath = resolve(process.cwd(), "docs/benchmarks/slice47-synthesis-preparation-read-paths.json");
    mkdirSync(dirname(evidencePath), { recursive: true });
    let reportToWrite = report;
    if (existsSync(evidencePath)) {
      const previous = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
      if (previous.aiBeginSelectedSupportPlans) {
        reportToWrite = { ...report, aiBeginSelectedSupportPlans: previous.aiBeginSelectedSupportPlans };
      }
    }
    if (BENCHMARK_ONLY_50K) {
      const previous = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
      const mergePopulationRows = (key: "populations" | "aiHistory" | "aiBeginSelectedSupportContext", idKey: string) => {
        const priorRows = Array.isArray(previous[key]) ? previous[key] as Array<Record<string, unknown>> : [];
        const currentRows = report[key] as Array<Record<string, unknown>>;
        const currentIds = new Set(currentRows.map((row) => Number(row[idKey])));
        return [...priorRows.filter((row) => !currentIds.has(Number(row[idKey]))), ...currentRows]
          .sort((left, right) => Number(left[idKey]) - Number(right[idKey]));
      };
      const priorIndexComparisons = Array.isArray(previous.aiHistoryIndexComparisons)
        ? previous.aiHistoryIndexComparisons as Array<Record<string, unknown>>
        : previous.aiHistoryIndexComparison
          ? [{
            populationSize: Number(String((previous.aiHistoryIndexComparison as Record<string, unknown>).beforePage
              && ((previous.aiHistoryIndexComparison as Record<string, unknown>).beforePage as Record<string, unknown>).label)
              .match(/ai-history\.(\d+)\./)?.[1] ?? 0),
            comparison: previous.aiHistoryIndexComparison,
          }]
          : [];
      const indexComparisons = [
        ...priorIndexComparisons.filter(({ populationSize }) => Number(populationSize) !== 50_000),
        { populationSize: 50_000, comparison: report.aiHistoryIndexComparison },
      ];
      reportToWrite = {
        ...previous,
        ...report,
        populationSizes: [...new Set([
          ...(Array.isArray(previous.populationSizes) ? previous.populationSizes.map(Number) : []),
          ...POPULATION_SIZES,
        ])].sort((left, right) => left - right),
        populations: mergePopulationRows("populations", "requestedCandidates"),
        aiHistory: mergePopulationRows("aiHistory", "requestedRequests"),
        aiBeginSelectedSupportContext: mergePopulationRows("aiBeginSelectedSupportContext", "requestedSelectedSupports"),
        aiHistoryIndexComparisons: indexComparisons,
      };
    }
    writeFileSync(evidencePath, JSON.stringify(reportToWrite, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ benchmarkEvidencePath: evidencePath }));
    console.log(JSON.stringify({ benchmarkSummary: {
      populations: populationMeasurements.map((population) => ({
        size: population.requestedCandidates,
        candidatePage: population.candidateFirstPage,
        deepPage10: population.candidateDeepPage10,
        legacyWorkspace: population.legacyWorkspaceComparison,
        selectedFilter: population.selectedFilter,
        selectOne: (population.selectionWrites as Record<string, unknown>).selectOne,
        deselectOne: (population.selectionWrites as Record<string, unknown>).deselectOne,
      })),
      aiHistory: aiHistoryMeasurements,
      aiHistoryPlans: { before: briefPlan(historyPlanBefore), after: briefPlan(historyPlanAfter) },
    } }));
  } finally {
    await client?.end({ timeout: 1 });
    try {
      if (created) {
        await admin.unsafe("drop database if exists " + quoteIdentifier(databaseName) + " with (force)");
        console.log(JSON.stringify({ phase: "cleanup-complete", droppedOwnBenchmarkDatabase: true }));
      }
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
}

main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
