import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createReviewServices } from "@/application/services";
import { createSynthesisReadServices } from "@/application/synthesis-read-services";
import type { Database } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";

const POPULATION_SIZES = [1_000, 10_000, 50_000] as const;
const HISTORY_SIZES = [1, 50, 500, 1_000] as const;
const EDIT_CONTEXT_SIZES = [1, 50, 500, 1_000] as const;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_STATEMENT_TIMEOUT_MS = 600_000;

type CapturedQuery = { query: string; params: unknown[] };
type QuerySink = { queries: CapturedQuery[] };
type Measurement<T> = {
  value: T | null;
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  payloadBytes: number | null;
  queries: CapturedQuery[];
  error?: string;
};

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

async function measure<T>(sink: QuerySink, run: () => Promise<T>): Promise<Measurement<T>> {
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
      queries,
      error: safeError(error),
    };
  }
}

function hashedUuidSql(expression: string) {
  const digest = "md5(" + expression + ")";
  return "(substring(" + digest + " from 1 for 12) || '5' || substring(" + digest + " from 14 for 3) || 'a' || substring(" + digest + " from 18 for 15))::uuid";
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
      hashBatches: current["Hash Batches"],
      peakMemoryUsage: current["Peak Memory Usage"],
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

async function explain(client: postgres.Sql, label: string, query: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe("explain (analyze, buffers, format json) " + query.query, query.params as never) as unknown as Array<Record<string, unknown>>;
    return {
      label,
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(query.query),
      plan: summarizePlan(rows[0]?.["QUERY PLAN"]),
    };
  } catch (error) {
    return {
      label,
      status: isTimeout(error) ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(query.query),
      plan: null,
      error: safeError(error),
    };
  }
}

async function seedPopulation(client: postgres.Sql, projectId: string, fieldId: string, size: number) {
  const paperId = hashedUuidSql("$1::text || ':paper:' || g.n::text");
  const statementId = hashedUuidSql("$1::text || ':statement:' || g.n::text");
  await client.unsafe("insert into papers (id, project_id, title, authors, created_at, updated_at) " +
    "select " + paperId + ", $1::uuid, 'Slice 40 benchmark Paper ' || g.n::text, array['Synthetic researcher'], " +
    "'2026-09-01T00:00:00Z'::timestamptz + g.n * interval '1 second', " +
    "'2026-09-01T00:00:00Z'::timestamptz + g.n * interval '1 second' " +
    "from generate_series(1, $2::integer) as g(n)", [projectId, size]);
  await client.unsafe("insert into screening_decisions (project_id, paper_id, decision) " +
    "select $1::uuid, p.id, 'include' from papers p where p.project_id=$1::uuid", [projectId]);
  await client.unsafe("insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) " +
    "select $1::uuid, p.id, 'retrieved', now() from papers p where p.project_id=$1::uuid", [projectId]);
  await client.unsafe("insert into full_text_screening_decisions (project_id, paper_id, decision) " +
    "select $1::uuid, p.id, 'include' from papers p where p.project_id=$1::uuid", [projectId]);
  await client.unsafe("insert into extraction_values (project_id, paper_id, field_id) " +
    "select $1::uuid, p.id, $2::uuid from papers p where p.project_id=$1::uuid", [projectId, fieldId]);
  await client.unsafe("insert into extraction_value_revisions " +
    "(project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) " +
    "select $1::uuid, v.paper_id, v.field_id, v.id, 'short_text', 'present', 'Synthetic benchmark observation', now() " +
    "from extraction_values v where v.project_id=$1::uuid and v.field_id=$2::uuid", [projectId, fieldId]);
  await client.unsafe("insert into synthesis_statements (id, project_id, created_at) " +
    "select " + statementId + ", $1::uuid, '2026-09-01T00:00:00Z'::timestamptz + g.n * interval '1 second' " +
    "from generate_series(1, $2::integer) as g(n)", [projectId, size]);
  await client.unsafe("insert into synthesis_revisions " +
    "(project_id, synthesis_statement_id, state, title, statement_text, created_at) " +
    "select $1::uuid, s.id, 'active', 'Benchmark Synthesis ' || row_number() over (order by s.created_at)::text, " +
    "'Synthetic benchmark synthesis statement.', s.created_at " +
    "from synthesis_statements s where s.project_id=$1::uuid", [projectId]);
  await client.unsafe("update synthesis_revisions set finalized_at=now() where project_id=$1::uuid and finalized_at is null", [projectId]);
}

async function benchmarkPopulation(args: {
  client: postgres.Sql;
  sink: QuerySink;
  services: ReturnType<typeof createReviewServices>;
  reads: ReturnType<typeof createSynthesisReadServices>;
  size: number;
}) {
  const { client, sink, services, reads, size } = args;
  const project = await services.createProject({ title: "Slice 40 Synthesis read benchmark " + size + " " + randomUUID() });
  const field = await services.createExtractionField(project.id, { name: "Synthetic benchmark field", fieldType: "short_text" });
  await seedPopulation(client, project.id, field.id, size);
  for (const table of ["papers", "screening_decisions", "full_text_retrieval_attempts", "full_text_screening_decisions", "extraction_values", "extraction_value_revisions", "synthesis_statements", "synthesis_revisions", "synthesis_revision_supports", "extraction_revision_evidence"]) {
    await client.unsafe("analyze " + table);
  }
  await client.unsafe("set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");

  const compact = await measure(sink, () => reads.getSynthesisComparisonPage(project.id, field.id, { page: 1, pageSize: PAGE_SIZE }));
  assert(compact.value, "Synthesis comparison read failed at " + size + " Papers.");
  assert(compact.selectCount === 2, "Synthesis matrix query count changed at " + size + ": " + compact.selectCount + ".");
  const legacyMatrix = await measure(sink, () => services.listExtractionComparison(project.id, field.id));
  const matrixEquivalent = legacyMatrix.status === "completed" && legacyMatrix.value !== null
    && legacyMatrix.value.length === compact.value.pagination.totalCount
    && legacyMatrix.value.slice(0, PAGE_SIZE).map((item) => item.paper.id).join(",") === compact.value.items.map((item) => item.paper.id).join(",")
    && legacyMatrix.value.slice(0, PAGE_SIZE).map((item) => item.extractionRevision?.id ?? null).join(",") === compact.value.items.map((item) => item.extractionRevision?.id ?? null).join(",");
  if (legacyMatrix.status === "completed") assert(matrixEquivalent, "Synthesis matrix differs from its legacy projection at " + size + " Papers.");
  const matrixCounts = legacyMatrix.value?.reduce((counts, item) => {
    counts[item.valueState] = (counts[item.valueState] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const matrixCountsEquivalent = legacyMatrix.status === "completed" && matrixCounts?.present === compact.value.summary.counts.present;
  if (matrixCountsEquivalent === false) throw new Error("Synthesis matrix state summary differs at " + size + " Papers.");
  const matrixQueries = compact.queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
  const matrixPlans = await Promise.all(matrixQueries.map((query, index) => explain(client, "matrix." + size + "." + (index === 0 ? "summary" : "page"), query)));
  const matrixReport = {
    requestedPapers: size,
    legacyMatrix: {
      status: legacyMatrix.status,
      wallTimeMs: legacyMatrix.wallTimeMs,
      statementCount: legacyMatrix.statementCount,
      selectCount: legacyMatrix.selectCount,
      materializedRows: legacyMatrix.value?.length ?? null,
      payloadBytes: legacyMatrix.payloadBytes,
      error: legacyMatrix.error,
    },
    boundedMatrix: {
      wallTimeMs: compact.wallTimeMs,
      statementCount: compact.statementCount,
      selectCount: compact.selectCount,
      materializedRows: compact.value.items.length,
      payloadBytes: compact.payloadBytes,
      page: { from: compact.value.pagination.from, to: compact.value.pagination.to, totalCount: compact.value.pagination.totalCount, counts: compact.value.summary.counts },
    },
    matrixEquivalent,
    matrixCountsEquivalent,
    plans: matrixPlans,
  };
  legacyMatrix.value = null;

  const boundedLedger = await measure(sink, () => reads.getSynthesisLedgerPage(project.id, { page: 1, pageSize: PAGE_SIZE }));
  assert(boundedLedger.value, "Synthesis ledger read failed at " + size + " Statements.");
  assert(boundedLedger.selectCount === 2, "Synthesis ledger query count changed at " + size + ": " + boundedLedger.selectCount + ".");
  const legacyLedger = await measure(sink, () => services.listProjectSynthesis(project.id));
  const ledgerEquivalent = legacyLedger.status === "completed" && legacyLedger.value !== null
    && legacyLedger.value.length === boundedLedger.value.pagination.totalCount
    && legacyLedger.value.slice(0, PAGE_SIZE).map((item) => item.synthesisStatementId).join(",") === boundedLedger.value.items.map((item) => item.synthesisStatementId).join(",")
    && legacyLedger.value.slice(0, PAGE_SIZE).map((item) => item.id).join(",") === boundedLedger.value.items.map((item) => item.id).join(",");
  if (legacyLedger.status === "completed") assert(ledgerEquivalent, "Synthesis ledger differs from its legacy projection at " + size + " Statements.");
  const ledgerQueries = boundedLedger.queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
  const ledgerPlans = await Promise.all(ledgerQueries.map((query, index) => explain(client, "ledger." + size + "." + (index === 0 ? "count" : "page"), query)));
  const ledgerReport = {
    requestedStatements: size,
    legacyLedger: {
      status: legacyLedger.status,
      wallTimeMs: legacyLedger.wallTimeMs,
      statementCount: legacyLedger.statementCount,
      selectCount: legacyLedger.selectCount,
      materializedRows: legacyLedger.value?.length ?? null,
      payloadBytes: legacyLedger.payloadBytes,
      error: legacyLedger.error,
    },
    boundedLedger: {
      wallTimeMs: boundedLedger.wallTimeMs,
      statementCount: boundedLedger.statementCount,
      selectCount: boundedLedger.selectCount,
      materializedRows: boundedLedger.value.items.length,
      payloadBytes: boundedLedger.payloadBytes,
      page: { from: boundedLedger.value.pagination.from, to: boundedLedger.value.pagination.to, totalCount: boundedLedger.value.pagination.totalCount },
    },
    ledgerEquivalent,
    plans: ledgerPlans,
  };
  legacyLedger.value = null;

  let editTargets: Array<{ paperId: string; fieldId: string; extractionRevisionId: string }> = [];
  if (size === POPULATION_SIZES[POPULATION_SIZES.length - 1]) {
    const targetRows = await client.unsafe("select p.id as paper_id, r.id as extraction_revision_id " +
      "from papers p join extraction_values v on v.project_id=p.project_id and v.paper_id=p.id and v.field_id=$2::uuid " +
      "join extraction_value_revisions r on r.project_id=v.project_id and r.extraction_value_id=v.id and r.finalized_at is not null " +
      "where p.project_id=$1::uuid order by p.created_at, p.id limit $3::integer", [project.id, field.id, Math.max(...EDIT_CONTEXT_SIZES)]) as unknown as Array<Record<string, unknown>>;
    editTargets = targetRows.map((row) => ({ paperId: String(row.paper_id), fieldId: field.id, extractionRevisionId: String(row.extraction_revision_id) }));
  }

  return { projectId: project.id, fieldId: field.id, editTargets, matrix: matrixReport, ledger: ledgerReport };
}

async function benchmarkHistory(args: {
  client: postgres.Sql;
  sink: QuerySink;
  services: ReturnType<typeof createReviewServices>;
  reads: ReturnType<typeof createSynthesisReadServices>;
  projectId: string;
  extractionRevisionId: string;
  requestedRevisions: number;
}) {
  const { client, sink, services, reads, projectId, extractionRevisionId, requestedRevisions } = args;
  const statementRows = await client.unsafe("insert into synthesis_statements (project_id) values ($1::uuid) returning id", [projectId]) as unknown as Array<{ id: string }>;
  const statementId = String(statementRows[0].id);
  await client.unsafe("insert into synthesis_revisions (project_id, synthesis_statement_id, state, title, statement_text, created_at) " +
    "select $1::uuid, $2::uuid, 'active', 'History benchmark revision ' || g.n::text, 'Synthetic historical Synthesis revision.', now() - interval '1 second' " +
    "from generate_series(1, $3::integer) as g(n)", [projectId, statementId, requestedRevisions]);
  await client.unsafe("insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) " +
    "select $1::uuid, r.id, $3::uuid from synthesis_revisions r " +
    "where r.project_id=$1::uuid and r.synthesis_statement_id=$2::uuid and r.finalized_at is null", [projectId, statementId, extractionRevisionId]);
  await client.unsafe("update synthesis_revisions set finalized_at=now() " +
    "where project_id=$1::uuid and synthesis_statement_id=$2::uuid and finalized_at is null", [projectId, statementId]);
  await client.unsafe("analyze synthesis_revisions");
  await client.unsafe("analyze synthesis_revision_supports");

  const compact = await measure(sink, () => reads.getSynthesisHistorySummaries(projectId, statementId));
  assert(compact.value, "Synthesis history summary failed at " + requestedRevisions + " revisions.");
  assert(compact.selectCount === 2, "Synthesis history query count changed at " + requestedRevisions + ": " + compact.selectCount + ".");
  const legacy = await measure(sink, () => services.getSynthesisHistory(projectId, statementId));
  const equivalent = legacy.status === "completed" && legacy.value !== null
    && legacy.value.length === compact.value.length
    && legacy.value.map((revision) => revision.id).join(",") === compact.value.map((revision) => revision.id).join(",")
    && legacy.value.map((revision) => revision.supports.map((support) => support.extractionRevisionId).join(",")).join("|")
      === compact.value.map((revision) => revision.supports.map((support) => support.extractionRevisionId).join(",")).join("|");
  if (legacy.status === "completed") assert(equivalent, "Synthesis history differs from its legacy projection at " + requestedRevisions + " revisions.");
  const prepContexts = await measure(sink, () => reads.getSynthesisPreparationContextsForRevisions(projectId, compact.value!.map((revision) => revision.id)));
  assert(prepContexts.status === "completed" && prepContexts.selectCount === 1, "Bulk preparation contexts failed the one-SELECT contract at " + requestedRevisions + ".");
  const historyQueries = compact.queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
  const plans = await Promise.all(historyQueries.map((query, index) => explain(client, "history." + requestedRevisions + "." + (index === 0 ? "revisions" : "supports"), query)));
  const result = {
    requestedRevisions,
    legacyHistory: { status: legacy.status, wallTimeMs: legacy.wallTimeMs, statementCount: legacy.statementCount, selectCount: legacy.selectCount, materializedRevisions: legacy.value?.length ?? null, payloadBytes: legacy.payloadBytes, error: legacy.error },
    compactHistory: { wallTimeMs: compact.wallTimeMs, statementCount: compact.statementCount, selectCount: compact.selectCount, materializedRevisions: compact.value.length, materializedSupports: compact.value.reduce((count, revision) => count + revision.supports.length, 0), payloadBytes: compact.payloadBytes },
    bulkPreparationContexts: { wallTimeMs: prepContexts.wallTimeMs, statementCount: prepContexts.statementCount, selectCount: prepContexts.selectCount, materializedRows: prepContexts.value?.length ?? 0, payloadBytes: prepContexts.payloadBytes },
    equivalent,
    plans,
  };
  legacy.value = null;
  compact.value = null;
  prepContexts.value = null;
  return result;
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = "litreview_synthesis_read_" + process.pid + "_" + Date.now() + "_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = "/" + databaseName;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  const sink: QuerySink = { queries: [] };
  let created = false;
  let client: postgres.Sql | undefined;
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
    client = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const readDb = captureQueries(client, sink);
    const services = createReviewServices(readDb);
    const reads = createSynthesisReadServices(readDb);
    await client.unsafe("set statement_timeout = '" + SEED_STATEMENT_TIMEOUT_MS + "ms'");
    console.log(JSON.stringify({
      benchmark: "Slice 40 ordinary Synthesis read paths",
      postgresVersion: 16,
      populationSizes: POPULATION_SIZES,
      historySizes: HISTORY_SIZES,
      editContextSizes: EDIT_CONTEXT_SIZES,
      pageSize: PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      seedStatementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      note: "Synthetic data lives only in a unique migrated database that is force-dropped in finally. Timings are diagnostics, not pass/fail thresholds.",
    }));

    const populations = [];
    for (const size of POPULATION_SIZES) {
      const result = await benchmarkPopulation({ client, sink, services, reads, size });
      populations.push(result);
      console.log(JSON.stringify({ populationScenario: { requestedPapers: size, matrix: result.matrix, ledger: result.ledger } }));
    }

    const largest = populations[populations.length - 1];
    const editScenarios = [];
    for (const size of EDIT_CONTEXT_SIZES) {
      const measurement = await measure(sink, () => reads.getSynthesisRevisionEditContext(largest.projectId, largest.editTargets.slice(0, size)));
      assert(measurement.status === "completed" && measurement.selectCount === 1, "Edit context query count changed at " + size + ": " + measurement.selectCount + ".");
      const result: Record<string, unknown> = {
        requestedTargets: size,
        wallTimeMs: measurement.wallTimeMs,
        statementCount: measurement.statementCount,
        selectCount: measurement.selectCount,
        materializedRows: measurement.value?.length ?? 0,
        payloadBytes: measurement.payloadBytes,
        allFinallyIncluded: measurement.value?.every((context) => context.finalEligibility === "included") ?? false,
      };
      if (size === Math.max(...EDIT_CONTEXT_SIZES)) {
        const query = measurement.queries.find(({ query: text }) => /^(with|select)\b/i.test(text.trim()));
        if (query) result.plans = [await explain(client, "edit-context." + size, query)];
      }
      editScenarios.push(result);
      console.log(JSON.stringify({ editContextScenario: result }));
    }

    const anchor = largest.editTargets[0];
    const historyResults = [];
    for (const requestedRevisions of HISTORY_SIZES) {
      const history = await benchmarkHistory({ client, sink, services, reads, projectId: largest.projectId, extractionRevisionId: anchor.extractionRevisionId, requestedRevisions });
      historyResults.push(history);
      console.log(JSON.stringify({ historyScenario: history }));
    }
    console.log(JSON.stringify({
      benchmarkSummary: {
        populationCount: populations.length,
        historyCount: historyResults.length,
        editContextCount: editScenarios.length,
        matrixLedgerEquivalence: populations.map((population) => ({
          papers: population.matrix.requestedPapers,
          matrix: population.matrix.matrixEquivalent,
          summary: population.matrix.matrixCountsEquivalent,
          statements: population.ledger.requestedStatements,
          ledger: population.ledger.ledgerEquivalent,
        })),
        editScenarios,
        historyResults,
      },
    }));
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
