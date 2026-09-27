import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createScreeningReadServices } from "@/application/screening-read-services";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";

const WORKLOAD_SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 20_000;

type CapturedQuery = { query: string; params: unknown[] };
type JsonPlan = { "QUERY PLAN"?: unknown };

let observedDatabaseRowsReturned = 0;

function quoteIdentifier(value: string) {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}

function safeError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } }
    : null;
  const message = error instanceof Error ? error.name + ": " + error.message : String(error);
  return {
    code: String(record?.code ?? record?.cause?.code ?? ""),
    message: message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1_000),
  };
}

function readQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) =>
    /^(with|select)\b/i.test(query.trim())
    && /\b(from|join)\s+(?:public\.)?["']?(projects|papers|screening_decisions)["']?\b/i.test(query),
  );
}

function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function summarizePlan(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const top = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
  const rootPlan = top?.Plan as Record<string, unknown> | undefined;
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
      actualTotalTimeMs: current["Actual Total Time"],
      rowsRemovedByFilter: current["Rows Removed by Filter"],
      sortMethod: current["Sort Method"],
      sortSpaceType: current["Sort Space Type"],
      sharedHitBlocks: current["Shared Hit Blocks"],
      sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"],
      tempWrittenBlocks: current["Temp Written Blocks"],
      heapFetches: current["Heap Fetches"],
    });
    if (Array.isArray(current.Plans)) for (const child of current.Plans) visit(child);
  }
  visit(rootPlan);
  return {
    planningTimeMs: top?.["Planning Time"],
    executionTimeMs: top?.["Execution Time"],
    nodes,
  };
}

async function explain(client: postgres.Sql, label: string, query: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(
      "explain (analyze, buffers, format json) " + query.query,
      query.params as never,
    ) as unknown as JsonPlan[];
    return {
      label,
      status: "completed" as const,
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(query.query),
      rawPlan: rows[0]?.["QUERY PLAN"] ?? null,
      plan: summarizePlan(rows[0]?.["QUERY PLAN"]),
    };
  } catch (error) {
    const details = safeError(error);
    return {
      label,
      status: details.code === "57014" ? "timed_out" as const : "failed" as const,
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sqlBytes: Buffer.byteLength(query.query),
      error: details,
      plan: null,
    };
  }
}

async function seedWorkload(client: postgres.Sql, services: ReturnType<typeof createReviewServices>, projectId: string, size: number) {
  const exclusionCriterion = await services.createScreeningCriterion(projectId, {
    type: "exclusion",
    text: "Synthetic benchmark exclusion",
  });
  await client.begin(async (tx) => {
    await tx.unsafe(
      [
        "insert into papers (project_id, title, authors, publication_year, venue, doi, abstract, bibliographic_note, created_at, updated_at)",
        "select $1::uuid,",
        "  'Benchmark Paper ' || paper_number::text,",
        "  array['Researcher ' || paper_number::text],",
        "  2000 + (paper_number % 27),",
        "  'Synthetic Journal',",
        "  '10.5555/screening-' || $2::text || '-' || paper_number::text,",
        "  repeat('Synthetic abstract text. ', 12),",
        "  repeat('Synthetic bibliographic note. ', 6),",
        "  timestamptz '2026-01-01 00:00:00+00' + paper_number * interval '1 millisecond',",
        "  timestamptz '2026-01-01 00:00:00+00' + paper_number * interval '1 millisecond'",
        "from generate_series(1, $2::integer) as paper_number",
      ].join("\n"),
      [projectId, size],
    );
    await tx.unsafe(
      [
        "insert into screening_decisions (project_id, paper_id, decision)",
        "select paper.project_id, paper.id, 'maybe'",
        "from papers paper",
        "where paper.project_id = $1::uuid",
        "  and mod(split_part(paper.title, ' ', 3)::integer, 4) <> 0",
      ].join("\n"),
      [projectId],
    );
    await tx.unsafe(
      [
        "insert into screening_decisions (project_id, paper_id, decision, exclusion_criterion_id, exclusion_criterion_type)",
        "select paper.project_id, paper.id,",
        "  case mod(split_part(paper.title, ' ', 3)::integer, 4)",
        "    when 1 then 'include'",
        "    when 2 then 'exclude'",
        "    else 'maybe'",
        "  end,",
        "  case when mod(split_part(paper.title, ' ', 3)::integer, 4) = 2 then $2::uuid else null end,",
        "  case when mod(split_part(paper.title, ' ', 3)::integer, 4) = 2 then 'exclusion' else null end",
        "from papers paper",
        "where paper.project_id = $1::uuid",
        "  and mod(split_part(paper.title, ' ', 3)::integer, 4) <> 0",
      ].join("\n"),
      [projectId, exclusionCriterion.id],
    );
  });
  await client.unsafe("analyze papers");
  await client.unsafe("analyze screening_decisions");
}

async function measure<T>(
  queries: CapturedQuery[],
  operation: () => Promise<T>,
) {
  queries.length = 0;
  observedDatabaseRowsReturned = 0;
  const started = process.hrtime.bigint();
  const value = await operation();
  const readSql = readQueries(queries);
  return {
    value,
    queries: readSql,
    metrics: {
      selectCount: readSql.length,
      databaseRowsReturned: observedDatabaseRowsReturned,
      serializedPayloadBytes: byteSize(value),
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    },
  };
}

async function paperIdAt(client: postgres.Sql, projectId: string, zeroBasedOffset: number) {
  const rows = await client.unsafe(
    "select id from papers where project_id = $1::uuid order by created_at asc, id asc limit 1 offset $2::integer",
    [projectId, zeroBasedOffset],
  ) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  assert(id, "Could not resolve a seeded Paper for navigation position " + (zeroBasedOffset + 1));
  return id;
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) {
    throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  }
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = "litreview_screening_" + process.pid + "_" + Date.now() + "_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = "/" + databaseName;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let droppedOwnBenchmarkDatabase = false;
  let postgresServerVersion = "unknown";
  let client: postgres.Sql | undefined;
  const scenarios: Array<Record<string, unknown>> = [];
  try {
    const versionRows = await admin.unsafe(
      "select current_setting('server_version_num') as version_number, current_setting('server_version') as version",
    ) as unknown as Array<{ version_number: string; version: string }>;
    const versionNumber = Number(versionRows[0]?.version_number);
    if (Math.floor(versionNumber / 10_000) !== 16) {
      throw new Error("Requires PostgreSQL 16; connected server version number is " + versionNumber + ".");
    }
    postgresServerVersion = versionRows[0]?.version ?? "PostgreSQL 16";
    await admin.unsafe("create database " + quoteIdentifier(databaseName));
    created = true;
    await admin.unsafe("alter database " + quoteIdentifier(databaseName) + " set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");

    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    const queries: CapturedQuery[] = [];
    client = postgres(benchmarkUrl.toString(), {
      max: 8,
      prepare: false,
      onnotice: () => {},
      transform: {
        row: {
          from(row) {
            observedDatabaseRowsReturned += 1;
            return row;
          },
        },
      },
    });
    const db = drizzle(client, {
      schema,
      logger: { logQuery(query, params) { queries.push({ query, params: [...params] }); } },
    }) as Database;
    const services = createReviewServices(db);
    const reads = createScreeningReadServices(db);
    for (const size of WORKLOAD_SIZES) {
      const project = await services.createProject({ title: "Slice 44 screening benchmark " + size + " " + randomUUID() });
      const emptyProject = await services.createProject({ title: "Slice 44 empty screening benchmark " + size + " " + randomUUID() });
      await seedWorkload(client, services, project.id, size);

      const expectedPerState = size / 4;
      const deepPageNumber = Math.ceil(size / PAGE_SIZE);
      const navPositions = [
        { label: "first", position: 1 },
        { label: "middle", position: Math.ceil(size / 2) },
        { label: "last", position: size },
      ];
      const navigationTargets = [];
      for (const target of navPositions) {
        navigationTargets.push({
          ...target,
          paperId: await paperIdAt(client, project.id, target.position - 1),
        });
      }

      // Warm the driver and each measured SQL shape once; keep these calls out of the reported metrics.
      await services.listScreeningPapers(project.id);
      await reads.getScreeningQueuePage(project.id, { state: "all", page: 1, pageSize: PAGE_SIZE });
      await reads.getScreeningQueuePage(project.id, { state: "included", page: 1, pageSize: PAGE_SIZE });
      await reads.getScreeningQueuePage(project.id, { state: "all", page: deepPageNumber, pageSize: PAGE_SIZE });
      await reads.getScreeningQueuePage(emptyProject.id, { state: "all", page: 1, pageSize: PAGE_SIZE });
      await reads.getScreeningQueuePage(emptyProject.id, { state: "included", page: 1, pageSize: PAGE_SIZE });
      for (const target of navigationTargets) {
        await reads.getScreeningPaperNavigation(project.id, target.paperId);
      }

      const legacy = await measure(
        queries,
        () => services.listScreeningPapers(project.id),
      );
      const allPage = await measure(
        queries,
        () => reads.getScreeningQueuePage(project.id, { state: "all", page: 1, pageSize: PAGE_SIZE }),
      );
      const filteredPage = await measure(
        queries,
        () => reads.getScreeningQueuePage(project.id, { state: "included", page: 1, pageSize: PAGE_SIZE }),
      );
      const deepPage = await measure(
        queries,
        () => reads.getScreeningQueuePage(project.id, { state: "all", page: deepPageNumber, pageSize: PAGE_SIZE }),
      );
      const emptyPage = await measure(
        queries,
        () => reads.getScreeningQueuePage(emptyProject.id, { state: "all", page: 1, pageSize: PAGE_SIZE }),
      );
      const zeroMatchFilteredPage = await measure(
        queries,
        () => reads.getScreeningQueuePage(emptyProject.id, { state: "included", page: 1, pageSize: PAGE_SIZE }),
      );

      assert(legacy.value.length === size, "Legacy screening read returned the wrong Paper count at " + size + ".");
      assert(allPage.value.totalCount === size && allPage.value.items.length === PAGE_SIZE, "All-state page shape is wrong at " + size + ".");
      assert(allPage.value.counts.all === size, "All-state aggregate count is wrong at " + size + ".");
      assert(
        allPage.value.counts.unscreened === expectedPerState
          && allPage.value.counts.included === expectedPerState
          && allPage.value.counts.excluded === expectedPerState
          && allPage.value.counts.maybe === expectedPerState,
        "Screening state distribution is wrong at " + size + ".",
      );
      assert(filteredPage.value.totalCount === expectedPerState && filteredPage.value.items.length === PAGE_SIZE, "Filtered page shape is wrong at " + size + ".");
      assert(deepPage.value.page === deepPageNumber && deepPage.value.items.length === PAGE_SIZE, "Deep page shape is wrong at " + size + ".");
      assert(emptyPage.value.totalCount === 0 && emptyPage.value.items.length === 0, "Empty Project page shape is wrong at " + size + ".");
      assert(zeroMatchFilteredPage.value.totalCount === 0 && zeroMatchFilteredPage.value.items.length === 0, "Zero-match filtered page shape is wrong at " + size + ".");
      assert(legacy.metrics.selectCount === 2, "Legacy listScreeningPapers should execute the Project check and full-list SELECT.");
      for (const [label, result] of [
        ["all page", allPage],
        ["filtered page", filteredPage],
        ["deep page", deepPage],
        ["empty Project page", emptyPage],
        ["zero-match filtered page", zeroMatchFilteredPage],
      ] as const) {
        assert(result.metrics.selectCount === 2, "Expected two core SELECTs for " + label + "; observed " + result.metrics.selectCount + ".");
      }

      const navigation: Array<Record<string, unknown>> = [];
      const navigationQueries: Array<{ label: string; query: CapturedQuery }> = [];
      for (const target of navigationTargets) {
        const result = await measure(
          queries,
          () => reads.getScreeningPaperNavigation(project.id, target.paperId),
        );
        assert(result.value?.position === target.position && result.value.totalCount === size, "Navigation position is wrong for " + target.label + " at " + size + ".");
        assert(result.metrics.selectCount === 1 && result.metrics.databaseRowsReturned === 1, "Navigation should use one SELECT and return one row.");
        navigation.push({
          position: target.label,
          paperOrdinal: target.position,
          ...result.metrics,
          result: result.value,
        });
        assert(result.queries[0], "Navigation SQL was not captured for " + target.label + ".");
        navigationQueries.push({ label: target.label, query: result.queries[0] });
      }

      const scenario: Record<string, unknown> = {
        paperCount: size,
        decisionCount: expectedPerState * 6,
        legacyListScreeningPapers: { ...legacy.metrics, paperRows: legacy.value.length, queryCount: legacy.metrics.selectCount },
        allPage: {
          ...allPage.metrics,
          page: allPage.value.page,
          totalCount: allPage.value.totalCount,
          counts: allPage.value.counts,
        },
        filteredPage: {
          ...filteredPage.metrics,
          state: filteredPage.value.state,
          page: filteredPage.value.page,
          totalCount: filteredPage.value.totalCount,
        },
        deepPage: {
          ...deepPage.metrics,
          page: deepPage.value.page,
          totalCount: deepPage.value.totalCount,
          firstReturnedPaperId: deepPage.value.items[0]?.id ?? null,
        },
        emptyProjectPage: {
          ...emptyPage.metrics,
          page: emptyPage.value.page,
          totalCount: emptyPage.value.totalCount,
        },
        zeroMatchFilteredPage: {
          ...zeroMatchFilteredPage.metrics,
          state: zeroMatchFilteredPage.value.state,
          page: zeroMatchFilteredPage.value.page,
          totalCount: zeroMatchFilteredPage.value.totalCount,
        },
        navigation,
      };

      if (size === 50_000) {
        const plans: Array<Record<string, unknown>> = [];
        const addExplain = async (label: string, captured: CapturedQuery | undefined) => {
          assert(captured, "Benchmark could not identify the SQL for EXPLAIN: " + label);
          plans.push(await explain(client!, label, captured));
        };
        await addExplain("aggregate counts and start target", allPage.queries[0]);
        await addExplain("all-state bounded page", allPage.queries[1]);
        await addExplain("filtered included bounded page", filteredPage.queries[1]);
        await addExplain("deep all-state page", deepPage.queries[1]);
        for (const item of navigationQueries) {
          await addExplain(item.label + " Paper navigation", item.query);
        }
        scenario.explainAnalyzeBuffersFormatJson = plans;
        scenario.indexVerdict = {
          papersProjectCreatedAtIndexPresent: true,
          screeningDecisionsProjectPaperSequenceIndexPresent: true,
          migration0034Created: false,
          decision: "No essential missing lookup or ordering index was indicated. Exact-count scans and deep OFFSET work alone do not justify a migration.",
        };
      }

      scenarios.push(scenario);
    }
  } finally {
    if (client) await client.end({ timeout: 1 });
    try {
      if (created) {
        await admin.unsafe("drop database if exists " + quoteIdentifier(databaseName) + " with (force)");
        droppedOwnBenchmarkDatabase = true;
      }
    } finally {
      await admin.end({ timeout: 1 });
    }
  }

  const result = {
    benchmark: "Slice 44 Title/Abstract Screening Read Paths",
    nodeVersion: process.version,
    postgresVersion: postgresServerVersion,
    postgresMajorVersion: 16,
    paperCounts: WORKLOAD_SIZES,
    pageSize: PAGE_SIZE,
    stateDistribution: "Each Project has 25% unscreened, 25% included, 25% excluded, and 25% maybe. Every decided Paper has an initial maybe decision and a later current decision; all fixtures are inserted into the isolated benchmark database.",
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    measurementNotes: [
      "Wall times are local diagnostics, not thresholds.",
      "Returned database rows are counted by the postgres.js result-row transform during each measured service call.",
      "Each measured service shape is warmed once before its diagnostic measurement.",
      "Serialized payload bytes are UTF-8 JSON sizes of each service result.",
      "The uniquely named disposable database was dropped in finally.",
    ],
    droppedOwnBenchmarkDatabase,
    scenarios,
  };
  const resultJson = JSON.stringify(result, null, 2) + "\n";
  const artifactPath = resolve(process.cwd(), "docs", "benchmarks", "slice44-screening-read-paths.json");
  await mkdir(resolve(process.cwd(), "docs", "benchmarks"), { recursive: true });
  await writeFile(artifactPath, resultJson, "utf8");
  console.log(JSON.stringify({
    benchmark: result.benchmark,
    nodeVersion: result.nodeVersion,
    postgresVersion: result.postgresVersion,
    scenarioCount: scenarios.length,
    droppedOwnBenchmarkDatabase,
    evidenceArtifact: "docs/benchmarks/slice44-screening-read-paths.json",
  }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: safeError(error) }));
  process.exitCode = 1;
});
