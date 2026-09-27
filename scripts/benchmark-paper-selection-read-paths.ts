import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createPaperSelectionReadServices } from "@/application/paper-selection-read-services";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";

const WORKLOAD_SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 20;
const ROUTE_PICKER_COUNTS = [1, 50] as const;
const REFERENCED_PAPER_COUNT = 100;
const STATEMENT_TIMEOUT_MS = 20_000;

type CapturedQuery = { query: string; params: unknown[] };
type JsonPlan = { "QUERY PLAN"?: unknown };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } }
    : null;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    code: String(record?.code ?? record?.cause?.code ?? ""),
    message: message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1_000),
  };
}

function selectQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function summarizePlan(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const root = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
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
      sortMethod: current["Sort Method"],
      sharedHitBlocks: current["Shared Hit Blocks"],
      sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"],
      tempWrittenBlocks: current["Temp Written Blocks"],
    });
    if (Array.isArray(current.Plans)) for (const child of current.Plans) visit(child);
  }
  visit(rootPlan);
  return { planningTimeMs: root?.["Planning Time"], executionTimeMs: root?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, label: string, query: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(`explain (analyze, buffers, format json) ${query.query}`, query.params as never) as unknown as JsonPlan[];
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
      status: safeError(error).code === "57014" ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(query.query),
      error: safeError(error),
      plan: null,
    };
  }
}

async function seedWorkload(client: postgres.Sql, projectId: string, size: number) {
  await client`
    insert into papers (
      project_id, title, authors, publication_year, venue, doi, abstract, bibliographic_note, created_at, updated_at
    )
    select ${projectId}::uuid,
      'Benchmark Paper ' || paper_number::text,
      array['Researcher ' || paper_number::text],
      2000 + (paper_number % 27),
      'Synthetic Journal',
      '10.5555/paper-selection-' || ${size}::text || '-' || paper_number::text,
      repeat('Synthetic abstract text. ', 12),
      repeat('Synthetic bibliographic note. ', 6),
      timestamptz '2026-01-01 00:00:00+00' + paper_number * interval '1 millisecond',
      timestamptz '2026-01-01 00:00:00+00' + paper_number * interval '1 millisecond'
    from generate_series(1, ${size}) as paper_number
  `;
  await client.unsafe("analyze papers");
}

async function measure<T>(queries: CapturedQuery[], operation: () => Promise<T>, returnedRows: (value: T) => number) {
  queries.length = 0;
  const started = process.hrtime.bigint();
  const value = await operation();
  const captured = [...queries];
  const coreQueries = captured.filter(({ query }) => /\b(from|join)\s+(?:public\.)?["']?(?:projects|papers)["']?/i.test(query));
  return {
    value,
    measurement: {
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: coreQueries.length,
      selectCount: selectQueries(coreQueries).length,
      auxiliaryDriverStatements: captured.length - coreQueries.length,
      databaseRowsReturned: returnedRows(value),
      serializedPayloadBytes: byteSize(value),
      queries: coreQueries,
    },
  };
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_paper_selection_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; connected server version number is ${versionNumber}.`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;
    await admin.unsafe(`alter database ${quoteIdentifier(databaseName)} set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    const queries: CapturedQuery[] = [];
    client = postgres(benchmarkUrl.toString(), { max: 8, prepare: false, onnotice: () => {} });
    const db = drizzle(client, {
      schema,
      logger: { logQuery(query, params) { queries.push({ query, params: [...params] }); } },
    }) as Database;
    const services = createReviewServices(db);
    const reads = createPaperSelectionReadServices(db);
    console.log(JSON.stringify({
      benchmark: "Slice 43 Scalable Canonical Paper Selection",
      postgresVersion: 16,
      paperCounts: WORKLOAD_SIZES,
      pageSize: PAGE_SIZE,
      referencedPaperCount: REFERENCED_PAPER_COUNT,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      note: "Measurements are diagnostic and have no latency threshold. Each workload is generated only in a uniquely named disposable database that is dropped in finally.",
    }));

    const scenarios: Array<Record<string, unknown>> = [];
    for (const size of WORKLOAD_SIZES) {
      const project = await services.createProject({ title: `Slice 43 Paper selection benchmark ${size} ${randomUUID()}` });
      await seedWorkload(client, project.id, size);
      const paperIds = await client.unsafe(
        "select id from papers where project_id=$1 order by created_at desc, id desc limit $2",
        [project.id, REFERENCED_PAPER_COUNT],
      ) as unknown as Array<{ id: string }>;
      const referencedIds = paperIds.map(({ id }) => id);
      const exactId = referencedIds[0];
      if (!exactId) throw new Error(`Benchmark workload of ${size} Papers produced no referenced Paper IDs.`);

      const legacyResult = await measure(queries, () => services.listPapers(project.id), (value) => value.length);
      const emptySearchResult = await measure(queries, () => reads.searchPaperOptions({ projectId: project.id }), (value) => 1 + value.items.length);
      const titleSearchResult = await measure(queries, () => reads.searchPaperOptions({ projectId: project.id, query: `Benchmark Paper ${size}` }), (value) => 1 + value.items.length);
      const exactResult = await measure(queries, () => reads.getPaperOption(project.id, exactId), (value) => value ? 1 : 0);
      const batchResult = await measure(queries, () => reads.getPaperOptionsByIds(project.id, referencedIds), (value) => value.length);

      const legacy = legacyResult.measurement;
      const emptySearch = emptySearchResult.measurement;
      const titleSearch = titleSearchResult.measurement;
      const exact = exactResult.measurement;
      const batch = batchResult.measurement;
      const routeAmplification = ROUTE_PICKER_COUNTS.map((selectorCount) => ({
        renderedPickers: selectorCount,
        legacyCollectionReads: 1,
        legacyRenderedOptionElements: size * selectorCount,
        lazyInitialRenderedOptionElements: 0,
        lazyActivatedRenderedOptionElements: PAGE_SIZE * selectorCount,
        defaultResultPageSizePerPicker: PAGE_SIZE,
      }));
      const routeAmplificationSummary = `Legacy 50-selector aggregate: ${formatCount(size * 50)} rendered option elements from one ${formatCount(size)}-Paper collection read. Lazy initial aggregate: 0. Lazy aggregate after explicitly activating all 50 pickers: at most ${formatCount(PAGE_SIZE * 50)} option elements at the default ${formatCount(PAGE_SIZE)}-result page size.`;

      let plans: unknown[] = [];
      if (size === 50_000) {
        const countQuery = emptySearch.queries.find(({ query }) => /^select project\.id/i.test(query.trim()));
        const pageQuery = emptySearch.queries.find(({ query }) => /from papers paper/i.test(query) && /order by paper\.created_at desc, paper\.id desc/i.test(query));
        const exactQuery = exact.queries[0];
        const batchQuery = batch.queries[0];
        plans = [
          ...(countQuery ? [await explain(client, "empty-query count", countQuery)] : []),
          ...(pageQuery ? [await explain(client, "bounded Paper page", pageQuery)] : []),
          ...(exactQuery ? [await explain(client, "exact Paper lookup", exactQuery)] : []),
          ...(batchQuery ? [await explain(client, "batch Paper lookup", batchQuery)] : []),
        ];
      }

      const scenario = {
        paperCount: size,
        legacyList: { ...legacy, databaseRowsReturned: size, queries: undefined },
        emptyQuerySearch: { ...emptySearch, queries: undefined },
        titleQuerySearch: { ...titleSearch, queries: undefined },
        exactLookup: { ...exact, queries: undefined },
        referencedIdBatch: { ...batch, queries: undefined },
        routeAmplification,
        routeAmplificationSummary,
        explain: plans,
        migration0034Created: false,
      };
      scenarios.push(scenario);
      console.log(JSON.stringify({ scenario }));
    }
    console.log(JSON.stringify({ benchmarkSummary: { scenarioCount: scenarios.length, scenarios } }));
  } finally {
    if (client) await client.end({ timeout: 1 });
    try {
      if (created) {
        await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
        console.log(JSON.stringify({ phase: "cleanup-complete", droppedOwnBenchmarkDatabase: true }));
      }
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: safeError(error) }));
  process.exitCode = 1;
});
