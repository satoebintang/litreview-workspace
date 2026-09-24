import "dotenv/config";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createClaimSupportReadServices } from "@/application/claim-support-read-services";
import { createFullTextQueueReadServices } from "@/application/full-text-queue-read-services";
import { createReviewServices } from "@/application/services";
import { fullTextScreeningCriteria, fullTextScreeningDecisions, schema, screeningCriteria, screeningDecisions } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";
import { createDb, type Database } from "@/db/client";
import { SynthesisRevisionRepository } from "@/application/repositories/synthesis";
import { FullTextScreeningDecisionRepository, ScreeningDecisionRepository } from "@/application/repositories/screening";
import type { PaperReviewStatus } from "@/domain/types";

const SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_STATEMENT_TIMEOUT_MS = 600_000;
const LOCK_TIMEOUT_MS = 5_000;
const JOINED_HISTORY_ROWS = 500;

type CapturedQuery = { query: string; params: unknown[] };
type Measurement<T> = {
  value: T | null;
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  statementCount: number;
  queries: CapturedQuery[];
  error?: string;
};

let queryCapture: CapturedQuery[] | null = null;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value.code ?? value.cause?.code;
}

function sanitizedError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } }
    : null;
  const causeMessage = typeof record?.cause?.message === "string" ? record.cause.message : null;
  const message = causeMessage
    ? `${typeof record?.name === "string" ? record.name : "Error"}: ${causeMessage}${record?.cause?.code ? ` (SQLSTATE ${String(record.cause.code)})` : ""}`
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = message.replace(/postgres(?:ql)?:\/\S+/gi, "[redacted database URL]");
  return redacted.length > 1_000 ? `${redacted.slice(0, 1_000)}… [truncated ${redacted.length - 1_000} characters]` : redacted;
}

function isTimeout(error: unknown) {
  return errorCode(error) === "57014" || /statement timeout|canceling statement/i.test(sanitizedError(error));
}

function instrumentSeedQueries(client: postgres.Sql) {
  const stageCounts = new Map<string, number>();
  return new Proxy(client, {
    get(target, property) {
      if (property !== "unsafe") return Reflect.get(target, property, target);
      return async (query: string, params?: unknown[]) => {
        const operation = query.trim().match(/^(insert\s+into|update|analyze)\s+([a-z_]+)/i);
        const baseStage = operation ? `${operation[1].toLowerCase().replace(/\s+/g, "-")}:${operation[2]}` : "other";
        const stageNumber = (stageCounts.get(baseStage) ?? 0) + 1;
        stageCounts.set(baseStage, stageNumber);
        const stage = `${baseStage}#${stageNumber}`;
        const started = process.hrtime.bigint();
        console.log(JSON.stringify({ phase: "seed-stage-start", stage }));
        try {
          const result = await target.unsafe(query, params as never);
          console.log(JSON.stringify({
            phase: "seed-stage-complete",
            stage,
            wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
          }));
          return result;
        } catch (error) {
          console.log(JSON.stringify({
            phase: "seed-stage-failed",
            stage,
            wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
            status: isTimeout(error) ? "timed_out" : "failed",
            error: sanitizedError(error),
          }));
          throw error;
        }
      };
    },
  });
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function readQueries(measurement: Measurement<unknown>) {
  return measurement.queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function transactionSetupStatementCount(measurement: Measurement<unknown>) {
  return measurement.queries.filter(({ query }) => /^set\s+transaction\b/i.test(query.trim())).length;
}

async function measured<T>(run: () => Promise<T>): Promise<Measurement<T>> {
  if (queryCapture) throw new Error("Benchmark query capture cannot be nested");
  const queries: CapturedQuery[] = [];
  const started = process.hrtime.bigint();
  queryCapture = queries;
  try {
    const value = await run();
    return {
      value,
      status: "completed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      queries,
    };
  } catch (error) {
    return {
      value: null,
      status: isTimeout(error) ? "timed_out" : "failed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      queries,
      error: sanitizedError(error),
    };
  } finally {
    queryCapture = null;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function paperId(projectId: string, ordinal: number) {
  return stableId(projectId, `paper:${ordinal}`);
}

function stableId(projectId: string, label: string) {
  const value = createHash("md5").update(`${projectId}:${label}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function seedScenario(client: postgres.Sql, projectId: string, paperCount: number) {
  client = instrumentSeedQueries(client);
  const taCriterionId = stableId(projectId, "ta-exclusion");
  const ftCriterionId = stableId(projectId, "ft-exclusion");
  const fieldOneId = stableId(projectId, "field:1");
  const fieldTwoId = stableId(projectId, "field:2");

  await client.unsafe(
    `insert into screening_criteria (id, project_id, type, text, archived_at)
     values ($2::uuid, $1::uuid, 'exclusion', 'Benchmark exclusion criterion', null)`,
    [projectId, taCriterionId],
  );
  await client.unsafe(
    `insert into full_text_screening_criteria (id, project_id, text, archived_at)
     values ($2::uuid, $1::uuid, 'Benchmark full-text exclusion criterion', null)`,
    [projectId, ftCriterionId],
  );
  await client.unsafe(
    `insert into extraction_fields (id, project_id, name, description, field_type, required, sort_order)
     values ($2::uuid, $1::uuid, 'Study design', 'Synthetic benchmark field', 'short_text', false, 1),
            ($3::uuid, $1::uuid, 'Outcome', 'Synthetic benchmark field', 'short_text', false, 2)`,
    [projectId, fieldOneId, fieldTwoId],
  );

  await client.unsafe(
    `insert into papers (id, project_id, title, authors, publication_year, venue, abstract, created_at, updated_at)
     select md5($1::text || ':paper:' || g.n::text)::uuid,
       $1::uuid, 'Benchmark paper ' || g.n::text, array['Benchmark et al.'], 2024,
       'Read-path benchmark', 'Synthetic abstract with bounded benchmark content',
       timestamptz '2025-01-01 00:00:00+00' + g.n * interval '1 second',
       timestamptz '2025-01-01 00:00:00+00' + g.n * interval '1 second'
     from generate_series(1, $2::integer) as g(n)`,
    [projectId, paperCount],
  );

  await client.unsafe(
    `insert into screening_decisions (project_id, paper_id, stage, decision, exclusion_criterion_id, exclusion_criterion_type, note)
     select $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid, 'title_abstract', 'include', null, null, null
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 10) <> 9`,
    [projectId, paperCount],
  );

  await client.unsafe(
    `insert into full_text_retrieval_attempts (project_id, paper_id, outcome, method, attempted_at)
     select $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid, 'retrieved',
       'manual', timestamptz '2025-06-01 00:00:00+00' + g.n * interval '1 second'
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 10) not in (5, 9)`,
    [projectId, paperCount],
  );

  await client.unsafe(
    `insert into full_text_screening_decisions (project_id, paper_id, decision, exclusion_criterion_id, note)
     select $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid,
       case when mod(g.n, 10) in (1, 6) then 'include'
            when mod(g.n, 10) in (2, 7) then 'exclude' else 'maybe' end,
       case when mod(g.n, 10) in (2, 7) then $3::uuid else null end,
       null
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 10) in (1, 2, 3, 6, 7, 8)`,
    [projectId, paperCount, ftCriterionId],
  );

  await client.unsafe(
    `insert into full_text_retrieval_attempts (project_id, paper_id, outcome, method, attempted_at)
     select $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid,
       case when mod(g.n, 10) in (2, 7) then 'unavailable' else 'pending' end,
       'manual', timestamptz '2025-07-01 00:00:00+00' + g.n * interval '1 second'
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 10) in (2, 3, 6, 7, 8)`,
    [projectId, paperCount],
  );

  await client.unsafe(
    `insert into screening_decisions (project_id, paper_id, stage, decision, exclusion_criterion_id, exclusion_criterion_type, note)
     select $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid, 'title_abstract',
       case when mod(g.n, 10) in (6, 7) then 'exclude' else 'maybe' end,
       case when mod(g.n, 10) in (6, 7) then $3::uuid else null end,
       case when mod(g.n, 10) in (6, 7) then 'exclusion' else null end,
       null
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 10) in (6, 7, 8)`,
    [projectId, paperCount, taCriterionId],
  );

  await client.unsafe(
    `insert into evidence (id, project_id, paper_id, source_text, page_number, note)
     select md5($1::text || ':evidence:' || g.n::text)::uuid, $1::uuid,
       md5($1::text || ':paper:' || g.n::text)::uuid,
       'Synthetic source passage for benchmark paper ' || g.n::text, 1, null
     from generate_series(1, $2::integer) as g(n)`,
    [projectId, paperCount],
  );
  await client.unsafe(
    `insert into evidence_review_decisions (project_id, evidence_id, decision, note)
     select $1::uuid, md5($1::text || ':evidence:' || g.n::text)::uuid,
       case mod(g.n, 4) when 1 then 'accepted' else 'needs_review' end,
       null
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 4) in (1, 2)`,
    [projectId, paperCount],
  );

  await client.unsafe(
    `insert into extraction_values (id, project_id, paper_id, field_id)
     select md5($1::text || ':extraction-value:' || g.n::text || ':' || f.field_no::text)::uuid,
       $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid,
       case f.field_no when 1 then $3::uuid else $4::uuid end
     from generate_series(1, $2::integer) as g(n)
     cross join (values (1), (2)) as f(field_no)`,
    [projectId, paperCount, fieldOneId, fieldTwoId],
  );
  await client.unsafe(
    `insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id,
       field_type, value_state, text_value, finalized_at)
     select md5($1::text || ':extraction-revision:' || g.n::text || ':' || f.field_no::text)::uuid,
       $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid,
       case f.field_no when 1 then $3::uuid else $4::uuid end,
       md5($1::text || ':extraction-value:' || g.n::text || ':' || f.field_no::text)::uuid,
       'short_text', 'present', 'Observed benchmark value ' || g.n::text,
       null
     from generate_series(1, $2::integer) as g(n)
     cross join (values (1), (2)) as f(field_no)`,
    [projectId, paperCount, fieldOneId, fieldTwoId],
  );
  await client.unsafe(
    `insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id)
     select $1::uuid, md5($1::text || ':paper:' || g.n::text)::uuid,
       md5($1::text || ':extraction-revision:' || g.n::text || ':' || f.field_no::text)::uuid,
       md5($1::text || ':evidence:' || g.n::text)::uuid
     from generate_series(1, $2::integer) as g(n)
     cross join (values (1), (2)) as f(field_no)`,
    [projectId, paperCount],
  );
  await client.unsafe(
    `insert into evidence_review_decisions (project_id, evidence_id, decision, note)
     select $1::uuid, md5($1::text || ':evidence:' || g.n::text)::uuid, 'rejected', null
     from generate_series(1, $2::integer) as g(n)
     where mod(g.n, 4) = 3`,
    [projectId, paperCount],
  );
  await client.unsafe(
    `update extraction_value_revisions
     set finalized_at = timestamptz '2025-07-01 00:00:00+00'
     where project_id = $1::uuid`,
    [projectId],
  );

  await client.unsafe(
    `insert into synthesis_statements (id, project_id)
     select md5($1::text || ':synthesis-statement:' || g.n::text)::uuid, $1::uuid
     from generate_series(1, $2::integer) as g(n)`,
    [projectId, paperCount],
  );
  await client.unsafe(
    `insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text, finalized_at)
     select md5($1::text || ':synthesis-revision:' || g.n::text)::uuid, $1::uuid,
       md5($1::text || ':synthesis-statement:' || g.n::text)::uuid,
       case when mod(g.n, 10) = 0 then 'withdrawn' else 'active' end,
       case when mod(g.n, 10) = 0 then null else 'Active synthesis ' || g.n::text end,
       case when mod(g.n, 10) = 0 then null else 'A bounded synthetic synthesis statement for paper ' || g.n::text end,
       null
     from generate_series(1, $2::integer) as g(n)`,
    [projectId, paperCount],
  );
  await client.unsafe(
    `insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id)
     select $1::uuid,
       md5($1::text || ':synthesis-revision:' || g.n::text)::uuid,
       md5($1::text || ':extraction-revision:' || g.n::text || ':' || f.field_no::text)::uuid
     from generate_series(1, $2::integer) as g(n)
     cross join (values (1), (2)) as f(field_no)
     where mod(g.n, 10) <> 0`,
    [projectId, paperCount],
  );
  await client.unsafe(
    `update synthesis_revisions
     set finalized_at = timestamptz '2025-08-01 00:00:00+00'
     where project_id = $1::uuid`,
    [projectId],
  );

  // A deliberately high-history Paper makes the old criterion lookup N+1
  // measurable while leaving the final current decision included.
  await client.unsafe(
    `insert into screening_decisions (project_id, paper_id, stage, decision, exclusion_criterion_id, exclusion_criterion_type, note)
     select $1::uuid, md5($1::text || ':paper:1')::uuid, 'title_abstract', 'exclude', $3::uuid, 'exclusion', null
     from generate_series(1, $2::integer)`,
    [projectId, JOINED_HISTORY_ROWS, taCriterionId],
  );
  await client.unsafe(
    `insert into screening_decisions (project_id, paper_id, stage, decision, exclusion_criterion_id, exclusion_criterion_type, note)
     values ($1::uuid, md5($1::text || ':paper:1')::uuid, 'title_abstract', 'include', null, null, null)`,
    [projectId],
  );
  await client.unsafe(
    `insert into full_text_screening_decisions (project_id, paper_id, decision, exclusion_criterion_id, note)
     select $1::uuid, md5($1::text || ':paper:1')::uuid, 'exclude', $3::uuid, null
     from generate_series(1, $2::integer)`,
    [projectId, JOINED_HISTORY_ROWS, ftCriterionId],
  );
  await client.unsafe(
    `insert into full_text_screening_decisions (project_id, paper_id, decision, exclusion_criterion_id, note)
     values ($1::uuid, md5($1::text || ':paper:1')::uuid, 'include', null, null)`,
    [projectId],
  );
  await client.unsafe(`update screening_criteria set archived_at = now() where id = $1::uuid`, [taCriterionId]);
  await client.unsafe(`update full_text_screening_criteria set archived_at = now() where id = $1::uuid`, [ftCriterionId]);

  await client.unsafe(`analyze papers`);
  await client.unsafe(`analyze screening_decisions`);
  await client.unsafe(`analyze full_text_screening_decisions`);
  await client.unsafe(`analyze full_text_retrieval_attempts`);
  await client.unsafe(`analyze evidence`);
  await client.unsafe(`analyze evidence_review_decisions`);
  await client.unsafe(`analyze extraction_value_revisions`);
  await client.unsafe(`analyze extraction_revision_evidence`);
  await client.unsafe(`analyze synthesis_revisions`);
  await client.unsafe(`analyze synthesis_revision_supports`);

  return {
    paperCount,
    evidenceCount: paperCount,
    extractionRevisionCount: paperCount * 2,
    synthesisRevisionCount: paperCount,
    synthesisSupportPathCount: Math.floor(paperCount * 0.9) * 2,
    historyRowsPerStage: JOINED_HISTORY_ROWS + 2,
    targetPaperId: paperId(projectId, 1),
    targetSynthesisStatementId: stableId(projectId, "synthesis-statement:1"),
    targetSynthesisRevisionId: stableId(projectId, "synthesis-revision:1"),
  };
}

function expectedScreeningCounts(rows: Array<{ reviewStatus: PaperReviewStatus }>) {
  const counts: Record<string, number> = {
    ready: 0, awaiting: 0, included: 0, excluded: 0, maybe: 0, legacy: 0, conflict: 0,
  };
  for (const { reviewStatus: status } of rows) {
    const taIncluded = status.titleAbstractState === "included";
    const ftState = status.fullTextState;
    const retrievalConflict = (status.warnings as string[]).includes("retrieval_history_without_current_title_abstract_inclusion");
    const legacy = (status.warnings as string[]).includes("legacy_full_text_decision_without_retrieval_record");
    if (taIncluded && status.fullTextRetrievalState === "retrieved" && ftState === "not_started") counts.ready += 1;
    if (taIncluded && ftState === "not_started") counts.awaiting += 1;
    if (taIncluded && ftState === "included") counts.included += 1;
    if (taIncluded && ftState === "excluded") counts.excluded += 1;
    if (taIncluded && ftState === "maybe") counts.maybe += 1;
    if ((taIncluded || status.crossStageConflict || retrievalConflict) && legacy) counts.legacy += 1;
    if (status.crossStageConflict || retrievalConflict) counts.conflict += 1;
  }
  return counts;
}

function equalCounts(actual: Record<string, number>, expected: Record<string, number>, label: string) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert(actual[key] === expectedValue, `${label} count mismatch for ${key}: actual=${actual[key]}, expected=${expectedValue}`);
  }
}

function parseExplainPlan(value: unknown) {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

function requestedSizes(): number[] {
  const raw = process.env.READ_PATHS_BENCHMARK_SIZES?.trim();
  if (!raw) return [...SIZES];
  const sizes = raw.split(",").map((value) => Number(value.trim()));
  if (sizes.length === 0 || sizes.some((size) => !SIZES.includes(size as typeof SIZES[number]))) {
    throw new Error(`READ_PATHS_BENCHMARK_SIZES must be a comma-separated subset of ${SIZES.join(", ")}.`);
  }
  return [...new Set(sizes)];
}

async function explain(client: postgres.Sql, label: string, captured: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(
      `explain (analyze, buffers, format json) ${captured.query}`,
      captured.params as never,
    ) as unknown as Array<Record<string, unknown>>;
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    return {
      label,
      status: "completed" as const,
      wallTimeMs,
      sqlBytes: Buffer.byteLength(captured.query),
      plan: parseExplainPlan(rows[0]?.["QUERY PLAN"]),
    };
  } catch (error) {
    return {
      label,
      status: isTimeout(error) ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(captured.query),
      error: sanitizedError(error),
      plan: null,
    };
  }
}

function pageMeasurement<T extends { items: unknown[]; totalCount: number }>(measurement: Measurement<T>) {
  const selects = readQueries(measurement);
  if (!measurement.value) return {
    status: measurement.status,
    wallTimeMs: measurement.wallTimeMs,
    statementCount: selects.length,
    transactionSetupStatementCount: transactionSetupStatementCount(measurement),
    loggedStatementCount: measurement.statementCount,
    error: measurement.error,
  };
  return {
    status: measurement.status,
    wallTimeMs: measurement.wallTimeMs,
    statementCount: selects.length,
    transactionSetupStatementCount: transactionSetupStatementCount(measurement),
    loggedStatementCount: measurement.statementCount,
    totalCount: measurement.value.totalCount,
    selectedRowCount: measurement.value.items.length,
    payloadBytes: jsonBytes(measurement.value),
  };
}

function fullResultMeasurement<T>(measurement: Measurement<T>, selectedRowCount: number, payload: unknown = measurement.value) {
  const selects = readQueries(measurement);
  return {
    status: measurement.status,
    wallTimeMs: measurement.wallTimeMs,
    statementCount: selects.length,
    loggedStatementCount: measurement.statementCount,
    selectedRowCount: measurement.value === null ? null : selectedRowCount,
    payloadBytes: measurement.value === null ? null : jsonBytes(payload),
    error: measurement.error,
  };
}

async function benchmarkScenario(args: {
  client: postgres.Sql;
  db: Database;
  services: ReturnType<typeof createReviewServices>;
  size: number;
}) {
  const { client, db, services, size } = args;
  console.log(JSON.stringify({ phase: "scenario-start", size }));
  const project = await services.createProject({ title: `Slice 36 read-path benchmark ${size}` });
  const seeded = await seedScenario(client, project.id, size);
  await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
  console.log(JSON.stringify({ phase: "seed-complete", size }));
  const queueRead = createFullTextQueueReadServices(db);
  const claimRead = createClaimSupportReadServices(db);

  const oldRetrieval = await measured(() => services.listFullTextRetrievalQueue(project.id));
  const oldRetrievalConflict = await measured(() => services.listFullTextRetrievalQueue(project.id, "conflict"));
  const newRetrievalAll = await measured(() => queueRead.listFullTextRetrievalQueuePage(project.id, { state: "all", page: 1, pageSize: PAGE_SIZE }));
  const newRetrievalConflict = await measured(() => queueRead.listFullTextRetrievalQueuePage(project.id, { state: "conflict", page: 1, pageSize: PAGE_SIZE }));
  assert(newRetrievalAll.value && newRetrievalConflict.value, "Bounded retrieval queue measurements must complete");
  const retrievalEquivalenceChecked = Boolean(oldRetrieval.value && oldRetrievalConflict.value);
  if (oldRetrieval.value && oldRetrievalConflict.value) {
    assert(newRetrievalAll.value.totalCount === oldRetrieval.value.length + oldRetrievalConflict.value.length,
      `Retrieval all must equal included operational queue plus conflicts at ${size}`);
    assert(newRetrievalConflict.value.totalCount === oldRetrievalConflict.value.length,
      `Retrieval conflict count must retain history-conflict membership at ${size}`);
  }

  const oldFullText = await measured(() => services.listFullTextScreeningQueue(project.id));
  const newFullText = await measured(() => queueRead.listFullTextScreeningQueuePage(project.id, { state: "all", page: 1, pageSize: PAGE_SIZE }));
  assert(newFullText.value, "Bounded full-text queue measurement must complete");
  const oldFullTextIds = oldFullText.value ? new Set(oldFullText.value.map((row) => row.paper.id)) : null;
  const newFullTextExpected = oldFullText.value ? expectedScreeningCounts(oldFullText.value) : null;
  if (newFullTextExpected) {
    equalCounts(newFullText.value.counts, newFullTextExpected, `Full-text queue at ${size}`);
    assert(newFullText.value.totalCount === oldFullTextIds?.size, `Full-text all membership count must remain unchanged at ${size}`);
  }

  const oldClaim = await measured(() => services.listClaimSupportOptions(project.id));
  const claimKinds = ["evidence", "extractionRevision", "synthesisRevision"] as const;
  const oldClaimCounts = oldClaim.value ? {
    evidence: oldClaim.value.evidence.length,
    extractionRevision: oldClaim.value.extraction.length,
    synthesisRevision: oldClaim.value.synthesis.length,
  } : null;
  console.log(JSON.stringify({ phase: "legacy-claim-complete", size, status: oldClaim.status, wallTimeMs: oldClaim.wallTimeMs, statementCount: oldClaim.statementCount }));
  const claimPages = {} as Record<string, { result: Measurement<Awaited<ReturnType<typeof claimRead.searchClaimSupportOptions>>>; expectedTotal: number }>;
  for (const kind of claimKinds) {
    const result = await measured(() => claimRead.searchClaimSupportOptions({ projectId: project.id, kind, page: 1, pageSize: PAGE_SIZE }));
    assert(result.value, `Claim search ${kind} failed at ${size}: ${result.error ?? result.status}`);
    const expectedTotal = oldClaimCounts?.[kind] ?? result.value.totalCount;
    if (oldClaimCounts) assert(result.value.totalCount === expectedTotal,
      `Claim ${kind} search count differs from released picker semantics at ${size}: actual=${result.value.totalCount}, expected=${expectedTotal}`);
    assert(readQueries(result).length === 2, `Claim ${kind} search must issue count + page SELECTs; observed ${readQueries(result).length}`);
    claimPages[kind] = { result, expectedTotal };
  }
  console.log(JSON.stringify({ phase: "bounded-claim-complete", size }));

  assert(readQueries(newRetrievalAll).length === 2 && readQueries(newRetrievalConflict).length === 2,
    `Queue count + page must use two SELECT statements (retrieval all=${readQueries(newRetrievalAll).length}, conflict=${readQueries(newRetrievalConflict).length})`);
  assert(readQueries(newFullText).length === 2, `Full-text queue count + page must use two SELECT statements (observed ${readQueries(newFullText).length})`);

  const planRecords: Array<Awaited<ReturnType<typeof explain>>> = [];
  for (const [label, measurement] of [
    ["retrieval.all.count", newRetrievalAll],
    ["retrieval.all.page", newRetrievalAll],
    ["fullText.all.count", newFullText],
    ["fullText.all.page", newFullText],
    ["claim.evidence.count", claimPages.evidence.result],
    ["claim.evidence.page", claimPages.evidence.result],
    ["claim.extractionRevision.count", claimPages.extractionRevision.result],
    ["claim.extractionRevision.page", claimPages.extractionRevision.result],
    ["claim.synthesisRevision.count", claimPages.synthesisRevision.result],
    ["claim.synthesisRevision.page", claimPages.synthesisRevision.result],
  ] as const) {
    const queryIndex = label.endsWith(".count") ? 0 : 1;
    const query = readQueries(measurement)[queryIndex];
    assert(query, `Captured SQL missing for ${label}`);
    planRecords.push(await explain(client, `${size}.${label}`, query));
  }

  const result = {
    projectId: project.id,
    size,
    seed: seeded,
    retrieval: {
      legacyOperationalAll: fullResultMeasurement(oldRetrieval, oldRetrieval.value?.length ?? 0),
      legacyConflict: fullResultMeasurement(oldRetrievalConflict, oldRetrievalConflict.value?.length ?? 0),
      pagedAll: pageMeasurement(newRetrievalAll),
      pagedConflict: pageMeasurement(newRetrievalConflict),
      approvedDeltaCount: retrievalEquivalenceChecked
        ? newRetrievalAll.value.totalCount - oldRetrieval.value!.length
        : null,
      oldOperationalAndConflictCountsSumToNewAll: retrievalEquivalenceChecked
        ? newRetrievalAll.value.totalCount === oldRetrieval.value!.length + oldRetrievalConflict.value!.length
        : null,
      equivalenceCheckedAgainstLegacy: retrievalEquivalenceChecked,
    },
    fullTextQueue: {
      legacyAll: fullResultMeasurement(oldFullText, oldFullText.value.length),
      pagedAll: pageMeasurement(newFullText),
      legacyStateCounts: newFullTextExpected,
      pageStateCounts: newFullText.value.counts,
      classificationCountsEquivalent: newFullTextExpected !== null,
    },
    claimSupport: Object.fromEntries(claimKinds.map((kind) => [kind, {
      legacyUnbounded: fullResultMeasurement(oldClaim, oldClaimCounts?.[kind] ?? 0,
        oldClaim.value?.[kind === "extractionRevision" ? "extraction" : kind === "synthesisRevision" ? "synthesis" : "evidence"]),
      paged: pageMeasurement(claimPages[kind].result),
      idsCountEquivalent: oldClaimCounts ? claimPages[kind].result.value?.totalCount === oldClaimCounts[kind] : null,
    }])),
    statements: {
      queueCountAndPage: 2,
      claimCountAndPagePerKind: Object.fromEntries(claimKinds.map((kind) => [kind, readQueries(claimPages[kind].result).length])),
      legacyRetrievalAll: oldRetrieval.statementCount,
      legacyFullTextAll: oldFullText.statementCount,
      legacyClaimCatalog: readQueries(oldClaim).length,
    },
    plans: planRecords,
  };

  return { projectId: project.id, targetPaperId: seeded.targetPaperId, result, db, client };
}

async function historyAndExactLookupEvidence(args: {
  client: postgres.Sql;
  db: Database;
  projectId: string;
  targetPaperId: string;
}) {
  const { client, db, projectId, targetPaperId } = args;
  const titleAbstract = await measured(() => new ScreeningDecisionRepository(db).listForPaperWithCriteria(projectId, targetPaperId));
  const fullText = await measured(() => new FullTextScreeningDecisionRepository(db).listForPaperWithCriteria(projectId, targetPaperId));
  const joinedTa = titleAbstract.queries.find((query) => query.query.toLowerCase().includes("left join \"screening_criteria\""));
  const joinedFt = fullText.queries.find((query) => query.query.toLowerCase().includes("left join \"full_text_screening_criteria\""));

  const legacyTaHistory = await measured(async () => {
    const decisions = await db.select().from(screeningDecisions).where(and(
      eq(screeningDecisions.projectId, projectId),
      eq(screeningDecisions.paperId, targetPaperId),
      eq(screeningDecisions.stage, "title_abstract"),
    )).orderBy(screeningDecisions.sequence);
    const lookups = await Promise.all(decisions.flatMap((decision) => decision.exclusionCriterionId
      ? [db.select().from(screeningCriteria).where(and(
        eq(screeningCriteria.projectId, projectId), eq(screeningCriteria.id, decision.exclusionCriterionId),
      )).limit(1)]
      : []));
    return { historyRows: decisions.length, criterionLookups: lookups.length };
  });
  const legacyFtHistory = await measured(async () => {
    const decisions = await db.select().from(fullTextScreeningDecisions).where(and(
      eq(fullTextScreeningDecisions.projectId, projectId),
      eq(fullTextScreeningDecisions.paperId, targetPaperId),
    )).orderBy(fullTextScreeningDecisions.sequence);
    const lookups = await Promise.all(decisions.flatMap((decision) => decision.exclusionCriterionId
      ? [db.select().from(fullTextScreeningCriteria).where(and(
        eq(fullTextScreeningCriteria.projectId, projectId), eq(fullTextScreeningCriteria.id, decision.exclusionCriterionId),
      )).limit(1)]
      : []));
    return { historyRows: decisions.length, criterionLookups: lookups.length };
  });
  assert(legacyTaHistory.value && legacyFtHistory.value, "Legacy criterion N+1 reference runs must complete");
  if (titleAbstract.value) assert(titleAbstract.value.length === JOINED_HISTORY_ROWS + 2, "TA benchmark history row count is wrong");
  if (fullText.value) assert(fullText.value.length === JOINED_HISTORY_ROWS + 2, "Full-text benchmark history row count is wrong");

  const revisionId = stableId(projectId, "synthesis-revision:1");
  const statementId = stableId(projectId, "synthesis-statement:1");
  const exactLookup = await measured(() => new SynthesisRevisionRepository(db).findFinalizedById(projectId, statementId, revisionId));
  const exactQuery = exactLookup.queries[0];

  const planRecords = [];
  if (joinedTa) planRecords.push(await explain(client, "50k.screening.titleAbstractHistoryWithCriterionJoin", joinedTa));
  if (joinedFt) planRecords.push(await explain(client, "50k.screening.fullTextHistoryWithCriterionJoin", joinedFt));
  if (exactQuery) planRecords.push(await explain(client, "50k.synthesis.exactFinalizedRevisionLookup", exactQuery));

  return {
    titleAbstract: {
      status: titleAbstract.status,
      error: titleAbstract.error,
      detailHistoryRows: titleAbstract.value?.length ?? null,
      joinedDetailStatementCount: titleAbstract.statementCount,
      joinedHistorySelectCount: readQueries(titleAbstract).length,
      legacyHistoryRows: legacyTaHistory.value?.historyRows ?? null,
      legacyCriterionLookupCount: legacyTaHistory.value?.criterionLookups ?? null,
      legacyHistorySubflowStatementCount: legacyTaHistory.statementCount,
      fullDetailLegacyReferenceStatementCount: joinedTa && legacyTaHistory.value
        ? titleAbstract.statementCount - 1 + legacyTaHistory.statementCount
        : null,
    },
    fullText: {
      status: fullText.status,
      error: fullText.error,
      detailHistoryRows: fullText.value?.length ?? null,
      joinedDetailStatementCount: fullText.statementCount,
      joinedHistorySelectCount: readQueries(fullText).length,
      legacyHistoryRows: legacyFtHistory.value?.historyRows ?? null,
      legacyCriterionLookupCount: legacyFtHistory.value?.criterionLookups ?? null,
      legacyHistorySubflowStatementCount: legacyFtHistory.statementCount,
      fullDetailLegacyReferenceStatementCount: joinedFt && legacyFtHistory.value
        ? fullText.statementCount - 1 + legacyFtHistory.statementCount
        : null,
    },
    exactFinalizedSynthesisRevision: {
      status: exactLookup.status,
      error: exactLookup.error,
      returnedRequestedRevision: exactLookup.value?.id === revisionId,
      statementCount: exactLookup.statementCount,
      wallTimeMs: exactLookup.wallTimeMs,
      payloadBytes: exactLookup.value ? jsonBytes(exactLookup.value) : null,
    },
    plans: planRecords,
  };
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 server with permission to create and drop a disposable database.");
  const sizes = requestedSizes();
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_read_paths_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  let created = false;
  let migrationDb: ReturnType<typeof createDb> | undefined;
  let client: postgres.Sql | undefined;
  const allResults: unknown[] = [];
  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; connected version number is ${versionNumber}.`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;
    migrationDb = createDb(benchmarkUrl.toString());
    await migrate(migrationDb.db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
    await migrationDb.client.end();
    migrationDb = undefined;

    client = postgres(benchmarkUrl.toString(), { max: 1, prepare: false });
    const db = drizzle(client, {
      schema,
      logger: { logQuery(query, params) { queryCapture?.push({ query, params: [...params] }); } },
    });
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.unsafe(`set lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    const services = createReviewServices(db);
    console.log(JSON.stringify({
      benchmark: "Slice 36 read paths",
      postgresVersion: 16,
      pageSize: PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      seedStatementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      sizes,
      note: "Synthetic data is inserted into a disposable migrated database and dropped in finally. Timings are observations, not pass/fail thresholds.",
    }));

    for (const size of sizes) {
      await client.unsafe(`set statement_timeout = '${SEED_STATEMENT_TIMEOUT_MS}ms'`);
      const scenario = await benchmarkScenario({ client, db, services, size });
      allResults.push(scenario.result);
      console.log(JSON.stringify(scenario.result));
      if (size === 50_000) {
        const historyEvidence = await historyAndExactLookupEvidence({
          client, db, projectId: scenario.projectId, targetPaperId: scenario.targetPaperId,
        });
        allResults.push({ historyAndExactLookupEvidence: historyEvidence });
        console.log(JSON.stringify({ historyAndExactLookupEvidence: historyEvidence }));
      }
    }
    console.log(JSON.stringify({ benchmarkSummary: allResults }));
  } finally {
    if (migrationDb) await migrationDb.client.end();
    if (client) await client.end();
    try {
      if (created) {
        await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
        console.log(JSON.stringify({ phase: "cleanup-complete", databaseName, dropped: true }));
      }
    } finally {
      await admin.end();
    }
  }
}

main().catch((error: unknown) => {
  console.error(sanitizedError(error));
  process.exitCode = 1;
});
