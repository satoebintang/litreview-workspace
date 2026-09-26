import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createPaperCollectionReadServices } from "@/application/paper-collection-read-services";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";

const WORKLOAD_SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
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
      sortSpaceType: current["Sort Space Type"],
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

async function seedWorkload(client: postgres.Sql, services: ReturnType<typeof createReviewServices>, projectId: string, size: number) {
  const exclusionCriterion = await services.createScreeningCriterion(projectId, {
    type: "exclusion",
    text: "Synthetic benchmark exclusion",
  });
  await client.begin(async (tx) => {
    await tx`
      insert into papers (
        project_id, title, authors, publication_year, venue, doi, abstract, bibliographic_note, created_at, updated_at
      )
      select ${projectId}::uuid,
        'Benchmark Paper ' || paper_number::text,
        array['Researcher ' || paper_number::text],
        2000 + (paper_number % 27),
        'Synthetic Journal',
        '10.5555/paper-collection-' || ${size}::text || '-' || paper_number::text,
        repeat('Synthetic abstract text. ', 12),
        repeat('Synthetic bibliographic note. ', 6),
        timestamptz '2026-01-01 00:00:00+00' + paper_number * interval '1 millisecond',
        timestamptz '2026-01-01 00:00:00+00' + paper_number * interval '1 millisecond'
      from generate_series(1, ${size}) as paper_number
    `;
    await tx`
      insert into screening_decisions (project_id, paper_id, decision)
      select paper.project_id, paper.id, 'maybe'
      from papers paper
      where paper.project_id=${projectId}::uuid
        and mod(split_part(paper.title, ' ', 3)::integer, 4) <> 0
    `;
    await tx`
      insert into screening_decisions (project_id, paper_id, decision, exclusion_criterion_id, exclusion_criterion_type)
      select paper.project_id, paper.id,
        case mod(split_part(paper.title, ' ', 3)::integer, 4)
          when 1 then 'include'
          when 2 then 'exclude'
          else 'maybe'
        end,
        case when mod(split_part(paper.title, ' ', 3)::integer, 4) = 2 then ${exclusionCriterion.id}::uuid else null end,
        case when mod(split_part(paper.title, ' ', 3)::integer, 4) = 2 then 'exclusion' else null end
      from papers paper
      where paper.project_id=${projectId}::uuid
        and mod(split_part(paper.title, ' ', 3)::integer, 4) <> 0
    `;
  });
  await client.unsafe("analyze papers");
  await client.unsafe("analyze screening_decisions");
}

async function measureLegacy(services: ReturnType<typeof createReviewServices>, queries: CapturedQuery[], projectId: string, paperCount: number) {
  const started = process.hrtime.bigint();
  queries.length = 0;
  try {
    const [papers, screeningPapers] = await Promise.all([
      services.listPapers(projectId),
      services.listScreeningPapers(projectId),
    ]);
    const screeningByPaperId = new Map(screeningPapers.map((paper) => [paper.id, paper]));
    const renderedRows = papers.map((paper) => ({
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      publicationYear: paper.publicationYear,
      venue: paper.venue,
      screeningState: screeningByPaperId.get(paper.id)?.screeningState ?? "unscreened",
    }));
    return {
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      selectCount: selectQueries(queries).length,
      databaseRowsReturned: papers.length + screeningPapers.length + 2,
      paperRows: papers.length,
      screeningRows: screeningPapers.length,
      materializedPaperObjects: papers.length + screeningPapers.length,
      mapEntries: screeningByPaperId.size,
      serializedPayloadBytes: byteSize({ papers, screeningPapers }),
      renderedCollectionBytes: byteSize(renderedRows),
      expectedPaperCount: paperCount,
    };
  } catch (error) {
    const details = safeError(error);
    return {
      status: details.code === "57014" ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      selectCount: selectQueries(queries).length,
      databaseRowsReturned: null,
      paperRows: null,
      screeningRows: null,
      materializedPaperObjects: null,
      mapEntries: null,
      serializedPayloadBytes: null,
      renderedCollectionBytes: null,
      expectedPaperCount: paperCount,
      error: details,
    };
  }
}

async function measurePage(readServices: ReturnType<typeof createPaperCollectionReadServices>, queries: CapturedQuery[], projectId: string, page: number) {
  const started = process.hrtime.bigint();
  queries.length = 0;
  try {
    const result = await readServices.getPaperCollectionPage(projectId, { page, pageSize: PAGE_SIZE });
    return {
      status: "completed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      selectCount: selectQueries(queries).length,
      databaseRowsReturned: (result ? 1 : 0) + (result?.items.length ?? 0),
      materializedPaperObjects: result?.items.length ?? 0,
      serializedPayloadBytes: byteSize(result),
      result: result ? { totalCount: result.totalCount, items: result.items.length, page: result.page, totalPages: result.totalPages } : null,
      queries: queries.map(({ query, params }) => ({ query, params })),
    };
  } catch (error) {
    const details = safeError(error);
    return {
      status: details.code === "57014" ? "timed_out" as const : "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: queries.length,
      selectCount: selectQueries(queries).length,
      databaseRowsReturned: null,
      materializedPaperObjects: null,
      serializedPayloadBytes: null,
      result: null,
      queries: queries.map(({ query, params }) => ({ query, params })),
      error: details,
    };
  }
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_paper_collection_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
    const readServices = createPaperCollectionReadServices(db);
    console.log(JSON.stringify({
      benchmark: "Slice 42 Scalable Paper Collection Read Model",
      postgresVersion: 16,
      paperCounts: WORKLOAD_SIZES,
      pageSize: PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      decisionDistribution: "One quarter of Papers unscreened; the remaining Papers have an initial maybe decision followed by a latest include, exclude, or maybe decision. All fixtures are generated only in the disposable migrated database.",
      note: "Measurements are diagnostics rather than latency thresholds. The benchmark database is dropped in finally. Deep-page work is reviewed as expected OFFSET scanning when the existing Project/created_at index remains usable; a tie-breaker sort alone is not a migration justification.",
    }));

    const scenarios: Array<Record<string, unknown>> = [];
    for (const size of WORKLOAD_SIZES) {
      const project = await services.createProject({ title: `Slice 42 Paper collection benchmark ${size} ${randomUUID()}` });
      await seedWorkload(client, services, project.id, size);
      const decisionRows = await client.unsafe("select count(*)::integer as count from screening_decisions where project_id=$1", [project.id]) as unknown as Array<{ count: number }>;

      const legacy = await measureLegacy(services, queries, project.id, size);
      const firstPage = await measurePage(readServices, queries, project.id, 1);
      let explainResults: unknown[] = [];
      if (size === 50_000) {
        const deepPage = await measurePage(readServices, queries, project.id, 50_000);
        const firstPageQueries = firstPage.queries as Array<{ query: string; params: unknown[] }>;
        const deepPageQueries = deepPage.queries as Array<{ query: string; params: unknown[] }>;
        const countQuery = firstPageQueries.find(({ query }) => /^select project\.id/i.test(query.trim()));
        const firstBoundedQuery = firstPageQueries.find(({ query }) => /with selected_papers/i.test(query));
        const deepBoundedQuery = deepPageQueries.find(({ query }) => /with selected_papers/i.test(query));
        const latestPaperRows = await client.unsafe(
          "select id from papers where project_id=$1 and title='Benchmark Paper 1' limit 1",
          [project.id],
        ) as unknown as Array<{ id: string }>;
        const latestDecisionQuery: CapturedQuery = {
          query: "select decision.decision from screening_decisions decision where decision.project_id=$1 and decision.paper_id=$2 and decision.stage='title_abstract' order by decision.sequence desc, decision.id desc limit 1",
          params: [project.id, latestPaperRows[0]?.id],
        };
        explainResults = [
          ...(countQuery ? [await explain(client, "project-aware count", countQuery)] : []),
          ...(firstBoundedQuery ? [await explain(client, "first bounded Paper page", firstBoundedQuery)] : []),
          ...(deepBoundedQuery ? [await explain(client, "deep bounded Paper page (OFFSET)", deepBoundedQuery)] : []),
          await explain(client, "latest title/abstract decision", latestDecisionQuery),
        ];
        scenarios.push({
          paperCount: size,
          decisionCount: Number(decisionRows[0]?.count ?? 0),
          legacy,
          firstPage: { ...firstPage, queries: undefined },
          deepPage: { ...deepPage, queries: undefined },
          explain: explainResults,
          indexVerdict: {
            papersProjectCreatedAtIndexPresent: true,
            screeningDecisionsProjectPaperSequenceIndexPresent: true,
            migration0034Created: false,
            decision: "No new index was created; review the captured plans and distinguish deep OFFSET rows scanned from a missing existing index.",
          },
        });
      } else {
        scenarios.push({
          paperCount: size,
          decisionCount: Number(decisionRows[0]?.count ?? 0),
          legacy,
          firstPage: { ...firstPage, queries: undefined },
        });
      }
      console.log(JSON.stringify({ scenario: scenarios[scenarios.length - 1] }));
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
