import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  createExtractionEvidenceSelectionReadServices,
  type ExtractionEvidenceCandidatePage,
} from "@/application/extraction-evidence-selection-read-services";
import { encodeExtractionEvidenceCandidateCursor, hashExtractionEvidenceSearchQuery } from "@/application/extraction-evidence-selection-cursor";
import { createExtractionReadServices } from "@/application/extraction-read-services";
import { resolveDatabaseUrl } from "@/db/config";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";

const STATEMENT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_DTO_BYTES = 1024 * 1024;
const ARTIFACT = resolve("docs/benchmarks/slice57-extraction-evidence-search-read-paths.json");
const POPULATIONS = [0, 25, 1_000, 10_000, 50_000] as const;
const SEARCHES = [
  { name: "common_source", query: "common-evidence-term" },
  { name: "rare_passage_after_preview", query: "rare-passage-needle" },
  { name: "rare_note_after_preview", query: "rare-note-only-term" },
  { name: "long_unicode_source", query: "漢字🙂" },
  { name: "zero_result", query: "slice57-absent-needle" },
] as const;

type CapturedQuery = { sql: string; params: unknown[] };
type WorkloadResult = {
  population: number;
  paperId: string;
  case: string;
  query: string;
  repetitions: number;
  observations: Array<Record<string, unknown>>;
  applicationSql: string | null;
  applicationParameters: unknown[] | null;
  plan: Record<string, unknown> | null;
  expected: Record<string, unknown>;
};

const sink: { queries: CapturedQuery[] } = { queries: [] };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error: unknown) {
  const row = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : undefined;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    code: String(row?.code ?? row?.cause?.code ?? ""),
    message: message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1500),
  };
}

function stableUuid(seed: string) {
  const bytes = createHash("md5").update(seed).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function orderedEvidenceId(paperId: string, position: number) {
  const prefix = createHash("md5").update(paperId).digest("hex").slice(0, 8);
  return `${prefix}-0000-4000-8000-${String(position).padStart(12, "0")}`;
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item), "utf8");
}

function makeDatabase(client: postgres.Sql): Database {
  return drizzle(client, {
    schema,
    logger: { logQuery(query, params) { sink.queries.push({ sql: query, params: [...params] }); } },
  }) as Database;
}

function selectCount(queries: CapturedQuery[]) {
  return queries.filter(({ sql }) => /^(with|select)\b/i.test(sql.trim())).length;
}

function appKeyQuery(queries: CapturedQuery[]) {
  return queries.find(({ sql }) => /select\s+e\.id::text\s+as\s+evidence_id/i.test(sql));
}

function planSummary(value: unknown) {
  const outer = Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : undefined;
  const rawPlan = outer?.["QUERY PLAN"];
  const explain = Array.isArray(rawPlan) ? rawPlan[0] as Record<string, unknown> | undefined : undefined;
  const root = explain?.Plan as Record<string, unknown> | undefined;
  const nodes: Array<Record<string, unknown>> = [];
  const summarizeNode = (node: Record<string, unknown>): Record<string, unknown> => {
    const loops = Number(node["Actual Loops"] ?? 0);
    const rows = Number(node["Actual Rows"] ?? 0);
    const removedByFilter = Number(node["Rows Removed by Filter"] ?? 0);
    const removedByIndexRecheck = Number(node["Rows Removed by Index Recheck"] ?? 0);
    const summarized: Record<string, unknown> = {
      nodeType: node["Node Type"],
      relation: node["Relation Name"],
      index: node["Index Name"],
      actualRows: node["Actual Rows"],
      actualLoops: node["Actual Loops"],
      actualRowsAcrossLoops: rows * loops,
      rowsRemovedByFilter: node["Rows Removed by Filter"],
      rowsRemovedByFilterAcrossLoops: removedByFilter * loops,
      rowsRemovedByIndexRecheck: node["Rows Removed by Index Recheck"],
      rowsRemovedByIndexRecheckAcrossLoops: removedByIndexRecheck * loops,
      sharedHitBlocks: node["Shared Hit Blocks"],
      sharedReadBlocks: node["Shared Read Blocks"],
      sharedDirtiedBlocks: node["Shared Dirtied Blocks"],
      sharedWrittenBlocks: node["Shared Written Blocks"],
      tempReadBlocks: node["Temp Read Blocks"],
      tempWrittenBlocks: node["Temp Written Blocks"],
      sortMethod: node["Sort Method"],
      sortSpaceType: node["Sort Space Type"],
      sortSpaceUsed: node["Sort Space Used"],
      indexCondition: node["Index Cond"],
      filter: node.Filter,
      planRows: node["Plan Rows"],
      totalCost: node["Total Cost"],
      workers: Array.isArray(node.Workers) ? node.Workers.map((worker) => {
        const row = worker as Record<string, unknown>;
        return {
          workerNumber: row["Worker Number"],
          actualRows: row["Actual Rows"],
          actualLoops: row["Actual Loops"],
          rowsRemovedByFilter: row["Rows Removed by Filter"],
          rowsRemovedByIndexRecheck: row["Rows Removed by Index Recheck"],
          sharedHitBlocks: row["Shared Hit Blocks"],
          sharedReadBlocks: row["Shared Read Blocks"],
        };
      }) : [],
      children: [],
    };
    nodes.push(summarized);
    summarized.children = Array.isArray(node.Plans)
      ? node.Plans.map((child) => summarizeNode(child as Record<string, unknown>))
      : [];
    return summarized;
  };
  const planTree = root ? summarizeNode(root) : null;
  const evidenceScans = nodes.filter((node) => node.relation === "evidence" && String(node.nodeType).includes("Scan"));
  return {
    planningTimeMs: explain?.["Planning Time"],
    executionTimeMs: explain?.["Execution Time"],
    rootActualRows: root?.["Actual Rows"],
    evidenceScanRowsExaminedEstimate: evidenceScans.reduce((sum, node) => sum + Number(node.actualRowsAcrossLoops ?? 0) + Number(node.rowsRemovedByFilterAcrossLoops ?? 0), 0),
    evidenceScanRowsRemovedByFilterAcrossLoops: evidenceScans.reduce((sum, node) => sum + Number(node.rowsRemovedByFilterAcrossLoops ?? 0), 0),
    evidenceScanBufferBlocks: evidenceScans.map((node) => ({
      nodeType: node.nodeType,
      sharedHitBlocks: node.sharedHitBlocks,
      sharedReadBlocks: node.sharedReadBlocks,
      tempReadBlocks: node.tempReadBlocks,
      tempWrittenBlocks: node.tempWrittenBlocks,
    })),
    planTree,
    nodes,
  };
}

async function seedProject(client: postgres.Sql, projectId: string) {
  await client.unsafe("insert into projects (id,title) values ($1::uuid,$2::text)", [projectId, "Slice 57 search benchmark"]);
}

async function seedPaper(client: postgres.Sql, projectId: string, paperId: string, count: number) {
  await client.unsafe("insert into papers (id,project_id,title) values ($1::uuid,$2::uuid,$3::text)", [paperId, projectId, `Slice 57 ${count} record workload`]);
  await client.unsafe("insert into screening_decisions (project_id,paper_id,decision) values ($1::uuid,$2::uuid,'include')", [projectId, paperId]);
  await client.unsafe("insert into full_text_retrieval_attempts (project_id,paper_id,outcome,method,attempted_at) values ($1::uuid,$2::uuid,'retrieved','manual',now())", [projectId, paperId]);
  await client.unsafe("insert into full_text_screening_decisions (project_id,paper_id,decision) values ($1::uuid,$2::uuid,'include')", [projectId, paperId]);
  if (count === 0) return;
  await client.unsafe(`
    insert into evidence (id,project_id,paper_id,source_text,note,page_number,created_at,updated_at)
    select
      (substring(md5($1::text) from 1 for 8) || '-0000-4000-8000-' || lpad(g.n::text,12,'0'))::uuid,
      $2::uuid,$1::uuid,
      'common-evidence-term ' || repeat('x',1205) || case when g.n=1 then ' ' || repeat('漢字🙂',500) else '' end || case when g.n=$3::int then ' rare-passage-needle' else '' end,
      repeat('n',620) || case when g.n=$3::int then ' rare-note-only-term' else '' end,
      g.n,timestamptz '2026-10-01 00:00:00+00',timestamptz '2026-10-01 00:00:00+00'
    from generate_series(1,$3::int) as g(n)
  `, [paperId, projectId, count]);
}

async function seedInterleavedPapers(client: postgres.Sql, projectId: string, paperA: string, paperB: string, eachCount: number) {
  await client.unsafe(`
    insert into evidence (id,project_id,paper_id,source_text,note,page_number,created_at,updated_at)
    select
      (substring(md5((case when mod(g.n,2)=1 then $1::text else $2::text end)) from 1 for 8) || '-0000-4000-8000-' || lpad(((g.n+1)/2)::text,12,'0'))::uuid,
      $3::uuid,case when mod(g.n,2)=1 then $1::uuid else $2::uuid end,
      'common-evidence-term interleaved ' || g.n::text,
      case when mod(g.n,2)=1 then null else 'Interleaved note' end,
      ((g.n+1)/2)::int,timestamptz '2026-10-02 00:00:00+00',timestamptz '2026-10-02 00:00:00+00'
    from generate_series(1,$4::int * 2) as g(n)
  `, [paperA, paperB, projectId, eachCount]);
}

async function seedSelectedSupport(client: postgres.Sql, projectId: string, paperId: string, evidenceId: string, seed: string) {
  const fieldId = stableUuid(`${seed}:field`);
  const slotId = stableUuid(`${seed}:slot`);
  const revisionId = stableUuid(`${seed}:revision`);
  await client.unsafe(`
    insert into extraction_fields (id,project_id,name,field_type,required,sort_order)
    values ($1::uuid,$2::uuid,'Slice 57 benchmark support','short_text',false,1)
  `, [fieldId, projectId]);
  await client.unsafe("insert into extraction_values (id,project_id,paper_id,field_id) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid)", [slotId, projectId, paperId, fieldId]);
  await client.unsafe(`
    insert into extraction_value_revisions
      (id,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,created_at,finalized_at)
    values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'short_text','present','Slice 57 selected support benchmark',now(),null)
  `, [revisionId, projectId, paperId, fieldId, slotId]);
  await client.unsafe("insert into extraction_revision_evidence (project_id,paper_id,revision_id,evidence_id) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid)", [projectId, paperId, revisionId, evidenceId]);
  await client.unsafe("update extraction_value_revisions set finalized_at=created_at where project_id=$1::uuid and id=$2::uuid", [projectId, revisionId]);
  return { fieldId, slotId, revisionId, evidenceId };
}

async function timedRead(
  reads: ReturnType<typeof createExtractionEvidenceSelectionReadServices>,
  projectId: string,
  paperId: string,
  query: string,
  after: string | null = null,
  pageSize = PAGE_SIZE,
) {
  sink.queries.length = 0;
  const started = process.hrtime.bigint();
  let value: ExtractionEvidenceCandidatePage | null = null;
  let error: Record<string, string> | null = null;
  try {
    value = await reads.getPaperExtractionEvidenceCandidatePage(projectId, paperId, { pageSize, query, after });
  } catch (caught) {
    error = safeError(caught);
  }
  const queries = sink.queries.map((queryRow) => ({ ...queryRow }));
  return {
    diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    error,
    queryStatementCount: queries.length,
    selectCount: selectCount(queries),
    keyQuery: appKeyQuery(queries) ?? null,
    resultCount: value?.items.length ?? null,
    resultIds: value?.items.map((item) => item.id) ?? [],
    hasNext: value?.hasNext ?? null,
    nextCursorPresent: value?.nextCursor !== null && value?.nextCursor !== undefined,
    dtoUtf8Bytes: value ? jsonBytes(value) : null,
    sourceTextTruncated: value?.items.map((item) => item.sourceTextTruncated) ?? [],
    noteTruncated: value?.items.map((item) => item.noteTruncated) ?? [],
    setLocal15sTimeoutObserved: queries.some(({ sql }) => /set local statement_timeout\s*=\s*'15000ms'/i.test(sql)),
  };
}

async function cursorBefore(client: postgres.Sql, projectId: string, paperId: string, pageSize: number, query: string, pageStartOffset: number) {
  if (pageStartOffset <= 0) return null;
  const [row] = await client.unsafe<{ id: string; created_at: string }[]>(`
    select e.id::text as id,to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    from evidence e where e.project_id=$1::uuid and e.paper_id=$2::uuid
    order by e.created_at desc,e.id asc offset $3::int limit 1
  `, [projectId, paperId, pageStartOffset - 1]);
  if (!row) throw new Error(`No cursor anchor found before page offset ${pageStartOffset}.`);
  return encodeExtractionEvidenceCandidateCursor({
    kind: "paper-extraction-evidence-candidate",
    version: 2,
    projectId,
    paperId,
    pageSize,
    createdAt: row.created_at,
    id: row.id,
    queryHash: hashExtractionEvidenceSearchQuery(query),
  });
}

async function explainApplicationQuery(client: postgres.Sql, query: CapturedQuery, label: string) {
  const started = process.hrtime.bigint();
  try {
    const result = await client.begin(async (transaction) => {
      await transaction.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      return transaction.unsafe(`explain (analyze,buffers,format json) ${query.sql}`, query.params as never);
    });
    return {
      label,
      status: "completed",
      applicationSql: query.sql,
      applicationParameters: query.params,
      plan: planSummary(result),
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  } catch (error) {
    return {
      label,
      status: "failed",
      applicationSql: query.sql,
      applicationParameters: query.params,
      error: safeError(error),
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  }
}

async function main() {
  if (process.versions.node !== "22.13.0") throw new Error(`Requires Node 22.13.0; running ${process.versions.node}.`);
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role permitted to create and drop a uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `slice57_evidence_search_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const disposableUrl = new URL(adminUrl);
  disposableUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let databaseCreated = false;
  let cleanupVerified = false;
  let client: postgres.Sql | undefined;
  let failure: Record<string, string> | null = null;
  let serverVersion = "unknown";
  const benchmarkArtifact: Record<string, unknown> = {
    slice: 57,
    createdAt: new Date().toISOString(),
    status: "running",
    node: process.versions.node,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    pageSize: PAGE_SIZE,
    maxCandidateDtoUtf8Bytes: MAX_DTO_BYTES,
    populations: [],
    unfilteredWorkloads: [],
    searchWorkloads: [],
    pageBoundaryWorkloads: [],
    queryPlans: [],
    staticSearchTraversal: null,
    interleavedPaperTraversal: null,
    selectedSupportOutsideSearch: null,
    database: { postgresVersion: serverVersion, disposable: true },
  };
  const searchWorkloads = benchmarkArtifact.searchWorkloads as WorkloadResult[];
  const queryPlans = benchmarkArtifact.queryPlans as Array<Record<string, unknown>>;

  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version_num,current_setting('server_version') as version_text");
    serverVersion = String((versionRows[0] as { version_text: string }).version_text);
    if (Math.floor(Number((versionRows[0] as { version_num: string }).version_num) / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; found ${serverVersion}.`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const migrationClient = postgres(disposableUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    client = postgres(disposableUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await client.unsafe("set statement_timeout = '600000ms'");
    await client.unsafe("set maintenance_work_mem = '256MB'");
    await client.unsafe("set work_mem = '16MB'");
    const projectId = stableUuid(`${databaseName}:project`);
    await seedProject(client, projectId);
    const paperIds = new Map<number, string>();
    for (const count of POPULATIONS) {
      const paperId = stableUuid(`${databaseName}:paper:${count}`);
      paperIds.set(count, paperId);
      await seedPaper(client, projectId, paperId, count);
    }
    const interleavedPaperA = stableUuid(`${databaseName}:interleaved:paper-a`);
    const interleavedPaperB = stableUuid(`${databaseName}:interleaved:paper-b`);
    await seedPaper(client, projectId, interleavedPaperA, 0);
    await seedPaper(client, projectId, interleavedPaperB, 0);
    await seedInterleavedPapers(client, projectId, interleavedPaperA, interleavedPaperB, 1_000);
    const selectedSupportId = orderedEvidenceId(paperIds.get(1_000)!, 1);
    const supportFixture = await seedSelectedSupport(client, projectId, paperIds.get(1_000)!, selectedSupportId, databaseName);
    await client.unsafe("analyze papers");
    await client.unsafe("analyze evidence");
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    benchmarkArtifact.database = { postgresVersion: serverVersion, disposable: true, databaseName };
    benchmarkArtifact.evidenceRowsInDisposableDatabase = POPULATIONS.reduce((sum, count) => sum + count, 0) + 2_000;
    benchmarkArtifact.populations = POPULATIONS.map((count) => ({
      count,
      paperId: paperIds.get(count),
      ordering: "all rows share created_at; evidence UUID suffix follows insertion position so the rare match is the deepest key",
      textShape: "common source term at start; rare passage after 1200-character preview; rare note after 600-character preview; first row has 1500 Unicode code points beyond the passage preview",
    }));
    benchmarkArtifact.interleavedPapers = { paperA: interleavedPaperA, paperB: interleavedPaperB, recordsPerPaper: 1_000, insertedAlternating: true, sharedTimestamp: true };
    benchmarkArtifact.selectedSupportFixture = { fieldId: supportFixture.fieldId, paperId: paperIds.get(1_000), selectedEvidenceId: supportFixture.evidenceId, selectedRowPosition: 1 };

    const db = makeDatabase(client);
    const reads = createExtractionEvidenceSelectionReadServices(db);
    const unfilteredWorkloads = benchmarkArtifact.unfilteredWorkloads as Array<Record<string, unknown>>;
    for (const count of POPULATIONS) {
      const paperId = paperIds.get(count)!;
      const base = await timedRead(reads, projectId, paperId, "");
      const keyQuery = base.keyQuery;
      const expectedResultCount = Math.min(count, PAGE_SIZE);
      if (base.error || base.resultCount !== expectedResultCount || base.selectCount !== (count > 0 ? 3 : 2)) {
        throw new Error(`Unfiltered first-page assertion failed for ${count} evidence records: ${JSON.stringify({ error: base.error, resultCount: base.resultCount, selectCount: base.selectCount })}`);
      }
      if (!base.setLocal15sTimeoutObserved) throw new Error(`Application service did not issue the expected 15s local timeout for the ${count}-row baseline.`);
      if (base.resultCount! > PAGE_SIZE || Number(base.dtoUtf8Bytes) > MAX_DTO_BYTES || base.hasNext !== (count > PAGE_SIZE)) {
        throw new Error(`Unfiltered page bound or DTO ceiling failed for ${count} evidence records.`);
      }
      const baseline: Record<string, unknown> = {
        population: count,
        paperId,
        case: "empty_query_baseline",
        diagnosticWallTimeMs: base.diagnosticWallTimeMs,
        queryStatementCount: base.queryStatementCount,
        selectCount: base.selectCount,
        resultCount: base.resultCount,
        hasNext: base.hasNext,
        nextCursorPresent: base.nextCursorPresent,
        dtoUtf8Bytes: base.dtoUtf8Bytes,
        applicationSql: keyQuery?.sql ?? null,
        applicationParameters: keyQuery?.params ?? null,
        setLocal15sTimeoutObserved: base.setLocal15sTimeoutObserved,
        plan: null,
      };
      unfilteredWorkloads.push(baseline);
      if (keyQuery) {
        const plan = await explainApplicationQuery(client, keyQuery, `population_${count}.unfiltered_first_page`);
        baseline.plan = plan;
        queryPlans.push(plan);
        if (plan.status !== "completed") throw new Error(`EXPLAIN ANALYZE failed for ${count}-row unfiltered baseline.`);
      }
    }

    for (const count of POPULATIONS) {
      const paperId = paperIds.get(count)!;
      const repetitions = count === 50_000 ? 3 : 1;
      for (const search of SEARCHES) {
        const oracleRows = await client.unsafe<{ match_count: string }[]>(`
          select count(*)::text as match_count from evidence e
          where e.project_id=$1::uuid and e.paper_id=$2::uuid
            and (strpos(lower(e.source_text),lower($3::text)) > 0 or strpos(lower(e.note),lower($3::text)) > 0)
        `, [projectId, paperId, search.query]);
        const oracleExactMatches = Number(oracleRows[0]?.match_count ?? 0);
        const expectedExactMatches = search.name === "common_source" ? count : search.name === "zero_result" ? 0 : count === 0 ? 0 : 1;
        if (oracleExactMatches !== expectedExactMatches) throw new Error(`${search.name} SQL oracle count did not match the seeded ${count}-row fixture.`);
        const workload: WorkloadResult = {
          population: count,
          paperId,
          case: search.name,
          query: search.query,
          repetitions,
          observations: [],
          applicationSql: null,
          applicationParameters: null,
          plan: null,
          expected: {
            exactMatches: oracleExactMatches,
            pageResults: search.name === "common_source" ? Math.min(count, PAGE_SIZE) : search.name === "zero_result" || count === 0 ? 0 : 1,
            hasNext: search.name === "common_source" && count > PAGE_SIZE,
            rareCandidateId: search.name.startsWith("rare_") && count > 0 ? orderedEvidenceId(paperId, count) : null,
          },
        };
        searchWorkloads.push(workload);
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          const observation = await timedRead(reads, projectId, paperId, search.query);
          const expectedPageCount = Number(workload.expected.pageResults);
          const expectedId = workload.expected.rareCandidateId;
          workload.observations.push({ repetition, ...observation, keyQuery: undefined });
          if (!workload.applicationSql && observation.keyQuery) {
            workload.applicationSql = observation.keyQuery.sql;
            workload.applicationParameters = observation.keyQuery.params;
          }
          if (observation.error || observation.resultCount !== expectedPageCount) {
            throw new Error(`${search.name} result assertion/15s timeout failed at ${count} records: ${JSON.stringify({ error: observation.error, resultCount: observation.resultCount, expectedPageCount })}`);
          }
          if (observation.resultCount! > PAGE_SIZE || Number(observation.dtoUtf8Bytes) > MAX_DTO_BYTES || observation.hasNext !== workload.expected.hasNext || observation.nextCursorPresent !== workload.expected.hasNext) {
            throw new Error(`${search.name} page bounds, DTO ceiling, or continuation assertion failed at ${count} records.`);
          }
          if (!observation.setLocal15sTimeoutObserved) throw new Error(`Application service did not issue the expected 15s local timeout for ${count}-row ${search.name}.`);
          if (typeof expectedId === "string" && !observation.resultIds.includes(expectedId)) {
            throw new Error(`${search.name} did not return expected exact Evidence identity ${expectedId} at ${count} records.`);
          }
          if (search.name === "rare_passage_after_preview" && count > 0 && observation.sourceTextTruncated[0] !== true) {
            throw new Error(`Rare passage at ${count} records was not beyond the returned source preview.`);
          }
          if (search.name === "rare_note_after_preview" && count > 0 && observation.noteTruncated[0] !== true) {
            throw new Error(`Rare note at ${count} records was not beyond the returned note preview.`);
          }
          if (repetition === 1 && observation.keyQuery) {
            const plan = await explainApplicationQuery(client, observation.keyQuery, `population_${count}.${search.name}`);
            workload.plan = plan;
            queryPlans.push(plan);
            if (plan.status !== "completed") throw new Error(`EXPLAIN ANALYZE failed for ${count}-row ${search.name}: ${JSON.stringify(plan.error)}`);
          }
        }
      }
    }

    const traversalPaperId = paperIds.get(1_000)!;
    const oracleRows = await client.unsafe<{ id: string }[]>(`
      select e.id::text as id from evidence e
      where e.project_id=$1::uuid and e.paper_id=$2::uuid
        and (strpos(lower(e.source_text),lower($3::text)) > 0 or strpos(lower(e.note),lower($3::text)) > 0)
      order by e.created_at desc,e.id asc
    `, [projectId, traversalPaperId, SEARCHES[0].query]);
    const traversedIds: string[] = [];
    let after: string | null = null;
    let pageCount = 0;
    do {
      const page = await reads.getPaperExtractionEvidenceCandidatePage(projectId, traversalPaperId, { pageSize: PAGE_SIZE, query: SEARCHES[0].query, after });
      traversedIds.push(...page.items.map((item) => item.id));
      after = page.nextCursor;
      pageCount += 1;
      if (pageCount > 60) throw new Error("Static 1k common-search traversal exceeded 60 pages.");
    } while (after);
    const traversalMatchesOracle = traversedIds.length === oracleRows.length && new Set(traversedIds).size === traversedIds.length && traversedIds.every((id, index) => id === oracleRows[index].id);
    benchmarkArtifact.staticSearchTraversal = {
      candidateUniverse: 1_000,
      query: SEARCHES[0].query,
      pageSize: PAGE_SIZE,
      pages: pageCount,
      rows: traversedIds.length,
      directSqlOracleRows: oracleRows.length,
      equivalent: traversalMatchesOracle,
    };
    if (!traversalMatchesOracle) throw new Error("Search-bound keyset traversal had duplicates, omissions, or order differences from the direct SQL oracle.");

    const pageBoundaryWorkloads = benchmarkArtifact.pageBoundaryWorkloads as Array<Record<string, unknown>>;
    const boundaries = [
      { name: "first", offset: 0 },
      { name: "continuation", offset: 20 },
      { name: "middle", offset: 500 },
      { name: "terminal", offset: 980 },
      { name: "after_terminal", offset: 1_000 },
    ] as const;
    for (const boundary of boundaries) {
      const after = await cursorBefore(client, projectId, traversalPaperId, PAGE_SIZE, SEARCHES[0].query, boundary.offset);
      const observation = await timedRead(reads, projectId, traversalPaperId, SEARCHES[0].query, after);
      const expectedIds = oracleRows.slice(boundary.offset, boundary.offset + PAGE_SIZE).map((row) => row.id);
      const actualIds = observation.resultIds;
      const expectedHasNext = boundary.offset + PAGE_SIZE < oracleRows.length;
      if (observation.error || JSON.stringify(actualIds) !== JSON.stringify(expectedIds) || observation.hasNext !== expectedHasNext || Number(observation.dtoUtf8Bytes) > MAX_DTO_BYTES) {
        throw new Error(`${boundary.name} page did not match the ordered direct SQL oracle or page bounds.`);
      }
      const record: Record<string, unknown> = {
        population: 1_000,
        query: SEARCHES[0].query,
        pageSize: PAGE_SIZE,
        position: boundary.name,
        startOffset: boundary.offset,
        diagnosticWallTimeMs: observation.diagnosticWallTimeMs,
        queryStatementCount: observation.queryStatementCount,
        selectCount: observation.selectCount,
        resultCount: observation.resultCount,
        hasNext: observation.hasNext,
        nextCursorPresent: observation.nextCursorPresent,
        dtoUtf8Bytes: observation.dtoUtf8Bytes,
        resultIds: actualIds,
        oracleEquivalent: true,
        applicationSql: observation.keyQuery?.sql ?? null,
        applicationParameters: observation.keyQuery?.params ?? null,
        plan: null,
      };
      pageBoundaryWorkloads.push(record);
      if (observation.keyQuery && ["middle", "terminal", "after_terminal"].includes(boundary.name)) {
        const plan = await explainApplicationQuery(client, observation.keyQuery, `search_1k.${boundary.name}`);
        record.plan = plan;
        queryPlans.push(plan);
        if (plan.status !== "completed") throw new Error(`EXPLAIN ANALYZE failed for ${boundary.name} search page.`);
      }
    }

    const pageSize50 = await timedRead(reads, projectId, traversalPaperId, SEARCHES[0].query, null, 50);
    const expected50 = oracleRows.slice(0, 50).map((row) => row.id);
    if (pageSize50.error || pageSize50.resultIds.length !== 50 || JSON.stringify(pageSize50.resultIds) !== JSON.stringify(expected50) || !pageSize50.hasNext || Number(pageSize50.dtoUtf8Bytes) > MAX_DTO_BYTES) {
      throw new Error("Page-size-50 first page failed the direct SQL oracle or 1 MiB DTO bound.");
    }
    pageBoundaryWorkloads.push({
      population: 1_000,
      query: SEARCHES[0].query,
      pageSize: 50,
      position: "first_maximum_page_size",
      diagnosticWallTimeMs: pageSize50.diagnosticWallTimeMs,
      queryStatementCount: pageSize50.queryStatementCount,
      selectCount: pageSize50.selectCount,
      resultCount: pageSize50.resultCount,
      hasNext: pageSize50.hasNext,
      nextCursorPresent: pageSize50.nextCursorPresent,
      dtoUtf8Bytes: pageSize50.dtoUtf8Bytes,
      oracleEquivalent: true,
      applicationSql: pageSize50.keyQuery?.sql ?? null,
      applicationParameters: pageSize50.keyQuery?.params ?? null,
    });

    const worksheet = await createExtractionReadServices(db).getPaperExtractionWorksheet(projectId, traversalPaperId);
    const supportField = worksheet.values.find((value) => value.field.id === supportFixture.fieldId);
    const selectedIds = supportField?.currentRevision?.evidence.map((item) => item.id) ?? [];
    const rarePassage = searchWorkloads.find((workload) => workload.population === 1_000 && workload.case === "rare_passage_after_preview");
    const rareResultIds = (rarePassage?.observations[0]?.resultIds as string[] | undefined) ?? [];
    const selectedSupportOutsideSearch = selectedIds.includes(supportFixture.evidenceId) && !rareResultIds.includes(supportFixture.evidenceId);
    if (!selectedSupportOutsideSearch) throw new Error("Selected Evidence support outside the rare search result was not preserved in the worksheet read.");
    benchmarkArtifact.selectedSupportOutsideSearch = {
      fieldId: supportFixture.fieldId,
      paperId: traversalPaperId,
      selectedEvidenceId: supportFixture.evidenceId,
      selectedMembershipCount: selectedIds.length,
      rareSearchResultIds: rareResultIds,
      preservedOutsideResult: selectedSupportOutsideSearch,
    };

    const interleavedPaperAId = String((benchmarkArtifact.interleavedPapers as Record<string, unknown>).paperA);
    const interleavedPaperBId = String((benchmarkArtifact.interleavedPapers as Record<string, unknown>).paperB);
    const interleavedProfiles: Array<Record<string, unknown>> = [];
    for (const paperId of [interleavedPaperAId, interleavedPaperBId]) {
      const interleavedOracle = await client.unsafe<{ id: string }[]>(`
        select e.id::text as id from evidence e
        where e.project_id=$1::uuid and e.paper_id=$2::uuid
          and (strpos(lower(e.source_text),lower($3::text)) > 0 or strpos(lower(e.note),lower($3::text)) > 0)
        order by e.created_at desc,e.id asc
      `, [projectId, paperId, SEARCHES[0].query]);
      const firstPage = await timedRead(reads, projectId, paperId, SEARCHES[0].query);
      if (firstPage.error || firstPage.resultIds.some((id) => !interleavedOracle.some((row) => row.id === id))) {
        throw new Error("Interleaved Paper first page leaked candidates or failed its SQL oracle.");
      }
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await reads.getPaperExtractionEvidenceCandidatePage(projectId, paperId, { pageSize: PAGE_SIZE, query: SEARCHES[0].query, after: cursor });
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages += 1;
        if (pages > 60) throw new Error("Interleaved Paper traversal exceeded 60 pages.");
      } while (cursor);
      const matches = ids.length === interleavedOracle.length && new Set(ids).size === ids.length && ids.every((id, index) => id === interleavedOracle[index].id);
      if (!matches) throw new Error("Interleaved Paper traversal leaked, omitted, duplicated, or misordered Evidence.");
      interleavedProfiles.push({
        paperId,
        candidateCount: interleavedOracle.length,
        firstPageSelectCount: firstPage.selectCount,
        firstPageResultCount: firstPage.resultCount,
        pages,
        traversedRows: ids.length,
        oracleRows: interleavedOracle.length,
        equivalent: matches,
      });
    }
    benchmarkArtifact.interleavedPaperTraversal = { insertionAlternatedAcrossPapers: true, commonTimestamp: true, profiles: interleavedProfiles };
    benchmarkArtifact.status = "completed";
  } catch (error) {
    failure = safeError(error);
    benchmarkArtifact.status = "failed";
    benchmarkArtifact.failure = failure;
  } finally {
    if (client) {
      try {
        await client.end({ timeout: 1 });
      } catch (error) {
        failure = safeError(error);
        benchmarkArtifact.status = "failed";
        benchmarkArtifact.failure = failure;
      }
    }
    try {
      if (databaseCreated) {
        await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
        const remains = await admin.unsafe("select exists(select 1 from pg_database where datname=$1) as present", [databaseName]);
        cleanupVerified = (remains[0] as { present: boolean }).present !== true;
        if (!cleanupVerified) throw new Error("Disposable Slice 57 benchmark database remained after cleanup.");
      } else {
        cleanupVerified = true;
      }
    } catch (error) {
      failure = { code: "CLEANUP_FAILED", message: safeError(error).message };
      benchmarkArtifact.status = "failed";
      benchmarkArtifact.failure = failure;
    } finally {
      try {
        await admin.end({ timeout: 1 });
      } catch (error) {
        failure = safeError(error);
        benchmarkArtifact.status = "failed";
        benchmarkArtifact.failure = failure;
      }
    }
  }

  benchmarkArtifact.statementTimeoutMs = STATEMENT_TIMEOUT_MS;
  benchmarkArtifact.cleanup = { disposableDatabaseDropped: databaseCreated, verifiedAbsent: cleanupVerified };
  await mkdir(resolve("docs/benchmarks"), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify(benchmarkArtifact, null, 2)}\n`, "utf8");
  console.log(`Slice 57 benchmark wrote ${ARTIFACT}; disposable database cleanup verified: ${cleanupVerified}.`);
  if (failure) throw new Error(`Slice 57 benchmark failed: ${JSON.stringify(failure)}`);
}

main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
