import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";
import { createReviewServices } from "@/application/services";
import { REVIEW_REPORT_METRIC_KEYS, type ReviewReportContextKind, type ReviewReportContributorSelector } from "@/domain/review-report";
import { schema } from "@/db/schema";

const OUTPUT = resolve(process.cwd(), "docs/benchmarks/slice50-review-report-read-paths.json");
const FACT_SIZES = [1_000, 10_000, 50_000] as const;
const LARGE_CONTEXT_SIZE = 2_000;
const DENSE_SIZES = [250, 1_000] as const;
const CONTRIBUTOR_PAGE_SIZE = 50;
const CONTEXT_PAGE_SIZE = 25;
const STATEMENT_TIMEOUT_MS = 120_000;
const NARROWED_EXPLAIN_TIMEOUT_MS = 30_000;

type CapturedQuery = {
  key: string;
  sql: string;
  params: unknown[];
  parameterShape: string[];
  driverRows: number | null;
  driverJsonBytes: number | null;
};
type Sink = { queries: CapturedQuery[] };
type Measurement = {
  label: string;
  status: "completed" | "timed_out" | "failed" | "skipped";
  elapsedMs: number | null;
  apiPayloadBytes: number | null;
  itemCount: number | null;
  pageQueryRows: number | null;
  selectCount: number;
  returnedRows: number | null;
  driverJsonBytes: number | null;
  contributionTotal: number | null;
  hasMore: boolean | null;
  queryKeys: string[];
  error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeErrorMessage(error: unknown, limit = 1_000): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s"'<>]+/gi, "[redacted database URL]")
    .replace(/([?&](?:password|passwd|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, limit);
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function jsonValue(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === "bigint") return child.toString();
    if (child instanceof Date) return child.toISOString();
    if (Buffer.isBuffer(child)) return { $bufferBytes: child.byteLength };
    return child;
  }) ?? "null";
}

function parameterShape(params: unknown[]): string[] {
  return params.map((value) => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number") return Number.isSafeInteger(value) ? "integer" : "number";
    if (typeof value === "boolean") return "boolean";
    if (value instanceof Date) return "timestamptz";
    if (Array.isArray(value)) return `array:${value.length}`;
    if (typeof value === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return "uuid";
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "timestamptz-or-text";
      return `text:${Array.from(value).length}:codepoints`;
    }
    return typeof value;
  });
}

function captureRendered(rendered: { sql: string; params: unknown[] }): CapturedQuery {
  const params = rendered.params;
  const shape = parameterShape(params);
  const key = createHash("sha256").update(rendered.sql).update("\0").update(JSON.stringify(shape)).digest("hex").slice(0, 20);
  return { key, sql: rendered.sql, params, parameterShape: shape, driverRows: null, driverJsonBytes: null };
}

function capture(query: SQL): CapturedQuery {
  const rendered = new PgDialect().sqlToQuery(query);
  return captureRendered({ sql: rendered.sql, params: rendered.params as unknown[] });
}

function isRead(query: CapturedQuery): boolean { return /^\s*(?:select|with)\b/i.test(query.sql); }

function recordQueryResult(sink: Sink, captured: CapturedQuery, result: unknown): void {
  if (!isRead(captured)) return;
  const resultRows = Array.isArray(result) ? result : null;
  captured.driverRows = resultRows?.length ?? null;
  captured.driverJsonBytes = resultRows ? Buffer.byteLength(jsonValue(resultRows), "utf8") : null;
  sink.queries.push(captured);
}

function wrapReadProvider(target: object, sink: Sink): object {
  return new Proxy(target, {
    get(target, property) {
      if (property === "execute") {
        const execute = Reflect.get(target, property, target) as (query: SQL) => Promise<unknown>;
        return async (query: SQL) => {
          const captured = capture(query);
          try {
            const result = await Reflect.apply(execute, target, [query]) as unknown;
            recordQueryResult(sink, captured, result);
            return result;
          } catch (error) {
            if (isRead(captured)) sink.queries.push(captured);
            throw error;
          }
        };
      }
      if (property === "select") {
        const select = Reflect.get(target, property, target) as (...args: unknown[]) => object;
        return (...args: unknown[]) => wrapQueryBuilder(Reflect.apply(select, target, args) as object, sink);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapQueryBuilder(builder: object, sink: Sink): object {
  return new Proxy(builder, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "then" && typeof value === "function") {
        return (onFulfilled?: (result: unknown) => unknown, onRejected?: (error: unknown) => unknown) => {
          const toSQL = Reflect.get(target, "toSQL", target) as () => { sql: string; params: unknown[] };
          const rendered = toSQL.call(target);
          const captured = captureRendered(rendered);
          const promise = Reflect.apply(value, target, []) as Promise<unknown>;
          return promise.then((result) => {
            recordQueryResult(sink, captured, result);
            return onFulfilled ? onFulfilled(result) : result;
          }, (error: unknown) => {
            sink.queries.push(captured);
            return onRejected ? onRejected(error) : Promise.reject(error);
          });
        };
      }
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args) as unknown;
          return result && (typeof result === "object" || typeof result === "function")
            ? wrapQueryBuilder(result as object, sink)
            : result;
        };
      }
      return value;
    },
  });
}

function monitorDatabase(database: Database, sink: Sink): Database {
  return new Proxy(database as unknown as object, {
    get(target, property) {
      if (property === "transaction") {
        const transaction = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
        return (callback: (tx: object) => Promise<unknown>, options?: unknown) => Reflect.apply(transaction, target, [
          (tx: object) => callback(wrapReadProvider(tx, sink)), options,
        ]);
      }
      if (property === "execute" || property === "select") return Reflect.get(wrapReadProvider(target, sink), property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

async function measure(label: string, sink: Sink, run: () => Promise<unknown>): Promise<{ measurement: Measurement; value: unknown; queries: CapturedQuery[] }> {
  sink.queries.length = 0;
  const started = process.hrtime.bigint();
  try {
    const value = await run();
    const queries = [...sink.queries];
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const itemCount = value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? ((value as { items: unknown[] }).items.length) : null;
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      measurement: {
        label, status: "completed", elapsedMs, apiPayloadBytes: Buffer.byteLength(jsonValue(value), "utf8"), itemCount,
        pageQueryRows: typeof record.pageSize === "number" && queries.length > 0 ? queries.at(-1)!.driverRows : null,
        selectCount: queries.length,
        returnedRows: queries.every((query) => query.driverRows !== null) ? queries.reduce((sum, query) => sum + (query.driverRows ?? 0), 0) : null,
        driverJsonBytes: queries.every((query) => query.driverJsonBytes !== null) ? queries.reduce((sum, query) => sum + (query.driverJsonBytes ?? 0), 0) : null,
        contributionTotal: typeof record.contributionTotal === "number" ? record.contributionTotal : null,
        hasMore: typeof record.hasMore === "boolean" ? record.hasMore : null,
        queryKeys: queries.map((query) => query.key),
      }, value, queries,
    };
  } catch (error) {
    const typed = error as { code?: unknown; cause?: { code?: unknown } };
    const status = typed?.code === "57014" || typed?.cause?.code === "57014" ? "timed_out" : "failed";
    return {
      measurement: {
        label, status, elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        apiPayloadBytes: null, itemCount: null, pageQueryRows: null, selectCount: sink.queries.length,
        returnedRows: null, driverJsonBytes: null, contributionTotal: null, hasMore: null, queryKeys: sink.queries.map((query) => query.key),
        error: safeErrorMessage(error),
      }, value: null, queries: [...sink.queries],
    };
  }
}

function planNodes(root: unknown): unknown[] {
  const nodes: unknown[] = [];
  const walk = (node: Record<string, unknown>) => {
    nodes.push({
      nodeType: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"],
      planRows: node["Plan Rows"], actualRows: node["Actual Rows"], actualLoops: node["Actual Loops"],
      rowsRemovedByFilter: node["Rows Removed by Filter"], sharedHitBlocks: node["Shared Hit Blocks"],
      sharedReadBlocks: node["Shared Read Blocks"], tempReadBlocks: node["Temp Read Blocks"],
      tempWrittenBlocks: node["Temp Written Blocks"], sortKey: node["Sort Key"], sortMethod: node["Sort Method"],
      sortSpaceType: node["Sort Space Type"], sortSpaceUsed: node["Sort Space Used"],
    });
    if (Array.isArray(node.Plans)) for (const child of node.Plans) walk(child as Record<string, unknown>);
  };
  if (root && typeof root === "object") walk(root as Record<string, unknown>);
  return nodes;
}

async function explain(client: postgres.Sql, query: CapturedQuery, label: string): Promise<Record<string, unknown>> {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never) as unknown as Array<Record<string, unknown>>;
    const raw = rows[0]?.["QUERY PLAN"];
    const root = typeof raw === "string" ? JSON.parse(raw) as Array<Record<string, unknown>> : raw as Array<Record<string, unknown>>;
    const top = root?.[0];
    return { label, status: "completed", queryKey: query.key, sql: query.sql, parameterShape: query.parameterShape, elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000, planningTimeMs: top?.["Planning Time"], executionTimeMs: top?.["Execution Time"], nodes: planNodes(top?.Plan) };
  } catch (error) {
    const typed = error as { code?: unknown; cause?: { code?: unknown } };
    return { label, status: typed?.code === "57014" || typed?.cause?.code === "57014" ? "timed_out" : "failed", queryKey: query.key, sql: query.sql, parameterShape: query.parameterShape, elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000, error: safeErrorMessage(error) };
  }
}

function requireStatus(measurement: Measurement, expectedSelectMin: number, expectedSelectMax: number, maxBytes: number, maxRows: number, maxPageRows?: number): void {
  assert(measurement.status === "completed", `${measurement.label} ${measurement.status}: ${measurement.error ?? "no result"}`);
  assert(measurement.selectCount >= expectedSelectMin && measurement.selectCount <= expectedSelectMax, `${measurement.label} used ${measurement.selectCount} SELECTs`);
  assert(measurement.apiPayloadBytes !== null && measurement.apiPayloadBytes <= maxBytes, `${measurement.label} exceeded its DTO budget`);
  assert(measurement.returnedRows !== null && measurement.returnedRows <= maxRows, `${measurement.label} exceeded its driver row budget`);
  if (maxPageRows !== undefined) assert(measurement.pageQueryRows !== null && measurement.pageQueryRows <= maxPageRows, `${measurement.label} returned too many page-query rows`);
}

async function insertLargeContext(client: postgres.Sql, projectId: string, questionCount: number, criterionCount: number): Promise<{ titleAbstractReasonIds: string[]; fullTextReasonIds: string[] }> {
  const titleAbstractReasonIds = Array.from({ length: criterionCount }, () => randomUUID());
  const fullTextReasonIds = Array.from({ length: criterionCount }, () => randomUUID());
  await client.unsafe(`insert into research_questions(id,project_id,identifier,label,sort_order)
    select md5($1::text||':question:'||n)::uuid,$1::uuid,'RQ-'||lpad(n::text,5,'0'),'Benchmark research question '||lpad(n::text,5,'0'),n::int
    from generate_series(1,$2::int) n`, [projectId, questionCount]);
  await client.unsafe(`insert into screening_criteria(id,project_id,type,text)
    select ids.id,$1::uuid,'exclusion','Benchmark exclusion criterion '||lpad(ids.ordinality::text,5,'0')
    from unnest($2::uuid[]) with ordinality as ids(id,ordinality)`, [projectId, titleAbstractReasonIds]);
  await client.unsafe(`insert into screening_criteria(id,project_id,type,text)
    values ($2::uuid,$1::uuid,'inclusion','Benchmark inclusion criterion')`, [projectId, randomUUID()]);
  await client.unsafe(`insert into full_text_screening_criteria(id,project_id,text)
    select ids.id,$1::uuid,'Benchmark full-text criterion '||lpad(ids.ordinality::text,5,'0')
    from unnest($2::uuid[]) with ordinality as ids(id,ordinality)`, [projectId, fullTextReasonIds]);
  return { titleAbstractReasonIds, fullTextReasonIds };
}

async function seedFactProject(client: postgres.Sql, projectId: string, sourceIds: string[], sourceKeys: string[], sourceNames: string[], strategyIds: string[], size: number, runCount: number, titleAbstractReasonIds: string[], fullTextReasonIds: string[]): Promise<void> {
  const reasonCount = titleAbstractReasonIds.length;
  await client.unsafe(`with sources as (
      select * from unnest($2::uuid[],$3::text[],$4::text[],$5::uuid[]) with ordinality as x(id,source_key,display_name,strategy_id,ordinal)
    )
    insert into search_runs(id,project_id,search_source_id,source_key_snapshot,source_display_name_snapshot,strategy_id,query_text,reported_result_count,executed_at)
    select md5($1::text||':run:'||g.n)::uuid,$1::uuid,s.id,s.source_key,s.display_name,s.strategy_id,
      'Slice 50 benchmark query',case when g.n%13=0 then 0 else (g.n%50)+1 end,'2026-01-01T00:00:00Z'::timestamptz
    from generate_series(1,$6::int) g(n)
    join sources s on s.ordinal=((g.n-1)%array_length($2::uuid[],1))+1`, [projectId, sourceIds, sourceKeys, sourceNames, strategyIds, runCount]);
  await client.unsafe(`with sources as (
      select * from unnest($2::uuid[]) with ordinality as x(id,ordinal)
    )
    insert into papers(id,project_id,title,publication_year,created_at)
    select md5($1::text||':paper:'||g.n)::uuid,$1::uuid,'Benchmark canonical Paper '||g.n,2020,'2026-01-01T00:00:00Z'::timestamptz
    from generate_series(1,$3::int) g(n) where g.n%5<>0`, [projectId, sourceIds, size]);
  await client.unsafe(`with source_rows as (
      select id,ordinal from unnest($2::uuid[]) with ordinality as x(id,ordinal)
    )
    insert into retrieved_records(id,project_id,search_run_id,search_source_id,source_record_id,title,publication_year,retrieved_at)
    select md5($1::text||':record:'||g.n)::uuid,$1::uuid,
      md5($1::text||':run:'||(1+((g.n-1)%$3::int)))::uuid,s.id,'benchmark-record-'||g.n,
      'Benchmark RetrievedRecord '||g.n,2020,'2026-01-01T01:00:00Z'::timestamptz
    from generate_series(1,$4::int) g(n)
    join source_rows s on s.ordinal=1+(((1+((g.n-1)%$3::int))-1)%array_length($2::uuid[],1))`, [projectId, sourceIds, runCount, size]);
  await client.unsafe(`insert into retrieved_record_matches(project_id,retrieved_record_id,paper_id,action)
    select $1::uuid,md5($1::text||':record:'||g.n)::uuid,
      md5($1::text||':paper:'||(case when g.n%5=0 then g.n-1 else g.n end))::uuid,'linked'
    from generate_series(1,$2::int) g(n)`, [projectId, size]);
  await client.unsafe(`insert into screening_decisions(project_id,paper_id,stage,decision,exclusion_criterion_id,exclusion_criterion_type)
    select $1::uuid,md5($1::text||':paper:'||g.n)::uuid,'title_abstract',
      case when g.n%10=2 then 'exclude' when g.n%10=6 then 'maybe' else 'include' end,
      case when g.n%10=2 then ($3::uuid[])[1+((g.n/10)%$4::int)] else null end,
      case when g.n%10=2 then 'exclusion' else null end
    from generate_series(1,$2::int) g(n) where g.n%5<>0`, [projectId, size, titleAbstractReasonIds, reasonCount]);
  await client.unsafe(`insert into full_text_retrieval_attempts(project_id,paper_id,outcome,attempted_at)
    select $1::uuid,md5($1::text||':paper:'||g.n)::uuid,
      case when g.n%3 in (0,1) then 'retrieved' else 'unavailable' end,
      '2026-01-02T01:00:00Z'::timestamptz
    from generate_series(1,$2::int) g(n)
    where g.n%5<>0 and g.n%10 not in (2,6) and g.n%4<>3`, [projectId, size]);
  await client.unsafe(`insert into full_text_screening_decisions(project_id,paper_id,decision,exclusion_criterion_id)
    select $1::uuid,md5($1::text||':paper:'||g.n)::uuid,
      case when g.n%15=1 then 'exclude' when g.n%6=1 then 'maybe' else 'include' end,
      case when g.n%15=1 then ($4::uuid[])[1+((g.n/15)%$3::int)] else null end
    from generate_series(1,$2::int) g(n)
    where g.n%5<>0 and g.n%10 not in (2,6) and g.n%4<>3 and g.n%3=1`, [projectId, size, reasonCount, fullTextReasonIds]);
  await client.unsafe("analyze search_runs");
  await client.unsafe("analyze retrieved_records");
  await client.unsafe("analyze retrieved_record_matches");
  await client.unsafe("analyze papers");
  await client.unsafe("analyze screening_decisions");
  await client.unsafe("analyze full_text_screening_decisions");
  await client.unsafe("analyze full_text_retrieval_attempts");
  await client.unsafe("analyze research_questions");
  await client.unsafe("analyze screening_criteria");
  await client.unsafe("analyze full_text_screening_criteria");
}

async function seedDenseProject(client: postgres.Sql, projectId: string, sourceId: string, sourceKey: string, sourceName: string, strategyId: string, size: number): Promise<void> {
  const runId = randomUUID();
  await client.unsafe(`insert into search_runs(id,project_id,search_source_id,source_key_snapshot,source_display_name_snapshot,strategy_id,query_text,reported_result_count,executed_at)
    values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,'Dense candidate benchmark',$7,'2026-01-01T00:00:00Z'::timestamptz)`, [runId, projectId, sourceId, sourceKey, sourceName, strategyId, size]);
  await client.unsafe(`insert into retrieved_records(id,project_id,search_run_id,search_source_id,source_record_id,title,publication_year,doi,retrieved_at)
    select md5($1::text||':dense-record:'||g.n)::uuid,$1::uuid,$2::uuid,$3::uuid,'dense-'||g.n,
      'Dense duplicate candidate title',2020,case when g.n<=20 then '10.5555/shared-dense-work' else null end,
      '2026-01-01T01:00:00Z'::timestamptz from generate_series(1,$4::int) g(n)`, [projectId, runId, sourceId, size]);
  const leftId = (await client.unsafe("select md5($1::text||':dense-record:1')::text as id", [projectId]) as unknown as Array<{ id: string }>)[0]!.id;
  const rightId = (await client.unsafe("select md5($1::text||':dense-record:2')::text as id", [projectId]) as unknown as Array<{ id: string }>)[0]!.id;
  await client.unsafe(`insert into retrieved_record_deduplication_decisions(project_id,left_retrieved_record_id,right_retrieved_record_id,decision,note)
    values($1::uuid,least($2::uuid,$3::uuid),greatest($2::uuid,$3::uuid),'different_work','benchmark adjudicated gap')`, [projectId, leftId, rightId]);
  await client.unsafe("analyze retrieved_records");
  await client.unsafe("analyze retrieved_record_deduplication_decisions");
}

async function seedThousandsOfSources(client: postgres.Sql, projectId: string, count: number): Promise<void> {
  await client.unsafe(`insert into search_sources(id,project_id,source_key,display_name)
    select md5($1::text||':context-source:'||n)::uuid,$1::uuid,'benchmark-source-'||lpad(n::text,5,'0'),'Benchmark SearchSource '||lpad(n::text,5,'0')
    from generate_series(1,$2::int) n`, [projectId, count]);
  await client.unsafe(`insert into search_strategies(id,project_id,search_source_id,name,query_text)
    select md5($1::text||':context-strategy:'||n)::uuid,$1::uuid,md5($1::text||':context-source:'||n)::uuid,'Benchmark source strategy','benchmark source query'
    from generate_series(1,$2::int) n`, [projectId, count]);
  await client.unsafe(`insert into search_runs(id,project_id,search_source_id,source_key_snapshot,source_display_name_snapshot,strategy_id,query_text,reported_result_count,executed_at)
    select md5($1::text||':context-run:'||n)::uuid,$1::uuid,md5($1::text||':context-source:'||n)::uuid,
      'benchmark-source-'||lpad(n::text,5,'0'),'Benchmark SearchSource '||lpad(n::text,5,'0'),
      md5($1::text||':context-strategy:'||n)::uuid,'benchmark source query',0,'2026-01-01T00:00:00Z'::timestamptz
    from generate_series(1,$2::int) n`, [projectId, count]);
  await client.unsafe("analyze search_sources");
  await client.unsafe("analyze search_runs");
}

function selectorLabel(selector: ReviewReportContributorSelector): string {
  if (selector.scope === "metric") return `metric:${selector.metric}`;
  if (selector.scope === "source") return `source:${selector.metric}`;
  if (selector.scope === "exclusionReason") return "title-abstract-reason";
  if (selector.scope === "fullTextExclusionReason") return "full-text-reason";
  return "overlap";
}

function contextItemCount(value: unknown): number {
  return value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
    ? ((value as { items: unknown[] }).items.length) : 0;
}

async function makeContextProject(app: ReturnType<typeof createReviewServices>, client: postgres.Sql): Promise<{ id: string; title: string }> {
  const project = await app.createProject({ title: "Slice 50 represented-source context benchmark" });
  await seedThousandsOfSources(client, project.id, LARGE_CONTEXT_SIZE);
  return project;
}

async function startFactProject(app: ReturnType<typeof createReviewServices>, database: Database, client: postgres.Sql, size: number, sink: Sink): Promise<{
  id: string;
  title: string;
  sources: Array<{ id: string; sourceKey: string; displayName: string }>;
  bounded: ReturnType<typeof createReviewServices>;
  old: ReturnType<typeof createReviewServices>;
}> {
  const project = await app.createProject({ title: `Slice 50 ${size.toLocaleString("en-US")} fact benchmark` });
  const allSources = (await app.listSearchSources(project.id)).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)).slice(0, 5);
  const strategies = [] as Array<{ id: string }>;
  for (const source of allSources) {
    strategies.push(await app.createSearchStrategy(project.id, { searchSourceId: source.id, name: "Slice 50 benchmark strategy", queryText: "Slice 50 benchmark query" }));
  }
  const sourceIds = allSources.map((source) => source.id);
  const sourceKeys = allSources.map((source) => source.sourceKey);
  const sourceNames = allSources.map((source) => source.displayName);
  const strategyIds = strategies.map((strategy) => strategy.id);
  const runCount = Math.max(5, Math.ceil(size / 100));
  const reasonCount = LARGE_CONTEXT_SIZE;
  const reasonIds = await insertLargeContext(client, project.id, LARGE_CONTEXT_SIZE, reasonCount);
  await seedFactProject(client, project.id, sourceIds, sourceKeys, sourceNames, strategyIds, size, runCount, reasonIds.titleAbstractReasonIds, reasonIds.fullTextReasonIds);
  const measured = createReviewServices(monitorDatabase(database, sink));
  return { id: project.id, title: project.title, sources: allSources.map(({ id, sourceKey, displayName }) => ({ id, sourceKey, displayName })), bounded: measured, old: measured };
}

async function addMeasurement(
  report: Record<string, unknown>,
  sink: Sink,
  label: string,
  run: () => Promise<unknown>,
  budget?: { selects: [number, number]; bytes: number; rows: number; maxPageRows?: number },
): Promise<{ measurement: Measurement; value: unknown; queries: CapturedQuery[] }> {
  const result = await measure(label, sink, run);
  (report.measurements as Measurement[]).push(result.measurement);
  for (const query of result.queries) {
    (report.queryCatalog as Record<string, unknown>)[query.key] = { sql: query.sql, parameterShape: query.parameterShape };
  }
  if (budget) {
    try { requireStatus(result.measurement, budget.selects[0], budget.selects[1], budget.bytes, budget.rows, budget.maxPageRows); }
    catch (error) { (report.failures as string[]).push(safeErrorMessage(error)); }
  }
  return result;
}

type CursorPage = { nextCursor: string | null; hasMore: boolean };
type ContributorPageSnapshot = CursorPage & {
  contributionTotal: number;
  items: Array<{ contribution: number }>;
};

function isNonblankCursor(cursor: unknown): cursor is string {
  return typeof cursor === "string" && cursor.trim().length > 0;
}

function hasValidContinuationCursor(page: CursorPage | null | undefined): page is CursorPage & { nextCursor: string } {
  return page?.hasMore === true && isNonblankCursor(page.nextCursor);
}

function addSkippedMeasurement(report: Record<string, unknown>, label: string, reason: string): void {
  (report.measurements as Measurement[]).push({
    label, status: "skipped", elapsedMs: null, apiPayloadBytes: null, itemCount: null, pageQueryRows: null,
    selectCount: 0, returnedRows: null, driverJsonBytes: null, contributionTotal: null, hasMore: null,
    queryKeys: [], error: reason,
  });
}

function addFailedMeasurement(report: Record<string, unknown>, label: string, reason: string): void {
  (report.measurements as Measurement[]).push({
    label, status: "failed", elapsedMs: null, apiPayloadBytes: null, itemCount: null, pageQueryRows: null,
    selectCount: 0, returnedRows: null, driverJsonBytes: null, contributionTotal: null, hasMore: null,
    queryKeys: [], error: reason,
  });
}

function failOnMissingContinuation<T extends CursorPage>(
  report: Record<string, unknown>,
  label: string,
  pageNumber: number,
  measured: { measurement: Measurement; value: unknown },
): string | null {
  if (measured.measurement.status !== "completed" || !measured.value || typeof measured.value !== "object") return null;
  const page = measured.value as T;
  if (page.hasMore === false) return null;
  if (page.hasMore === true && isNonblankCursor(page.nextCursor)) return null;
  const reason = page.hasMore === true
    ? `Page ${pageNumber} hasMore was true without a nonblank continuation cursor.`
    : `Page ${pageNumber} returned an invalid hasMore flag.`;
  measured.measurement.status = "failed";
  measured.measurement.error = reason;
  (report.failures as string[]).push(`${label}: ${reason}`);
  return reason;
}

async function measureDeepPageCoverage<T extends CursorPage>(options: {
  report: Record<string, unknown>;
  sink: Sink;
  label: string;
  startCursor: string | null | undefined;
  startHasMore?: boolean;
  startPageNumber: number;
  targetPageNumber: number;
  startFailureReason?: string | null;
  fetch: (cursor: string) => Promise<T>;
  budget: { selects: [number, number]; bytes: number; rows: number; maxPageRows?: number };
}): Promise<void> {
  const { report, sink, label, startCursor, startHasMore, startPageNumber, targetPageNumber, startFailureReason, fetch, budget } = options;
  const coverage = {
    label, startPageNumber, targetPageNumber, status: "completed", seekPagesMeasured: 0,
    pageRequests: 0, selectCount: 0, returnedRows: 0 as number | null, reason: null as string | null,
  };
  const accountMeasurement = (measurement: Measurement): void => {
    coverage.selectCount += measurement.selectCount;
    coverage.returnedRows = coverage.returnedRows === null || measurement.returnedRows === null
      ? null
      : coverage.returnedRows + measurement.returnedRows;
  };
  const finish = () => (report.deepPageCoverage as Array<Record<string, unknown>>).push(coverage);
  if (startFailureReason) {
    coverage.status = "failed";
    coverage.reason = startFailureReason;
    addFailedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, startFailureReason);
    finish();
    return;
  }
  if (startHasMore !== false && !isNonblankCursor(startCursor)) {
    const reason = `Page ${startPageNumber - 1} hasMore was true without a nonblank continuation cursor.`;
    coverage.status = "failed";
    coverage.reason = reason;
    (report.failures as string[]).push(`${label}: ${reason}`);
    addFailedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, reason);
    finish();
    return;
  }
  if (!isNonblankCursor(startCursor)) {
    coverage.status = "skipped";
    coverage.reason = `No continuation cursor for page ${startPageNumber}; page ${targetPageNumber} does not exist.`;
    addSkippedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, coverage.reason);
    finish();
    return;
  }

  let cursor = startCursor;
  for (let pageNumber = startPageNumber; pageNumber < targetPageNumber; pageNumber += 1) {
    const measured = await addMeasurement(report, sink, `${label}-seek-page-${pageNumber}`, () => fetch(cursor), budget);
    coverage.seekPagesMeasured += 1;
    coverage.pageRequests += 1;
    accountMeasurement(measured.measurement);
    const page = measured.value as T | null;
    const invalidContinuation = failOnMissingContinuation<T>(report, label, pageNumber, measured);
    if (invalidContinuation) {
      coverage.status = "failed";
      coverage.reason = invalidContinuation;
      addFailedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, invalidContinuation);
      finish();
      return;
    }
    if (measured.measurement.status !== "completed" || !page) {
      coverage.status = measured.measurement.status;
      coverage.reason = `Could not reach page ${targetPageNumber}; page ${pageNumber} measurement was ${measured.measurement.status}.`;
      addFailedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, coverage.reason);
      finish();
      return;
    }
    if (page.hasMore === false) {
      coverage.status = "skipped";
      coverage.reason = `Reached the end at page ${pageNumber}; page ${targetPageNumber} does not exist.`;
      addSkippedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, coverage.reason);
      finish();
      return;
    }
    if (page.hasMore !== true) {
      const reason = `Page ${pageNumber} returned an invalid hasMore flag.`;
      coverage.status = "failed";
      coverage.reason = reason;
      (report.failures as string[]).push(`${label}: ${reason}`);
      addFailedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, reason);
      finish();
      return;
    }
    if (!isNonblankCursor(page.nextCursor)) {
      const reason = `Page ${pageNumber} hasMore was true without a nonblank continuation cursor.`;
      coverage.status = "failed";
      coverage.reason = reason;
      (report.failures as string[]).push(`${label}: ${reason}`);
      addFailedMeasurement(report, `${label}-deep-page-${targetPageNumber}`, reason);
      finish();
      return;
    }
    cursor = page.nextCursor;
  }

  const deep = await addMeasurement(report, sink, `${label}-deep-page-${targetPageNumber}`, () => fetch(cursor), budget);
  coverage.pageRequests += 1;
  accountMeasurement(deep.measurement);
  const invalidTargetContinuation = failOnMissingContinuation<T>(report, label, targetPageNumber, deep);
  coverage.status = invalidTargetContinuation ? "failed" : deep.measurement.status;
  if (invalidTargetContinuation) coverage.reason = invalidTargetContinuation;
  else if (deep.measurement.status !== "completed") coverage.reason = deep.measurement.error ?? "Deep page measurement did not complete.";
  finish();
}

async function recordCompleteContributorTraversal(options: {
  report: Record<string, unknown>;
  sink: Sink;
  label: string;
  projectId: string;
  selector: ReviewReportContributorSelector;
  initialPages: Array<{ measurement: Measurement; value: unknown }>;
  fetch: (cursor: string) => Promise<unknown>;
  budget: { selects: [number, number]; bytes: number; rows: number; maxPageRows?: number };
}): Promise<void> {
  const { report, sink, label, projectId, selector, initialPages, fetch, budget } = options;
  const pages = [...initialPages];
  let pageCount = 0;
  let returnedItems = 0;
  let queryCount = 0;
  let contributionSum = 0n;
  let contributionTotal: number | null = null;
  let totalsConsistent = true;
  let traversalComplete = true;
  let failure: string | null = null;
  let current: ContributorPageSnapshot | null = null;
  const maxPages = 200;

  const includePage = (entry: { measurement: Measurement; value: unknown }, pageNumber: number): void => {
    pageCount += 1;
    queryCount += entry.measurement.selectCount;
    if (entry.measurement.status !== "completed" || !entry.value || typeof entry.value !== "object") {
      traversalComplete = false;
      failure = `Page ${pageNumber} measurement was ${entry.measurement.status}.`;
      current = null;
      return;
    }
    current = entry.value as ContributorPageSnapshot;
    if (!Number.isSafeInteger(current.contributionTotal) || !Array.isArray(current.items)) {
      totalsConsistent = false;
      failure = `Page ${pageNumber} did not return a safe integer total and item array.`;
      traversalComplete = false;
      return;
    }
    if (contributionTotal === null) contributionTotal = current.contributionTotal;
    else if (current.contributionTotal !== contributionTotal) {
      totalsConsistent = false;
      failure = `Contribution total changed on page ${pageNumber}.`;
    }
    for (const item of current.items) {
      if (!Number.isSafeInteger(item.contribution)) {
        totalsConsistent = false;
        failure = `Page ${pageNumber} returned an unsafe contribution value.`;
        traversalComplete = false;
        return;
      }
      returnedItems += 1;
      contributionSum += BigInt(item.contribution);
    }
  };

  for (let index = 0; index < pages.length; index += 1) {
    includePage(pages[index]!, index + 1);
    if (!traversalComplete) break;
  }
  while (traversalComplete && current?.hasMore) {
    if (!current.nextCursor) {
      totalsConsistent = false;
      traversalComplete = false;
      failure = `Page ${pageCount} hasMore was true without a continuation cursor.`;
      break;
    }
    if (pageCount >= maxPages) {
      traversalComplete = false;
      failure = `Complete traversal exceeded its ${maxPages}-page safety bound.`;
      break;
    }
    const pageNumber = pageCount + 1;
    const result = await addMeasurement(report, sink, `${label}-page-${pageNumber}`, () => fetch(current!.nextCursor!), budget);
    pages.push(result);
    includePage(result, pageNumber);
  }
  if (traversalComplete && contributionTotal !== null && contributionSum !== BigInt(contributionTotal)) {
    totalsConsistent = false;
    failure = `Summed item contributions ${contributionSum} do not equal contributionTotal ${contributionTotal}.`;
  }
  const status = traversalComplete && totalsConsistent ? "completed" : "failed";
  if (status === "failed") (report.failures as string[]).push(`${label}: ${failure ?? "complete traversal was inconsistent"}`);
  (report.selectorTraversals as Array<Record<string, unknown>>).push({
    projectId, selector: selectorLabel(selector), status, pageCount, returnedItems, queryCount,
    contributionTotal, summedContribution: contributionSum.toString(), totalsConsistent, traversalComplete,
    ...(failure ? { error: failure } : {}),
  });
}

async function explainAll(
  client: postgres.Sql,
  report: Record<string, unknown>,
  label: string,
  result: { queries: CapturedQuery[] },
): Promise<void> {
  for (let index = 0; index < result.queries.length; index += 1) {
    const query = result.queries[index]!;
    (report.explainPlans as Array<Record<string, unknown>>).push(await explain(client, query, `${label}-select-${index + 1}`));
    (report.queryCatalog as Record<string, unknown>)[query.key] = { sql: query.sql, parameterShape: query.parameterShape };
  }
}

async function explainSummaryComponents(
  client: postgres.Sql,
  report: Record<string, unknown>,
  result: { queries: CapturedQuery[] },
): Promise<void> {
  const summaryQuery = result.queries.find((query) => isRead(query) && query.sql.includes("unresolved_candidate_pairs") && query.sql.includes("reported_results_total"));
  assert(summaryQuery, "Captured final flowSummary SQL is unavailable for component plans.");
  const mainSelectStart = summaryQuery.sql.search(/\n\s*select\s*\n\s*run_metrics\.distinct_search_runs/i);
  assert(mainSelectStart >= 0, "Could not locate the final SELECT in the captured flowSummary SQL.");
  const ctePrefix = summaryQuery.sql.slice(0, mainSelectStart);
  const components = [
    "run_metrics",
    "record_metrics",
    "pair_decision_metrics",
    "paper_metrics",
    "screening_metrics",
    "full_text_metrics",
    "legacy_analysis_awaiting_full_text",
    "legacy_full_text_without_retrieval",
    "unresolved_candidate_pairs",
  ];
  await client.unsafe(`set statement_timeout = '${NARROWED_EXPLAIN_TIMEOUT_MS}ms'`);
  try {
    for (const component of components) {
      const narrowed = captureRendered({
        sql: `${ctePrefix}\n      select * from ${component}`,
        params: summaryQuery.params,
      });
      (report.explainPlans as Array<Record<string, unknown>>).push(await explain(client, narrowed, `summary-50000-component-${component}`));
      (report.queryCatalog as Record<string, unknown>)[narrowed.key] = { sql: narrowed.sql, parameterShape: narrowed.parameterShape };
    }
  } finally {
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
  }
}

async function main(): Promise<void> {
  assert(process.version === "v22.13.0", `Benchmark requires Node 22.13.0; running ${process.version}.`);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: "Slice 50 bounded interactive Review Report reads",
    startedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    postgres: null,
    fixture: { factSizes: [...FACT_SIZES], largeQuestionAndCriteriaCollections: LARGE_CONTEXT_SIZE, representedSourcesContext: LARGE_CONTEXT_SIZE, denseDedupRecordCounts: [...DENSE_SIZES], defaultContributorPageSize: 25, maxContributorPageSize: CONTRIBUTOR_PAGE_SIZE, contextPageSize: CONTEXT_PAGE_SIZE },
    measurementDefinitions: {
      apiPayloadBytes: "UTF-8 bytes of JSON serialization of the returned service DTO; not HTTP or RSC wire bytes.",
      pageQueryRows: "Rows returned by the final bounded page SELECT, including the optional pageSize+1 sentinel; contributor measurements at pageSize 50 verify no more than 51 page-query rows.",
      driverJsonBytes: "UTF-8 bytes from JSON serialization of postgres.js result rows; not PostgreSQL wire-protocol bytes.",
      returnedRows: "Sum of postgres.js rows returned by captured report-service SELECTs, including LIMIT pageSize+1 sentinels and scalar scope/total rows.",
      selectorTraversals: "For each selector on the 1k fixture, aggregates page count, returned items, and SELECT count across the complete keyset traversal; single-page size/DTO budgets remain attached only to individual measurements.",
      deepPageCoverage: "For each eligible 50k selector, records every measured page from page 3 through page 20 and page 21, with explicit skipped records when no continuation or deep page exists; aggregate fields are accounting only, not page-budget claims.",
      queryCatalog: "Exact parameterized SQL plus parameter type/length shapes; parameter values are omitted.",
      explainPlans: "PostgreSQL 16 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for captured final application SELECTs; node actual rows/loops, buffers, sorts, and temp blocks are retained.",
      summaryComponentPlans: "On the 50k fact fixture, each canonical flowSummary aggregate CTE and exact unresolved-pair count is also explained independently from the same captured SQL with a 30s diagnostic timeout; the application remains capped at 120s.",
    },
    database: { disposable: true, created: false, cleanupCompleted: false, migration0038Present: false },
    measurements: [] as Measurement[],
    selectorTraversals: [] as Array<Record<string, unknown>>,
    deepPageCoverage: [] as Array<Record<string, unknown>>,
    explainPlans: [] as Array<Record<string, unknown>>,
    queryCatalog: {} as Record<string, unknown>,
    failures: [] as string[],
  };
  let admin: postgres.Sql | undefined;
  let databaseClient: postgres.Sql | undefined;
  let databaseName: string | undefined;
  let databaseUrl: string | undefined;
  let dbCreated = false;
  let cleanupCompleted = false;
  const sink: Sink = { queries: [] };

  try {
    const configuredUrl = resolveDatabaseUrl();
    const adminUrl = new URL(configuredUrl);
    adminUrl.hostname = "127.0.0.1";
    admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
    const [server] = await admin.unsafe("select current_setting('server_version') as version, current_setting('server_version_num')::int as version_num") as unknown as Array<{ version: string; version_num: number }>;
    assert(server && Math.floor(Number(server.version_num) / 10_000) === 16, `Benchmark requires PostgreSQL 16; connected version is ${server?.version ?? "unknown"}.`);
    report.postgres = { serverVersion: server.version, serverVersionNumber: Number(server.version_num) };
    databaseName = `litreview_slice50_bench_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    dbCreated = true;
    (report.database as Record<string, unknown>).created = true;
    const targetUrl = new URL(adminUrl.toString());
    targetUrl.pathname = `/${databaseName}`;
    databaseUrl = targetUrl.toString();
    databaseClient = postgres(databaseUrl, { max: 1, prepare: false, connection: { application_name: "slice50-review-report-benchmark" } });
    await databaseClient.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}'`);
    const migrationDb = drizzle(databaseClient, { schema });
    await migrate(migrationDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });
    const migrationFiles = readdirSync(resolve(process.cwd(), "drizzle")).filter((name) => /^0038/.test(name));
    (report.database as Record<string, unknown>).migration0038Present = migrationFiles.length > 0;
    assert(migrationFiles.length === 0, "Unexpected 0038 migration in Slice 50 disposable DB benchmark.");
    const [indexRows] = await databaseClient.unsafe(`select json_agg(json_build_object('name',indexname,'definition',indexdef) order by indexname)::text as indexes
      from pg_indexes where schemaname=current_schema() and tablename in
      ('search_runs','retrieved_records','retrieved_record_matches','papers','screening_decisions','full_text_screening_decisions','full_text_retrieval_attempts','retrieved_record_deduplication_decisions','research_questions','screening_criteria','full_text_screening_criteria','search_sources')`) as unknown as Array<{ indexes: string | null }>;
    (report.database as Record<string, unknown>).relevantIndexes = indexRows?.indexes ? JSON.parse(indexRows.indexes) as unknown : [];

    const ordinaryDb = migrationDb as unknown as Database;
    const setup = createReviewServices(ordinaryDb);
    const projectCases: Array<{ size: number; id: string; title: string; sources: Array<{ id: string; sourceKey: string; displayName: string }>; service: ReturnType<typeof createReviewServices> }> = [];
    for (const size of FACT_SIZES) {
      const seeded = await startFactProject(setup, migrationDb as unknown as Database, databaseClient, size, sink);
      projectCases.push({ size, id: seeded.id, title: seeded.title, sources: seeded.sources, service: seeded.bounded });
      (report.fixture as Record<string, unknown>)[`factProject${size}`] = {
        projectId: seeded.id,
        runs: Math.max(5, Math.ceil(size / 100)), retrievedRecords: size,
        currentLinkedRecords: size, acquisitionPapers: size - Math.floor(size / 5),
        titleAbstractDecisions: size - Math.floor(size / 5), fullTextDecisionPopulation: Math.floor(size / 3),
        retrievalPopulation: Math.floor(size * 0.6), zeroResultRuns: Math.floor(Math.max(5, Math.ceil(size / 100)) / 13),
        exclusionCriterionContext: LARGE_CONTEXT_SIZE, fullTextCriterionContext: LARGE_CONTEXT_SIZE,
        questionContext: LARGE_CONTEXT_SIZE, sourceSelectors: 5,
      };
    }
    const contextProject = await makeContextProject(setup, databaseClient);
    (report.fixture as Record<string, unknown>).largeRepresentedSourceContext = { projectId: contextProject.id, sources: LARGE_CONTEXT_SIZE, runs: LARGE_CONTEXT_SIZE };

    const measuredDb = monitorDatabase(migrationDb as unknown as Database, sink);
    const boundedService = createReviewServices(measuredDb);
    const legacyService = createReviewServices(measuredDb);
    const pageBudget = { selects: [2, 2] as [number, number], bytes: 256 * 1024, rows: CONTRIBUTOR_PAGE_SIZE + 2, maxPageRows: CONTRIBUTOR_PAGE_SIZE + 1 };
    for (const project of projectCases) {
      const summary = await addMeasurement(report, sink, `summary-${project.size}`, () => boundedService.getInteractiveReviewReportSummary(project.id), { selects: [1, 4], bytes: 256 * 1024, rows: 24 });
      if (project.size === 1_000 || project.size === 50_000) await explainAll(databaseClient, report, `summary-${project.size}`, summary);
      if (project.size === 50_000) await explainSummaryComponents(databaseClient, report, summary);
      const summaryValue = summary.value as Awaited<ReturnType<typeof boundedService.getInteractiveReviewReportSummary>> | null;
      if (!summaryValue) continue;
      const selectors: ReviewReportContributorSelector[] = [
        ...REVIEW_REPORT_METRIC_KEYS.map((metric) => ({ scope: "metric" as const, metric })),
        ...(["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"] as const).map((metric) => ({ scope: "source" as const, sourceId: project.sources[0]!.id, metric })),
        ...(summaryValue.screening.exclusionReasons.items[0] ? [{ scope: "exclusionReason" as const, criterionId: summaryValue.screening.exclusionReasons.items[0].criterionId }] : []),
        ...(summaryValue.fullTextEligibility.exclusionReasons.items[0] ? [{ scope: "fullTextExclusionReason" as const, criterionId: summaryValue.fullTextEligibility.exclusionReasons.items[0].criterionId }] : []),
        { scope: "overlap" },
      ];
      for (const selector of selectors) {
        const family = selectorLabel(selector);
        const first = await addMeasurement(report, sink, `contributor-first-${project.size}-${family}`, () => boundedService.listReviewReportContributorPage(project.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE }), pageBudget);
        if (project.size === 1_000 && ["metric:reportedResultsTotal", "metric:duplicateRecordsCollapsed", "metric:unresolvedDuplicatePairs", "source:acquisitionPapers", "title-abstract-reason", "full-text-reason", "overlap"].includes(family)) await explainAll(databaseClient, report, `contributor-${family}`, first);
        const firstValue = first.value as Awaited<ReturnType<typeof boundedService.listReviewReportContributorPage>> | null;
        const firstContinuationFailure = failOnMissingContinuation(report, `contributor-first-${project.size}-${family}`, 1, first);
        let second: Awaited<ReturnType<typeof addMeasurement>> | undefined;
        if (hasValidContinuationCursor(firstValue)) {
          second = await addMeasurement(report, sink, `contributor-continuation-${project.size}-${family}`, () => boundedService.listReviewReportContributorPage(project.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE, cursor: firstValue.nextCursor }), pageBudget);
          const secondContinuationFailure = failOnMissingContinuation(report, `contributor-continuation-${project.size}-${family}`, 2, second);
          if (secondContinuationFailure) second.measurement.error = secondContinuationFailure;
          if (project.size === 1_000 && family === "metric:reportedResultsTotal") await explainAll(databaseClient, report, "contributor-reported-results-continuation", second);
        }
        if (project.size === 1_000) {
          await recordCompleteContributorTraversal({
            report, sink, label: `contributor-traversal-1k-${family}`, projectId: project.id, selector,
            initialPages: second ? [first, second] : [first],
            fetch: (cursor) => boundedService.listReviewReportContributorPage(project.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE, cursor }),
            budget: pageBudget,
          });
        }
        if (project.size === 50_000) {
          const secondValue = second?.value as Awaited<ReturnType<typeof boundedService.listReviewReportContributorPage>> | null | undefined;
          const continuationFailure = firstContinuationFailure
            ?? (first.measurement.status !== "completed" ? first.measurement.error ?? "Page 1 measurement failed." : null)
            ?? (second && second.measurement.status !== "completed" ? second.measurement.error ?? "Page 2 measurement failed." : null);
          await measureDeepPageCoverage({
            report, sink, label: `contributor-${project.size}-${family}`,
            startCursor: hasValidContinuationCursor(secondValue) ? secondValue.nextCursor : null,
            startHasMore: second ? secondValue?.hasMore : firstValue?.hasMore,
            startPageNumber: second ? 3 : 2, targetPageNumber: 21, startFailureReason: continuationFailure,
            fetch: (cursor) => boundedService.listReviewReportContributorPage(project.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE, cursor }),
            budget: pageBudget,
          });
        }
      }
      const kinds: ReviewReportContextKind[] = ["questions", "screening-criteria", "full-text-criteria", "sources", "exclusion-reasons", "full-text-exclusion-reasons"];
      for (const kind of kinds) {
        const first = await addMeasurement(report, sink, `context-first-${project.size}-${kind}`, () => boundedService.listReviewReportContextPage(project.id, kind, { pageSize: CONTEXT_PAGE_SIZE }), { selects: [1, 2], bytes: 128 * 1024, rows: 27 });
        const firstValue = first.value as Awaited<ReturnType<typeof boundedService.listReviewReportContextPage>> | null;
        const firstContinuationFailure = failOnMissingContinuation(report, `context-first-${project.size}-${kind}`, 1, first);
        let second: Awaited<ReturnType<typeof addMeasurement>> | undefined;
        if (hasValidContinuationCursor(firstValue)) {
          second = await addMeasurement(report, sink, `context-continuation-${project.size}-${kind}`, () => boundedService.listReviewReportContextPage(project.id, kind, { pageSize: CONTEXT_PAGE_SIZE, cursor: firstValue.nextCursor }), { selects: [1, 2], bytes: 128 * 1024, rows: 27 });
          failOnMissingContinuation(report, `context-continuation-${project.size}-${kind}`, 2, second);
          if (project.size === 50_000 && ["questions", "exclusion-reasons", "full-text-exclusion-reasons"].includes(kind)) await explainAll(databaseClient, report, `context-${kind}`, second);
        }
        if (project.size === 50_000) {
          const secondValue = second?.value as Awaited<ReturnType<typeof boundedService.listReviewReportContextPage>> | null | undefined;
          const continuationFailure = firstContinuationFailure
            ?? (first.measurement.status !== "completed" ? first.measurement.error ?? "Page 1 measurement failed." : null)
            ?? (second && second.measurement.status !== "completed" ? second.measurement.error ?? "Page 2 measurement failed." : null);
          await measureDeepPageCoverage({
            report, sink, label: `context-${project.size}-${kind}`,
            startCursor: hasValidContinuationCursor(secondValue) ? secondValue.nextCursor : null,
            startHasMore: second ? secondValue?.hasMore : firstValue?.hasMore,
            startPageNumber: second ? 3 : 2, targetPageNumber: 21, startFailureReason: continuationFailure,
            fetch: (cursor) => boundedService.listReviewReportContextPage(project.id, kind, { pageSize: CONTEXT_PAGE_SIZE, cursor }),
            budget: { selects: [1, 2], bytes: 128 * 1024, rows: 27 },
          });
        }
      }
      if (project.size === 1_000) {
        const oldInteractive = await addMeasurement(report, sink, "legacy-interactive-report-1k", () => legacyService.getInteractiveReviewReport(project.id));
        const oldReported = await addMeasurement(report, sink, "legacy-contributors-reported-results-1k", () => legacyService.listReviewReportContributors(project.id, { scope: "metric", metric: "reportedResultsTotal" }));
        const oldReasons = await addMeasurement(report, sink, "legacy-contributors-title-abstract-reason-1k", () => legacyService.listReviewReportContributors(project.id, selectorsReason(summaryValue)));
        const legacyCounts = (report.legacyCounts ??= []) as unknown[];
        legacyCounts.push({ interactivePayloadBytes: oldInteractive.measurement.apiPayloadBytes, reportedResultItems: contextItemCount(oldReported.value), reasonItems: contextItemCount(oldReasons.value) });
      } else if (project.size === 10_000 || project.size === 50_000) {
        addSkippedMeasurement(
          report,
          `legacy-interactive-report-${project.size}`,
          `Skipped by plan: avoid forcing the full unbounded legacy interactive report materialization at the ${project.size.toLocaleString()}-record scale.`,
        );
      }
    }

    const sourceContextPage = await addMeasurement(report, sink, "context-sources-large-first-2k", () => boundedService.listReviewReportContextPage(contextProject.id, "sources", { pageSize: CONTEXT_PAGE_SIZE }), { selects: [1, 2], bytes: 128 * 1024, rows: 27 });
    const sourceContextValue = sourceContextPage.value as Awaited<ReturnType<typeof boundedService.listReviewReportContextPage>> | null;
    const sourceFirstContinuationFailure = failOnMissingContinuation(report, "context-sources-large-first-2k", 1, sourceContextPage);
    let sourceContextSecond: Awaited<ReturnType<typeof addMeasurement>> | undefined;
    if (hasValidContinuationCursor(sourceContextValue)) {
      sourceContextSecond = await addMeasurement(report, sink, "context-sources-large-continuation-2k", () => boundedService.listReviewReportContextPage(contextProject.id, "sources", { pageSize: CONTEXT_PAGE_SIZE, cursor: sourceContextValue.nextCursor }), { selects: [1, 2], bytes: 128 * 1024, rows: 27 });
      failOnMissingContinuation(report, "context-sources-large-continuation-2k", 2, sourceContextSecond);
    }
    if (sourceContextValue?.hasMore || sourceFirstContinuationFailure || sourceContextPage.measurement.status !== "completed") {
      const secondValue = sourceContextSecond?.value as Awaited<ReturnType<typeof boundedService.listReviewReportContextPage>> | null | undefined;
      await measureDeepPageCoverage({
        report, sink, label: "context-sources-large-2k", startCursor: hasValidContinuationCursor(secondValue) ? secondValue.nextCursor : null,
        startHasMore: sourceContextSecond ? secondValue?.hasMore : sourceContextValue?.hasMore,
        startPageNumber: sourceContextSecond ? 3 : 2, targetPageNumber: 21,
        startFailureReason: sourceFirstContinuationFailure
          ?? (sourceContextPage.measurement.status !== "completed" ? sourceContextPage.measurement.error ?? "Page 1 measurement failed." : null)
          ?? (sourceContextSecond && sourceContextSecond.measurement.status !== "completed" ? sourceContextSecond.measurement.error ?? "Page 2 measurement failed." : null),
        fetch: (cursor) => boundedService.listReviewReportContextPage(contextProject.id, "sources", { pageSize: CONTEXT_PAGE_SIZE, cursor }),
        budget: { selects: [1, 2], bytes: 128 * 1024, rows: 27 },
      });
    } else {
      addSkippedMeasurement(report, "context-sources-large-2k-deep-page-21", "No continuation cursor after the first context page.");
      (report.deepPageCoverage as Array<Record<string, unknown>>).push({ label: "context-sources-large-2k", startPageNumber: 3, targetPageNumber: 21, status: "skipped", seekPagesMeasured: 0, pageRequests: 0, selectCount: 0, returnedRows: 0, reason: "No continuation cursor after the first context page." });
    }

    for (const size of DENSE_SIZES) {
      const denseProject = await setup.createProject({ title: `Slice 50 dense dedup ${size} benchmark` });
      const source = (await setup.listSearchSources(denseProject.id)).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))[0]!;
      const strategy = await setup.createSearchStrategy(denseProject.id, { searchSourceId: source.id, name: "Dense benchmark strategy", queryText: "Dense same-title query" });
      await seedDenseProject(databaseClient, denseProject.id, source.id, source.sourceKey, source.displayName, strategy.id, size);
      const service = createReviewServices(measuredDb);
      (report.fixture as Record<string, unknown>)[`dense${size}`] = { projectId: denseProject.id, records: size, theoreticalUnprunedPairs: (size * (size - 1)) / 2, adjudicatedPairs: 1, sharedDoiRecords: 20, expectedCandidateRanks: ["strong", "possible"],
        note: "The pair set remains output-sensitive; page bounds do not imply O(pageSize) candidate generation." };
      const denseSummary = await addMeasurement(report, sink, `summary-dense-${size}`, () => service.getInteractiveReviewReportSummary(denseProject.id), { selects: [1, 4], bytes: 256 * 1024, rows: 24 });
      const selector: ReviewReportContributorSelector = { scope: "metric", metric: "unresolvedDuplicatePairs" };
      const first = await addMeasurement(report, sink, `dense-contributor-first-${size}`, () => service.listReviewReportContributorPage(denseProject.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE }), pageBudget);
      await explainAll(databaseClient, report, `dense-${size}-pair-page-and-total`, first);
      const firstPage = first.value as Awaited<ReturnType<typeof service.listReviewReportContributorPage>> | null;
      const firstContinuationFailure = failOnMissingContinuation(report, `dense-contributor-first-${size}`, 1, first);
      let second: Awaited<ReturnType<typeof addMeasurement>> | undefined;
      if (hasValidContinuationCursor(firstPage)) {
        second = await addMeasurement(report, sink, `dense-contributor-continuation-${size}`, () => service.listReviewReportContributorPage(denseProject.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE, cursor: firstPage.nextCursor }), pageBudget);
        failOnMissingContinuation(report, `dense-contributor-continuation-${size}`, 2, second);
      }
      if (firstPage?.hasMore || firstContinuationFailure || first.measurement.status !== "completed") {
        const secondPage = second?.value as Awaited<ReturnType<typeof service.listReviewReportContributorPage>> | null | undefined;
        await measureDeepPageCoverage({
          report, sink, label: `dense-contributor-${size}`, startCursor: hasValidContinuationCursor(secondPage) ? secondPage.nextCursor : null,
          startHasMore: second ? secondPage?.hasMore : firstPage?.hasMore,
          startPageNumber: second ? 3 : 2, targetPageNumber: 21,
          startFailureReason: firstContinuationFailure
            ?? (first.measurement.status !== "completed" ? first.measurement.error ?? "Page 1 measurement failed." : null)
            ?? (second && second.measurement.status !== "completed" ? second.measurement.error ?? "Page 2 measurement failed." : null),
          fetch: (cursor) => service.listReviewReportContributorPage(denseProject.id, selector, { pageSize: CONTRIBUTOR_PAGE_SIZE, cursor }),
          budget: pageBudget,
        });
      } else {
        addSkippedMeasurement(report, `dense-contributor-${size}-deep-page-21`, "No continuation cursor after the first contributor page.");
        (report.deepPageCoverage as Array<Record<string, unknown>>).push({ label: `dense-contributor-${size}`, startPageNumber: 3, targetPageNumber: 21, status: "skipped", seekPagesMeasured: 0, pageRequests: 0, selectCount: 0, returnedRows: 0, reason: "No continuation cursor after the first contributor page." });
      }
      if (size === 250) await addMeasurement(report, sink, "legacy-interactive-report-dense-250", () => service.getInteractiveReviewReport(denseProject.id));
      else (report.measurements as Measurement[]).push({ label: "legacy-interactive-report-dense-1000", status: "skipped", elapsedMs: null, apiPayloadBytes: null, itemCount: null, pageQueryRows: null, selectCount: 0, returnedRows: null, driverJsonBytes: null, contributionTotal: null, hasMore: null, queryKeys: [], error: "skipped by plan: dense legacy full candidate materialization was not forced at 1,000 records" });
      void denseSummary;
    }

    await databaseClient.unsafe("analyze");
    const [finalVersion] = await databaseClient.unsafe("select current_setting('server_version') as version") as unknown as Array<{ version: string }>;
    (report.database as Record<string, unknown>).cleanupCompleted = false;
    (report.database as Record<string, unknown>).benchmarkDatabaseName = databaseName;
    (report.database as Record<string, unknown>).finalServerVersion = finalVersion?.version ?? null;
  } catch (error) {
    (report.failures as string[]).push(safeErrorMessage(error));
  } finally {
    if (databaseClient) {
      try { await databaseClient.end(); } catch (error) { (report.failures as string[]).push(`database client close failed: ${safeErrorMessage(error, 500)}`); }
    }
    if (admin && dbCreated && databaseName) {
      try { await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`); cleanupCompleted = true; }
      catch (error) { (report.failures as string[]).push(`disposable database cleanup failed: ${safeErrorMessage(error)}`); }
    }
    if (admin) {
      try { await admin.end(); }
      catch (error) { (report.failures as string[]).push(`admin client close failed: ${safeErrorMessage(error, 500)}`); }
    }
    (report.database as Record<string, unknown>).cleanupCompleted = cleanupCompleted;
    (report.database as Record<string, unknown>).databaseName = databaseName ?? null;
    report.completedAt = new Date().toISOString();
    report.status = (report.failures as string[]).length === 0 && cleanupCompleted ? "completed" : "failed";
    mkdirSync(resolve(process.cwd(), "docs/benchmarks"), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  assert((report.failures as string[]).length === 0, (report.failures as string[]).join("\n"));
  assert(cleanupCompleted, "Disposable benchmark database cleanup was not confirmed.");
  console.log(`Slice 50 benchmark wrote ${OUTPUT}; cleanup confirmed.`);
}

function selectorsReason(summary: Awaited<ReturnType<ReturnType<typeof createReviewServices>["getInteractiveReviewReportSummary"]>>): ReviewReportContributorSelector {
  const reason = summary.screening.exclusionReasons.items[0];
  assert(reason, "The synthetic fixture did not create a current title/abstract reason aggregate.");
  return { scope: "exclusionReason", criterionId: reason.criterionId };
}

main().catch((error) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
