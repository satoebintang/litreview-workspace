import "dotenv/config";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createExtractionProgressReadServices } from "@/application/extraction-progress-read-services";
import { createExtractionWorksheetReadServices } from "@/application/extraction-worksheet-read-services";
import { EvidenceRepository, PaperRepository, PaperReviewRepository } from "@/application/repositories";
import { createReviewServices } from "@/application/services";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";
import type { Database } from "@/db/client";

const PAPER_SIZES = [1_000, 10_000, 50_000] as const;
const FIELD_COUNTS = [10, 50, 100] as const;
const HISTORY_PER_FIELD = 20;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_STATEMENT_TIMEOUT_MS = 600_000;
const LOCK_TIMEOUT_MS = 5_000;
const LEGACY_PROGRESS_WALL_TIMEOUT_MS = 15_000;
const LEGACY_PROGRESS_EQUIVALENCE_TIMEOUT_MS = 30_000;
const LEGACY_WORKSHEET_WALL_TIMEOUT_MS = 60_000;
const LEGACY_WORKER_PROGRESS_INTERVAL_STATEMENTS = 250;

type CapturedQuery = { query: string; params: unknown[] };
type CaptureSink = { current: CapturedQuery[] | null; onQuery?: (query: string) => void };
type LegacyProgressProjection = {
  includedPaperCount: number;
  historicalPaperCount: number;
  requiredFieldCount: number;
  papers: Array<{
    paper: { id: string };
    completedRequired: number;
    requiredCount: number;
    status: string;
    percentage: number | null;
    writeEligible: boolean;
  }>;
};
type LegacyProgressMeasurement = {
  value: LegacyProgressProjection | null;
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  payloadBytes: number | null;
  error?: string;
};
type LegacyWorksheetProjection = {
  extraction: {
    fields: Array<{ id: string; name: string; description: string | null; fieldType: string; required: boolean; sortOrder: number; archivedAt: Date | string | null }>;
    values: Array<{ field: { id: string }; currentRevision?: { id: string } | null; supportStatus: string }>;
    reviewStatus: unknown;
  };
  options: Array<Array<{ id: string; label: string; sortOrder: number; archivedAt: Date | string | null }>>;
  histories: Array<Array<{
    id: string;
    sequence: number;
    fieldType: string;
    valueState: string;
    textValue: string | null;
    numberValue: string | number | null;
    booleanValue: boolean | null;
    optionId: string | null;
    researcherNote: string | null;
    createdAt: Date | string;
    finalizedAt: Date | string | null;
    evidence: Array<{ id: string }>;
  }>>;
  paperEvidence: Array<{ id: string; paperId: string; reviewState: string; curationWarning: string | null }>;
  projectEvidenceRows: number;
  payloadBytes: number;
};
type LegacyWorksheetMeasurement = {
  value: LegacyWorksheetProjection | null;
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  error?: string;
};
type LegacyWorkerProgress = { statementCount: number; selectCount: number };
type LegacyWorkerResultMessage = {
  kind: "result";
  mode: "progress" | "worksheet";
  measurement: {
    value: LegacyProgressProjection | LegacyWorksheetProjection | null;
    status: "completed" | "timed_out" | "failed";
    wallTimeMs: number;
    statementCount: number;
    selectCount: number;
    payloadBytes: number | null;
    error?: string;
  };
};
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
  return '"' + value.replaceAll('"', '""') + '"';
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value.code ?? value.cause?.code;
}

function safeError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } }
    : null;
  const causeMessage = typeof record?.cause?.message === "string" ? record.cause.message : null;
  const message = causeMessage
    ? String(record?.name ?? "Error") + ": " + causeMessage + (record?.cause?.code ? " (SQLSTATE " + String(record.cause.code) + ")" : "")
    : error instanceof Error ? error.name + ": " + error.message : String(error);
  const redacted = message.replace(/postgres(?:ql)?:\/\S+/gi, "[redacted database URL]");
  return redacted.length > 1_000 ? redacted.slice(0, 1_000) + "… [truncated]" : redacted;
}

function isTimeout(error: unknown) {
  return errorCode(error) === "57014" || /statement timeout|canceling statement/i.test(safeError(error));
}

function captureQueries(client: postgres.Sql, sink?: CaptureSink) {
  return drizzle(client, {
    schema,
    logger: {
      logQuery(query, params) {
        const target = sink ? sink.current : queryCapture;
        target?.push({ query, params: [...params] });
        sink?.onQuery?.(query);
      },
    },
  }) as Database;
}

async function measured<T>(run: () => Promise<T>): Promise<Measurement<T>> {
  if (queryCapture) throw new Error("Benchmark query capture cannot be nested");
  const queries: CapturedQuery[] = [];
  const started = process.hrtime.bigint();
  queryCapture = queries;
  try {
    const value = await run();
    return { value, status: "completed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, statementCount: queries.length, queries };
  } catch (error) {
    return {
      value: null,
      status: isTimeout(error) ? "timed_out" : "failed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      queries,
      error: safeError(error),
    };
  } finally {
    queryCapture = null;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stableId(projectId: string, label: string) {
  const digest = createHash("md5").update(projectId + ":" + label).digest("hex");
  const value = digest.slice(0, 12) + "5" + digest.slice(13, 16) + "a" + digest.slice(17);
  return value.slice(0, 8) + "-" + value.slice(8, 12) + "-" + value.slice(12, 16) + "-" + value.slice(16, 20) + "-" + value.slice(20);
}

function hashedUuidSql(valueExpression: string) {
  const digest = "md5(" + valueExpression + ")";
  return "(substring(" + digest + " from 1 for 12) || '5' || substring(" + digest + " from 14 for 3) || 'a' || substring(" + digest + " from 18 for 15))::uuid";
}

function selectQueries(measurement: Measurement<unknown>) {
  return measurement.queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function dateValue(value: Date | string | null | undefined) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function paperId(projectId: string, ordinal: number) {
  return stableId(projectId, "paper:" + ordinal);
}

async function seedScenario(client: postgres.Sql, projectId: string, paperCount: number, fieldCount: number) {
  const targetPaperId = paperId(projectId, 1);
  const historyPaperId = paperId(projectId, 2);
  const activeOptionId = stableId(projectId, "option:active");
  const archivedOptionId = stableId(projectId, "option:archived");

  await client.unsafe(
    "insert into papers (id, project_id, title, authors, publication_year, venue, abstract, created_at, updated_at) " +
    "select " + hashedUuidSql("$1::text || ':paper:' || g.n::text") + ", $1::uuid, 'Benchmark paper ' || g.n::text, " +
    "array['Benchmark et al.'], 2024, 'Extraction read benchmark', 'Synthetic abstract for bounded-read measurement', " +
    "timestamptz '2025-01-01 00:00:00+00' + g.n * interval '1 second', " +
    "timestamptz '2025-01-01 00:00:00+00' + g.n * interval '1 second' " +
    "from generate_series(1, $2::integer) as g(n)",
    [projectId, paperCount],
  );
  await client.unsafe(
    "insert into extraction_fields (id, project_id, name, description, field_type, required, sort_order) " +
    "select " + hashedUuidSql("$1::text || ':field:' || g.n::text") + ", $1::uuid, " +
    "'Benchmark field ' || g.n::text, 'Synthetic field used to measure worksheet reads', " +
    "case when g.n=1 then 'single_select' when g.n=2 then 'long_text' when g.n=3 then 'number' " +
    "when g.n=4 then 'boolean' else 'short_text' end, true, g.n " +
    "from generate_series(1, $2::integer) as g(n)",
    [projectId, fieldCount],
  );
  await client.unsafe(
    "insert into extraction_options (id, project_id, field_id, label, sort_order, archived_at) " +
    "values ($1::uuid, $2::uuid, $3::uuid, 'Current choice', 1, null), " +
    "($4::uuid, $2::uuid, $3::uuid, 'Historical archived choice', 2, timestamptz '2025-12-01 00:00:00+00')",
    [activeOptionId, projectId, stableId(projectId, "field:1"), archivedOptionId],
  );

  await client.unsafe(
    "insert into screening_decisions (project_id, paper_id, stage, decision, exclusion_criterion_id, exclusion_criterion_type, note) " +
    "select $1::uuid, " + hashedUuidSql("$1::text || ':paper:' || g.n::text") + ", 'title_abstract', 'include', null, null, null " +
    "from generate_series(1, $2::integer) as g(n)",
    [projectId, paperCount],
  );
  await client.unsafe(
    "insert into full_text_retrieval_attempts (project_id, paper_id, outcome, method, attempted_at) " +
    "select $1::uuid, " + hashedUuidSql("$1::text || ':paper:' || g.n::text") + ", 'retrieved', 'manual', " +
    "timestamptz '2025-06-01 00:00:00+00' + g.n * interval '1 second' " +
    "from generate_series(1, $2::integer) as g(n)",
    [projectId, paperCount],
  );
  await client.unsafe(
    "insert into full_text_screening_decisions (project_id, paper_id, decision, exclusion_criterion_id, note) " +
    "select $1::uuid, " + hashedUuidSql("$1::text || ':paper:' || g.n::text") + ", 'include', null, null " +
    "from generate_series(1, $2::integer) as g(n) where g.n <> 2",
    [projectId, paperCount],
  );

  await client.unsafe(
    "insert into evidence (id, project_id, paper_id, source_text, page_number, note) " +
    "select " + hashedUuidSql("$1::text || ':evidence:' || g.n::text") + ", $1::uuid, " +
    hashedUuidSql("$1::text || ':paper:' || g.n::text") + ", 'Synthetic source passage for benchmark paper ' || g.n::text, 1, null " +
    "from generate_series(1, $2::integer) as g(n)",
    [projectId, paperCount],
  );
  await client.unsafe(
    "insert into evidence (id, project_id, paper_id, source_text, page_number, note) " +
    "values ($1::uuid, $2::uuid, $3::uuid, 'Additional needs-review source passage', 2, null), " +
    "($4::uuid, $2::uuid, $3::uuid, 'Additional rejected source passage', 3, null), " +
    "($5::uuid, $2::uuid, $3::uuid, 'Additional unreviewed source passage', 4, null)",
    [
      stableId(projectId, "evidence:extra:needs_review"), projectId, targetPaperId,
      stableId(projectId, "evidence:extra:rejected"), stableId(projectId, "evidence:extra:unreviewed"),
    ],
  );
  await client.unsafe(
    "insert into evidence_review_decisions (project_id, evidence_id, decision, note) " +
    "select $1::uuid, " + hashedUuidSql("$1::text || ':evidence:' || g.n::text") + ", " +
    "case mod(g.n,4) when 1 then 'accepted' when 2 then 'needs_review' else 'rejected' end, null " +
    "from generate_series(1, $2::integer) as g(n) where mod(g.n,4) <> 0",
    [projectId, paperCount],
  );
  await client.unsafe(
    "insert into evidence_review_decisions (project_id, evidence_id, decision, note) values " +
    "($1::uuid, $2::uuid, 'needs_review', null), ($1::uuid, $3::uuid, 'rejected', null)",
    [projectId, stableId(projectId, "evidence:extra:needs_review"), stableId(projectId, "evidence:extra:rejected")],
  );

  await client.unsafe(
    "insert into extraction_values (project_id, paper_id, field_id) " +
    "select $1::uuid, $2::uuid, id from extraction_fields where project_id=$1::uuid " +
    "union all select $1::uuid, $3::uuid, " + hashedUuidSql("$1::text || ':field:1'"),
    [projectId, targetPaperId, historyPaperId],
  );
  await client.unsafe(
    "insert into extraction_value_revisions " +
    "(id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, number_value, boolean_value, option_id, researcher_note, created_at, finalized_at) " +
    "select " + hashedUuidSql("$1::text || ':revision:' || f.paper_id::text || ':' || f.field_id::text || ':' || g.n::text") + ", " +
    "$1::uuid, f.paper_id, f.field_id, f.id, field.field_type, 'present', " +
    "case when field.field_type in ('short_text','long_text') then 'Historical extraction entry ' || g.n::text else null end, " +
    "case when field.field_type='number' then g.n::numeric else null end, " +
    "case when field.field_type='boolean' then (mod(g.n,2)=0) else null end, " +
     "case when field.field_type='single_select' then case when g.n=1 then $3::uuid else $4::uuid end else null end, " +
     "'Benchmark note ' || g.n::text, timestamptz '2025-01-01 00:00:00+00' + g.n * interval '1 day', null " +
    "from extraction_values f join extraction_fields field on field.project_id=f.project_id and field.id=f.field_id " +
     "cross join generate_series(1, $5::integer) as g(n) " +
    "where f.project_id=$1::uuid and f.paper_id=$2::uuid order by f.field_id, g.n",
    [projectId, targetPaperId, archivedOptionId, activeOptionId, HISTORY_PER_FIELD],
  );
  await client.unsafe(
    "insert into extraction_value_revisions " +
    "(id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, option_id, researcher_note, created_at, finalized_at) " +
    "select " + hashedUuidSql("$1::text || ':history-paper-revision'") + ", $1::uuid, f.paper_id, f.field_id, f.id, " +
    "'single_select', 'present', $3::uuid, 'Legacy analytical history fixture', " +
     "timestamptz '2025-02-01 00:00:00+00', null " +
    "from extraction_values f where f.project_id=$1::uuid and f.paper_id=$2::uuid",
    [projectId, historyPaperId, activeOptionId],
  );
  await client.unsafe(
    "insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id) " +
    "select r.project_id, r.paper_id, r.id, " +
    "case when r.paper_id=$2::uuid then " +
     "case mod(r.sequence,3) when 0 then " + hashedUuidSql("$1::text || ':evidence:1'") + " " +
     "when 1 then " + hashedUuidSql("$1::text || ':evidence:extra:needs_review'") + " " +
     "else " + hashedUuidSql("$1::text || ':evidence:extra:unreviewed'") + " end " +
    "else " + hashedUuidSql("$1::text || ':evidence:2'") + " end " +
    "from extraction_value_revisions r where r.project_id=$1::uuid and r.paper_id in ($2::uuid,$3::uuid)",
    [projectId, targetPaperId, historyPaperId],
  );
  await client.unsafe(
    "update extraction_value_revisions set finalized_at=created_at " +
    "where project_id=$1::uuid and paper_id in ($2::uuid,$3::uuid) and finalized_at is null",
    [projectId, targetPaperId, historyPaperId],
  );

  for (const table of [
    "papers", "screening_decisions", "full_text_screening_decisions", "full_text_retrieval_attempts",
    "extraction_fields", "extraction_options", "extraction_values", "extraction_value_revisions",
    "extraction_revision_evidence", "evidence", "evidence_review_decisions",
  ]) {
    await client.unsafe("analyze " + table);
  }

  return {
    paperCount,
    activeFieldCount: fieldCount,
    targetPaperId,
    historicalPaperId: historyPaperId,
    historyPerField: HISTORY_PER_FIELD,
    targetEvidenceCount: 4,
    projectEvidenceCount: paperCount + 3,
    activeOptionId,
    archivedOptionId,
  };
}

function historyProjection(history: Array<{
  id: string;
  sequence: number;
  fieldType: string;
  valueState: string;
  textValue: string | null;
  numberValue: string | number | null;
  booleanValue: boolean | null;
  optionId: string | null;
  researcherNote: string | null;
  createdAt: Date | string;
  finalizedAt: Date | string | null;
  evidence: Array<{ id: string }>;
}>) {
  return history.map((revision) => ({
    id: revision.id,
    sequence: Number(revision.sequence),
    fieldType: revision.fieldType,
    valueState: revision.valueState,
    textValue: revision.textValue,
    numberValue: revision.numberValue == null ? null : String(revision.numberValue),
    booleanValue: revision.booleanValue,
    optionId: revision.optionId,
    researcherNote: revision.researcherNote,
    createdAt: dateValue(revision.createdAt),
    finalizedAt: dateValue(revision.finalizedAt),
    evidenceIds: revision.evidence.map((item) => item.id),
  }));
}

function explainTableNames(query: string) {
  const tables = [
    "projects", "papers", "screening_decisions", "full_text_screening_decisions",
    "full_text_retrieval_attempts", "extraction_fields", "extraction_options",
    "extraction_values", "extraction_value_revisions", "extraction_revision_evidence",
    "evidence_review_decisions", "evidence",
  ];
  return tables.filter((table) => query.toLowerCase().includes(table));
}

function summarizePlan(planValue: unknown) {
  const parsed = typeof planValue === "string" ? JSON.parse(planValue) as unknown : planValue;
  const root = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  const rootPlan = root?.Plan as Record<string, unknown> | undefined;
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
      sharedHitBlocks: current["Shared Hit Blocks"],
      sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"],
      tempWrittenBlocks: current["Temp Written Blocks"],
    });
    const children = current.Plans;
    if (Array.isArray(children)) for (const child of children) visit(child);
  }
  visit(rootPlan);
  return {
    planningTimeMs: root?.["Planning Time"],
    executionTimeMs: root?.["Execution Time"],
    nodes,
  };
}

async function explain(client: postgres.Sql, label: string, captured: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(
      "explain (analyze, buffers, format json) " + captured.query,
      captured.params as never,
    ) as unknown as Array<Record<string, unknown>>;
    return {
      label,
      tables: explainTableNames(captured.query),
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(captured.query),
      plan: summarizePlan(rows[0]?.["QUERY PLAN"]),
    };
  } catch (error) {
    return {
      label,
      tables: explainTableNames(captured.query),
      status: isTimeout(error) ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(captured.query),
      error: safeError(error),
      plan: null,
    };
  }
}

async function terminateLegacyWorkerSessions(client: postgres.Sql, applicationName: string) {
  let consecutiveEmptyChecks = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await client.unsafe(
      "select pg_terminate_backend(pid) from pg_stat_activity " +
      "where datname=current_database() and application_name=$1 and pid<>pg_backend_pid()",
      [applicationName],
    );
    const rows = await client.unsafe(
      "select count(*)::integer as count from pg_stat_activity " +
      "where datname=current_database() and application_name=$1 and pid<>pg_backend_pid()",
      [applicationName],
    ) as unknown as Array<{ count: number }>;
    if (Number(rows[0]?.count ?? 0) === 0) {
      consecutiveEmptyChecks += 1;
      if (consecutiveEmptyChecks >= 3) return;
    } else {
      consecutiveEmptyChecks = 0;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Timed-out legacy worker PostgreSQL session did not terminate within four seconds.");
}

function waitForWorkerExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<boolean>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(true);
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    function finish(exited: boolean) {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    }
    child.once("exit", onExit);
  });
}

async function measureLegacyWorker<T extends LegacyProgressProjection | LegacyWorksheetProjection>(args: {
  client: postgres.Sql;
  databaseUrl: string;
  mode: "progress" | "worksheet";
  projectId: string;
  paperId?: string;
  timeoutMs: number;
}): Promise<{ value: T | null; status: "completed" | "timed_out" | "failed"; wallTimeMs: number; statementCount: number; selectCount: number; payloadBytes: number | null; error?: string }> {
  const { client, databaseUrl, mode, projectId, paperId, timeoutMs } = args;
  const applicationName = "slice37_legacy_" + randomUUID().replaceAll("-", "").slice(0, 24);
  const scriptPath = resolve(process.cwd(), "scripts/benchmark-extraction-read-paths.ts");
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, "--legacy-worker", mode, projectId, paperId ?? "", applicationName], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: "",
      SLICE37_BENCHMARK_DATABASE_URL: databaseUrl,
      SLICE37_BENCHMARK_APPLICATION_NAME: applicationName,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const started = process.hrtime.bigint();
  let lastProgress: LegacyWorkerProgress = { statementCount: 0, selectCount: 0 };
  let workerResult: LegacyWorkerResultMessage["measurement"] | null = null;
  let timingOut = false;
  let settled = false;

  return await new Promise((resolveMeasurement) => {
    let resultExitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (measurement: { value: T | null; status: "completed" | "timed_out" | "failed"; wallTimeMs: number; statementCount: number; selectCount: number; payloadBytes: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (resultExitTimer) clearTimeout(resultExitTimer);
      resolveMeasurement(measurement);
    };

    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record.kind === "progress") {
        lastProgress = {
          statementCount: Number(record.statementCount ?? lastProgress.statementCount),
          selectCount: Number(record.selectCount ?? lastProgress.selectCount),
        };
      } else if (record.kind === "result" && record.mode === mode && typeof record.measurement === "object" && record.measurement !== null) {
        workerResult = record.measurement as LegacyWorkerResultMessage["measurement"];
        clearTimeout(timer);
        if (!resultExitTimer) {
          resultExitTimer = setTimeout(() => {
            void (async () => {
              try {
                child.kill();
                await terminateLegacyWorkerSessions(client, applicationName);
                const exited = await waitForWorkerExit(child, 3_000);
                if (!exited) throw new Error("Worker process did not exit after its result message.");
                finish({
                  value: null,
                  status: "failed",
                  wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
                  statementCount: workerResult?.statementCount ?? lastProgress.statementCount,
                  selectCount: workerResult?.selectCount ?? lastProgress.selectCount,
                  payloadBytes: null,
                  error: "Legacy worker sent a result but did not exit within three seconds; its tagged database sessions were terminated.",
                });
              } catch (error) {
                finish({
                  value: null,
                  status: "failed",
                  wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
                  statementCount: workerResult?.statementCount ?? lastProgress.statementCount,
                  selectCount: workerResult?.selectCount ?? lastProgress.selectCount,
                  payloadBytes: null,
                  error: "Worker post-result cleanup could not be verified: " + safeError(error),
                });
              }
            })();
          }, 3_000);
        }
      }
    });
    child.once("error", (error) => {
      finish({
        value: null,
        status: "failed",
        wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        statementCount: lastProgress.statementCount,
        selectCount: lastProgress.selectCount,
        payloadBytes: null,
        error: safeError(error),
      });
    });
    child.once("exit", (code, signal) => {
      if (timingOut || settled) return;
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      if (workerResult) {
        finish({
          ...workerResult,
          value: workerResult.value as T | null,
        });
      } else {
        finish({
          value: null,
          status: "failed",
          wallTimeMs: elapsed,
          statementCount: lastProgress.statementCount,
          selectCount: lastProgress.selectCount,
          payloadBytes: null,
          error: "Legacy worker exited without a result (code " + String(code) + ", signal " + String(signal) + ").",
        });
      }
    });

    const timer = setTimeout(() => {
      timingOut = true;
      child.kill();
      void (async () => {
        try {
          await terminateLegacyWorkerSessions(client, applicationName);
          const exited = await waitForWorkerExit(child, 3_000);
          if (!exited) throw new Error("Timed-out legacy worker process did not exit within three seconds.");
          finish({
            value: null,
            status: "timed_out",
            wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
            statementCount: lastProgress.statementCount,
            selectCount: lastProgress.selectCount,
            payloadBytes: null,
            error: "Legacy " + mode + " wall-time budget reached (" + timeoutMs + "ms); the isolated worker and its tagged database sessions were terminated.",
          });
        } catch (error) {
          finish({
            value: null,
            status: "failed",
            wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
            statementCount: lastProgress.statementCount,
            selectCount: lastProgress.selectCount,
            payloadBytes: null,
            error: "Legacy worker cancellation could not be verified: " + safeError(error),
          });
        }
      })();
    }, timeoutMs);
  });
}

async function measureLegacyProgress(client: postgres.Sql, databaseUrl: string, projectId: string, timeoutMs: number): Promise<LegacyProgressMeasurement> {
  return await measureLegacyWorker<LegacyProgressProjection>({
    client,
    databaseUrl,
    mode: "progress",
    projectId,
    timeoutMs,
  });
}

async function measureLegacyWorksheet(client: postgres.Sql, databaseUrl: string, projectId: string, paperId: string): Promise<LegacyWorksheetMeasurement> {
  return await measureLegacyWorker<LegacyWorksheetProjection>({
    client, databaseUrl, mode: "worksheet", projectId, paperId, timeoutMs: LEGACY_WORKSHEET_WALL_TIMEOUT_MS,
  });
}

async function benchmarkScenario(args: {
  client: postgres.Sql;
  databaseUrl: string;
  db: Database;
  projectId: string;
  paperCount: number;
  fieldCount: number;
}) {
  const { client, databaseUrl, db, projectId, paperCount, fieldCount } = args;
  const seeded = await seedScenario(client, projectId, paperCount, fieldCount);
  await client.unsafe("set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");

  const paperRepo = new PaperRepository(db);
  const paperReviewRepo = new PaperReviewRepository(db);
  const evidenceRepo = new EvidenceRepository(db);
  const progressRead = createExtractionProgressReadServices(db);
  const worksheetRead = createExtractionWorksheetReadServices(db, { paperRepo, paperReviewRepo, evidenceRepo });

  const legacyProgress = await measureLegacyProgress(
    client,
    databaseUrl,
    projectId,
    paperCount === 1_000 && fieldCount === 10 ? LEGACY_PROGRESS_EQUIVALENCE_TIMEOUT_MS : LEGACY_PROGRESS_WALL_TIMEOUT_MS,
  );
  const pagedProgress = await measured(() => progressRead.getExtractionProgressPage(projectId, { page: 1, pageSize: PAGE_SIZE }));
  assert(pagedProgress.value, "Bounded progress failed at " + paperCount + " Papers / " + fieldCount + " Fields: " + (pagedProgress.error ?? pagedProgress.status));
  const newProgress = pagedProgress.value;
  const oldProgress = legacyProgress.value;
  assert(newProgress.counts.includedPaperCount === paperCount - 1 && newProgress.counts.historicalPaperCount === 1,
    "Progress fixture membership did not include the full Paper population");
  assert(newProgress.pagination.totalCount === paperCount && newProgress.items.length === Math.min(PAGE_SIZE, paperCount),
    "Bounded progress returned unexpected total membership or page size");
  let remainingProgressPages: Measurement<{ items: typeof newProgress.items; pageCount: number }> | null = null;
  let allNewProgressItems = newProgress.items;
  if (paperCount === 1_000 && fieldCount === 10) {
    remainingProgressPages = await measured(async () => {
      const items = [...newProgress.items];
      for (let page = 2; page <= newProgress.pagination.totalPages; page += 1) {
        const next = await progressRead.getExtractionProgressPage(projectId, { page, pageSize: PAGE_SIZE });
        assert(next.pagination.totalPages === newProgress.pagination.totalPages, "Progress page count changed within a fixture");
        items.push(...next.items);
      }
      return { items, pageCount: newProgress.pagination.totalPages };
    });
    assert(remainingProgressPages.value, "Remaining progress pages did not complete");
    allNewProgressItems = remainingProgressPages.value.items;
    const selectShapes = selectQueries(remainingProgressPages).reduce((counts, query) => {
      const shape = query.query.trim().replace(/\s+/g, " ").slice(0, 120);
      counts.set(shape, (counts.get(shape) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    assert(selectQueries(remainingProgressPages).length === (newProgress.pagination.totalPages - 1) * 2,
      "Each additional progress page must use exactly two SELECT statements; observed " + selectQueries(remainingProgressPages).length +
      " SELECTs across " + remainingProgressPages.value.pageCount + " total pages / " + remainingProgressPages.statementCount +
      " logged statements; query shapes " + JSON.stringify([...selectShapes]));
  }
  let progressMembershipEquivalent: boolean | null = null;
  let progressCountsEquivalent: boolean | null = null;
  if (oldProgress) {
    assert(isDeepStrictEqual(newProgress.counts, {
      includedPaperCount: oldProgress.includedPaperCount,
      historicalPaperCount: oldProgress.historicalPaperCount,
      requiredFieldCount: oldProgress.requiredFieldCount,
    }), "Progress counts differ from released behavior");
    progressCountsEquivalent = true;
  }
  if (oldProgress && paperCount === 1_000) {
    const oldIds = oldProgress.papers.map((item) => item.paper.id).sort();
    const newIds = allNewProgressItems.map((item) => item.paper.id).sort();
    assert(isDeepStrictEqual(newIds, oldIds), "All paginated Paper membership differs from the released progress implementation");
    progressMembershipEquivalent = true;
  }

  const legacyWorksheet = await measureLegacyWorksheet(client, databaseUrl, projectId, seeded.targetPaperId);
  const worksheet = await measured(() => worksheetRead.getPaperExtractionWorksheet(projectId, seeded.targetPaperId));
  assert(worksheet.value, "Set-based worksheet failed at " + paperCount + " Papers / " + fieldCount + " Fields: " + (worksheet.error ?? worksheet.status));

  const oldWorksheet = legacyWorksheet.value;
  const newWorksheet = worksheet.value;
  const evidenceFacts = (items: Array<{ id: string; paperId: string; reviewState: string; curationWarning: string | null }>) =>
    items.map((item) => [item.id, item.paperId, item.reviewState, item.curationWarning]).sort();
  let worksheetEquivalence: Record<string, boolean | null> | null = null;
  type WorksheetFieldFact = { id: string; name: string; description: string | null; fieldType: string; required: boolean; sortOrder: number; archivedAt: Date | string | null };
  let oldFields: WorksheetFieldFact[] | null = null;
  if (oldWorksheet) {
    const oldFieldRows = oldWorksheet.extraction.fields;
    oldFields = oldFieldRows;
    const oldOptionsByField = new Map(oldFieldRows.map((field, index) => [field.id, oldWorksheet.options[index]]));
    const fieldFacts = (field: WorksheetFieldFact) => [field.id, field.name, field.description, field.fieldType, field.required, field.sortOrder, dateValue(field.archivedAt)];
    assert(isDeepStrictEqual(oldFieldRows.map(fieldFacts), newWorksheet.fields.map(fieldFacts)), "Worksheet Field values or ordering differ from released behavior");
    const optionFacts = (option: { id: string; label: string; sortOrder: number; archivedAt: Date | string | null }) =>
      [option.id, option.label, option.sortOrder, dateValue(option.archivedAt)];
    assert(isDeepStrictEqual(oldFieldRows.map((field) => [field.id, oldOptionsByField.get(field.id)?.map(optionFacts)]),
      newWorksheet.fields.map((field) => [field.id, field.options.map(optionFacts)])), "Worksheet option labels/order/archive state differ from released behavior");
    assert(isDeepStrictEqual(oldWorksheet.extraction.values.map((value) => [value.field.id, value.currentRevision?.id ?? null, value.supportStatus]),
      newWorksheet.values.map((value) => [value.field.id, value.currentRevision?.id ?? null, value.supportStatus])), "Current finalized revision identities or supportStatus differ from released behavior");
    const oldHistoryByField = new Map(oldFieldRows.map((field, index) => [field.id, historyProjection(oldWorksheet.histories[index])]));
    const newHistoryByField = new Map(newWorksheet.values.map((value) => [value.field.id, historyProjection(value.history)]));
    assert(isDeepStrictEqual([...oldHistoryByField].sort(), [...newHistoryByField].sort()), "Finalized history or revision Evidence links differ from released behavior");
    assert(isDeepStrictEqual(evidenceFacts(oldWorksheet.paperEvidence), evidenceFacts(newWorksheet.evidence)),
      "Paper Evidence review states or warnings differ from released behavior");
    assert(isDeepStrictEqual(oldWorksheet.extraction.reviewStatus, newWorksheet.reviewStatus), "Paper review status differs from released behavior");
    const oldTargetProgress = oldProgress?.papers.find((item) => item.paper.id === seeded.targetPaperId);
    if (oldTargetProgress) {
      assert(isDeepStrictEqual({
        completedRequired: oldTargetProgress.completedRequired,
        requiredCount: oldTargetProgress.requiredCount,
        status: oldTargetProgress.status,
        percentage: oldTargetProgress.percentage,
        writeEligible: oldTargetProgress.writeEligible,
      }, newWorksheet.progress), "Worksheet progress differs from the released project progress row");
    }
    worksheetEquivalence = {
      fieldOrder: true,
      optionsIncludeArchived: true,
      currentRevisionIdentities: true,
      allFinalizedHistoryAndEvidenceLinks: true,
      paperEvidenceAndCurrentReviewWarnings: true,
      reviewStatus: true,
      progress: oldTargetProgress ? true : null,
    };
  }

  const progressSelects = selectQueries(pagedProgress);
  const worksheetSelects = selectQueries(worksheet);
  const planRecords: Array<Awaited<ReturnType<typeof explain>>> = [];
  if (paperCount === 50_000) {
    for (let index = 0; index < progressSelects.length; index += 1) {
      planRecords.push(await explain(client, paperCount + "papers." + fieldCount + "fields.progress.select-" + (index + 1), progressSelects[index]));
    }
    for (let index = 0; index < worksheetSelects.length; index += 1) {
      planRecords.push(await explain(client, paperCount + "papers." + fieldCount + "fields.worksheet.select-" + (index + 1), worksheetSelects[index]));
    }
  }

  return {
    papers: paperCount,
    activeFields: fieldCount,
    finalizedHistoriesPerTargetField: HISTORY_PER_FIELD,
    seeded,
    progress: {
      releasedUnbounded: {
        status: legacyProgress.status,
        wallTimeMs: legacyProgress.wallTimeMs,
        selectCount: legacyProgress.selectCount,
        loggedStatementCount: legacyProgress.statementCount,
        countPrecision: legacyProgress.status === "completed" ? "exact" : "lower_bound_last_worker_checkpoint",
        returnedPaperCount: oldProgress?.papers.length ?? null,
        payloadBytes: legacyProgress.payloadBytes,
        error: legacyProgress.error ?? null,
      },
      boundedPage: {
        status: pagedProgress.status,
        wallTimeMs: pagedProgress.wallTimeMs,
        selectCount: selectQueries(pagedProgress).length,
        loggedStatementCount: pagedProgress.statementCount,
        selectedPaperCount: newProgress.items.length,
        totalCount: newProgress.pagination.totalCount,
        payloadBytes: jsonBytes(newProgress),
      },
      pageStatementCount: selectQueries(pagedProgress).length,
      additionalPageCount: remainingProgressPages?.value?.pageCount ? remainingProgressPages.value.pageCount - 1 : 0,
      additionalPageSelectCount: remainingProgressPages ? selectQueries(remainingProgressPages).length : 0,
      countsEquivalent: progressCountsEquivalent,
      fullMembershipEquivalent: progressMembershipEquivalent,
      counts: newProgress.counts,
    },
    worksheet: {
      releasedNPlusOne: {
        status: legacyWorksheet.status,
        wallTimeMs: legacyWorksheet.wallTimeMs,
        selectCount: legacyWorksheet.selectCount,
        loggedStatementCount: legacyWorksheet.statementCount,
        countPrecision: legacyWorksheet.status === "completed" ? "exact" : "lower_bound_last_worker_checkpoint",
        fields: oldFields?.length ?? null,
        optionRows: oldWorksheet?.options.reduce((total, items) => total + items.length, 0) ?? null,
        finalizedHistoryRows: oldWorksheet?.histories.reduce((total, items) => total + items.length, 0) ?? null,
        allProjectEvidenceRowsRead: oldWorksheet?.projectEvidenceRows ?? null,
        PaperEvidenceRowsReturned: oldWorksheet?.paperEvidence.length ?? null,
        payloadBytes: oldWorksheet?.payloadBytes ?? null,
        error: legacyWorksheet.error ?? null,
      },
      setBased: {
        status: worksheet.status,
        wallTimeMs: worksheet.wallTimeMs,
        selectCount: worksheetSelects.length,
        loggedStatementCount: worksheet.statementCount,
        fields: newWorksheet.fields.length,
        optionRows: newWorksheet.fields.reduce((total, field) => total + field.options.length, 0),
        finalizedHistoryRows: newWorksheet.values.reduce((total, value) => total + value.history.length, 0),
        PaperEvidenceRowsReturned: newWorksheet.evidence.length,
        payloadBytes: jsonBytes(newWorksheet),
      },
      equivalence: worksheetEquivalence,
    },
    planRecords,
  };
}

function requestedPaperSizes() {
  const raw = process.env.EXTRACTION_READ_BENCHMARK_PAPERS?.trim();
  if (!raw) return [...PAPER_SIZES];
  const sizes = raw.split(",").map((value) => Number(value.trim()));
  if (sizes.length === 0 || sizes.some((size) => !PAPER_SIZES.includes(size as typeof PAPER_SIZES[number]))) {
    throw new Error("EXTRACTION_READ_BENCHMARK_PAPERS must be a comma-separated subset of " + PAPER_SIZES.join(", "));
  }
  return [...new Set(sizes)];
}

function requestedFieldCounts() {
  const raw = process.env.EXTRACTION_READ_BENCHMARK_FIELDS?.trim();
  if (!raw) return [...FIELD_COUNTS];
  const counts = raw.split(",").map((value) => Number(value.trim()));
  if (counts.length === 0 || counts.some((count) => !FIELD_COUNTS.includes(count as typeof FIELD_COUNTS[number]))) {
    throw new Error("EXTRACTION_READ_BENCHMARK_FIELDS must be a comma-separated subset of " + FIELD_COUNTS.join(", "));
  }
  return [...new Set(counts)];
}

async function sendLegacyWorkerMessage(message: unknown) {
  const workerProcess = process as NodeJS.Process & {
    send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  if (!workerProcess.send) throw new Error("Legacy worker was not started with an IPC channel.");
  await new Promise<void>((resolveSend, rejectSend) => {
    workerProcess.send!(message, (error) => error ? rejectSend(error) : resolveSend());
  });
}

async function runLegacyWorker() {
  const mode = process.argv[3];
  const projectId = process.argv[4];
  const paperId = process.argv[5];
  const applicationName = process.argv[6];
  const databaseUrl = process.env.SLICE37_BENCHMARK_DATABASE_URL;
  if (mode !== "progress" && mode !== "worksheet") throw new Error("Legacy worker mode must be progress or worksheet.");
  if (!projectId) throw new Error("Legacy worker requires a Project id.");
  if (mode === "worksheet" && !paperId) throw new Error("Legacy worksheet worker requires a Paper id.");
  if (!databaseUrl?.trim()) throw new Error("Legacy worker requires the explicit disposable benchmark database URL.");
  const parsedDatabaseUrl = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
  if (!databaseName.startsWith("litreview_extraction_read_")) throw new Error("Legacy worker refused a non-benchmark database URL.");
  if (!applicationName || applicationName !== process.env.SLICE37_BENCHMARK_APPLICATION_NAME || !/^slice37_legacy_[a-f0-9]+$/.test(applicationName)) {
    throw new Error("Legacy worker requires its unique benchmark-only PostgreSQL application name.");
  }

  const client = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  const started = process.hrtime.bigint();
  let statementCount = 0;
  let selectCount = 0;
  const captureSink: CaptureSink = {
    current: null,
    onQuery(query) {
      statementCount += 1;
      if (/^(with|select)\b/i.test(query.trim())) selectCount += 1;
      if (statementCount % LEGACY_WORKER_PROGRESS_INTERVAL_STATEMENTS === 0) {
        void sendLegacyWorkerMessage({ kind: "progress", statementCount, selectCount }).catch(() => {});
      }
    },
  };
  let measurement: LegacyWorkerResultMessage["measurement"];
  try {
    await client.unsafe("set application_name = '" + applicationName + "'");
    await client.unsafe("set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");
    await client.unsafe("set lock_timeout = '" + LOCK_TIMEOUT_MS + "ms'");
    const services = createReviewServices(captureQueries(client, captureSink));
    let value: LegacyProgressProjection | LegacyWorksheetProjection;
    let payloadBytes: number;
    if (mode === "progress") {
      const result = await services.getProjectExtractionProgress(projectId);
      payloadBytes = jsonBytes(result);
      value = {
        includedPaperCount: result.includedPaperCount,
        historicalPaperCount: result.historicalPaperCount,
        requiredFieldCount: result.requiredFieldCount,
        papers: result.papers.map((item) => ({
          paper: { id: item.paper.id },
          completedRequired: item.completedRequired,
          requiredCount: item.requiredCount,
          status: item.status,
          percentage: item.percentage,
          writeEligible: item.writeEligible,
        })),
      };
    } else {
      const extraction = await services.getPaperExtraction(projectId, paperId!);
      const options = await Promise.all(extraction.fields.map((field) => services.listExtractionOptions(projectId, field.id, true)));
      const histories = await Promise.all(extraction.fields.map((field) => services.getExtractionValueHistory(projectId, paperId!, field.id)));
      const projectEvidence = await services.listEvidence(projectId);
      const paperEvidence = projectEvidence.filter((item) => item.paperId === paperId);
      payloadBytes = jsonBytes({ extraction, options, histories, projectEvidence, paperEvidence });
      value = {
        extraction,
        options,
        histories,
        paperEvidence,
        projectEvidenceRows: projectEvidence.length,
        payloadBytes,
      };
    }
    measurement = {
      value,
      status: "completed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount,
      selectCount,
      payloadBytes,
    };
  } catch (error) {
    measurement = {
      value: null,
      status: isTimeout(error) ? "timed_out" : "failed",
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount,
      selectCount,
      payloadBytes: null,
      error: safeError(error),
    };
  } finally {
    captureSink.current = null;
    await client.end({ timeout: 1 }).catch(() => {});
  }
  await sendLegacyWorkerMessage({ kind: "result", mode, measurement });
  (process as NodeJS.Process & { disconnect?: () => void }).disconnect?.();
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 server role allowed to create/drop a disposable benchmark database.");
  const paperSizes = requestedPaperSizes();
  const fieldCounts = requestedFieldCounts();
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = "litreview_extraction_read_" + process.pid + "_" + Date.now() + "_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = "/" + databaseName;
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  let created = false;
  let client: postgres.Sql | undefined;
  const results: unknown[] = [];
  const worksheetSelectCounts = new Set<number>();
  const progressSelectCounts = new Set<number>();
  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error("Requires PostgreSQL 16; connected server version number is " + versionNumber);
    await admin.unsafe("create database " + quoteIdentifier(databaseName));
    created = true;

    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end();
    }

    client = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const db = captureQueries(client);
    await client.unsafe("set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");
    await client.unsafe("set lock_timeout = '" + LOCK_TIMEOUT_MS + "ms'");
    const services = createReviewServices(db);
    console.log(JSON.stringify({
      benchmark: "Slice 37 extraction read paths",
      postgresVersion: 16,
      paperSizes,
      fieldCounts,
      historyPerTargetField: HISTORY_PER_FIELD,
      pageSize: PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      seedStatementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      legacyProgressTimeoutMs: LEGACY_PROGRESS_WALL_TIMEOUT_MS,
      legacyProgressEquivalenceTimeoutMs: LEGACY_PROGRESS_EQUIVALENCE_TIMEOUT_MS,
      legacyWorksheetTimeoutMs: LEGACY_WORKSHEET_WALL_TIMEOUT_MS,
      legacyWorkerProgressIntervalStatements: LEGACY_WORKER_PROGRESS_INTERVAL_STATEMENTS,
      note: "Synthetic records live only in a uniquely named, migrated database that is dropped in finally. Timings are diagnostic observations, not thresholds.",
    }));

    for (const paperCount of paperSizes) {
      for (const fieldCount of fieldCounts) {
        const title = "Slice 37 benchmark " + paperCount + " papers / " + fieldCount + " fields";
        const project = await services.createProject({ title });
        await client.unsafe("set statement_timeout = '" + SEED_STATEMENT_TIMEOUT_MS + "ms'");
        const result = await benchmarkScenario({ client, databaseUrl: benchmarkUrl.toString(), db, projectId: project.id, paperCount, fieldCount });
        progressSelectCounts.add(result.progress.boundedPage.selectCount);
        worksheetSelectCounts.add(result.worksheet.setBased.selectCount);
        results.push(result);
        console.log(JSON.stringify(result));
        await client.unsafe("set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");
      }
    }
    assert(progressSelectCounts.size === 1 && progressSelectCounts.has(2),
      "Bounded progress SELECT count must be constant at two across every Paper/Field case; observed " + JSON.stringify([...progressSelectCounts]));
    assert(worksheetSelectCounts.size === 1,
      "Set-based worksheet SELECT count must be constant across every Paper/Field case; observed " + JSON.stringify([...worksheetSelectCounts]));
    console.log(JSON.stringify({
      benchmarkSummary: {
        scenarioCount: results.length,
        progressSelectCountsAcrossCases: [...progressSelectCounts],
        worksheetSelectCountsAcrossCases: [...worksheetSelectCounts],
        results,
      },
    }));
  } finally {
    if (client) await client.end({ timeout: 1 });
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

if (process.argv[2] === "--legacy-worker") {
  runLegacyWorker().catch((error: unknown) => {
    void sendLegacyWorkerMessage({
      kind: "result",
      mode: process.argv[3],
      measurement: {
        value: null,
        status: "failed",
        wallTimeMs: 0,
        statementCount: 0,
        selectCount: 0,
        payloadBytes: null,
        error: safeError(error),
      },
    }).catch(() => {}).finally(() => {
      (process as NodeJS.Process & { disconnect?: () => void }).disconnect?.();
    });
  });
} else {
  main().catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
