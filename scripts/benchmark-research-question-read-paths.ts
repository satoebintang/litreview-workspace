import "dotenv/config";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createResearchQuestionBoundedReadServices } from "@/application/research-question-bounded-read-services";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";

const POPULATION_SIZES = [1_000, 10_000, 50_000] as const;
const TARGETS_PER_KIND = 2_000;
const LINKED_PER_KIND = 1_000;
const OFF_PAGE_CLAIM_SUPPORTS = 5_000;
const SEED_CHUNK_SIZE = 5_000;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_TIMEOUT_MS = 600_000;
const LEGACY_BASELINE_CASE = "legacy-full-matrix-practical-1k-questions-1k-included-papers";
const PROJECT_ORDER_INDEX = "research_questions_project_order_idx";
const BENCHMARK_OUTPUT = resolve(process.cwd(), "docs/benchmarks/slice48-research-question-read-paths.json");
const LONG_QUESTION_LABEL_CODEPOINTS = 360;
const LONG_PAPER_TITLE_CODEPOINTS = 320;
const LONG_ANSWER_CODEPOINTS = 19_999;
const PINNED_CONTEXT_CODEPOINTS = 10_000;

type CapturedQuery = {
  sql: string;
  params: unknown[];
  driverRows: number | null;
  driverJsonBytes: number | null;
};
type QuerySink = { queries: CapturedQuery[]; pending: Map<string, CapturedQuery[]> };
type Measurement = {
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  apiPayloadBytes: number | null;
  projectedItemCount: number | null;
  projectedCardinality: Record<string, number> | null;
  returnedPageHasMore: boolean | null;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  heapDeltaBytes: number;
  statementCount: number;
  selectCount: number;
  rawDriverRows: number | null;
  rawDriverJsonBytes: number | null;
  driverRowCaptureComplete: boolean;
  queries: CapturedQuery[];
  value: unknown | null;
  error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function readProjectOrderIndexCatalog(client: postgres.Sql) {
  const [row] = await client.unsafe(
    `select i.indisvalid,i.indisready,
       (select json_agg(a.attname::text order by keys.ordinality)::text
        from unnest(i.indkey) with ordinality as keys(attnum,ordinality)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=keys.attnum
        where keys.ordinality<=i.indnkeyatts) as key_columns_json
     from pg_index i
     join pg_class idx on idx.oid=i.indexrelid
     join pg_class tbl on tbl.oid=i.indrelid
     join pg_namespace ns on ns.oid=tbl.relnamespace
     where idx.relname=$1 and tbl.relname='research_questions' and ns.nspname=current_schema()`,
    [PROJECT_ORDER_INDEX],
  ) as unknown as Array<{ indisvalid: boolean; indisready: boolean; key_columns_json: string }>;
  if (!row) return null;
  return {
    valid: row.indisvalid,
    ready: row.indisready,
    columns: JSON.parse(row.key_columns_json) as string[],
  };
}

function safeError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } }
    : null;
  const message = typeof record?.cause?.message === "string"
    ? `${String(record?.name ?? "Error")}: ${record.cause.message}${record.cause.code ? ` (SQLSTATE ${String(record.cause.code)})` : ""}`
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1_000);
}

function jsonValue(value: unknown) {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === "bigint") return child.toString();
    if (child instanceof Date) return child.toISOString();
    if (Buffer.isBuffer(child)) return { $bufferBytes: child.byteLength };
    return child;
  }) ?? "null";
}

function queryKey(sqlText: string, params: unknown[]) {
  return `${sqlText}\u0000${jsonValue(params)}`;
}

function createQuerySink(): QuerySink {
  return { queries: [], pending: new Map() };
}

function clearQuerySink(sink: QuerySink) {
  sink.queries.length = 0;
  sink.pending.clear();
}

function takeCapturedQuery(sink: QuerySink, sqlText: string, params: unknown[]) {
  const key = queryKey(sqlText, params);
  const queue = sink.pending.get(key);
  const captured = queue?.shift();
  if (queue && queue.length === 0) sink.pending.delete(key);
  return captured;
}

function captureQueryResult(query: object, captured: CapturedQuery): object {
  return new Proxy(query, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (property === "then" && typeof member === "function") {
        return (resolve: ((value: unknown) => unknown) | undefined, reject: ((reason: unknown) => unknown) | undefined) => Reflect.apply(member, target, [
          (result: unknown) => {
            const rows = Array.isArray(result) ? result : null;
            captured.driverRows = rows?.length ?? null;
            captured.driverJsonBytes = rows ? Buffer.byteLength(jsonValue(rows), "utf8") : null;
            return resolve ? resolve(result) : result;
          },
          reject,
        ]);
      }
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const next = Reflect.apply(member, target, args) as unknown;
        return next && typeof next === "object" && typeof (next as { then?: unknown }).then === "function"
          ? captureQueryResult(next, captured)
          : next;
      };
    },
  });
}

function capturePostgresClient(client: postgres.Sql, sink: QuerySink, cache = new WeakMap<object, postgres.Sql>()): postgres.Sql {
  const cached = cache.get(client as object);
  if (cached) return cached;
  const proxy = new Proxy(client as object, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (property === "unsafe" && typeof member === "function") {
        return (sqlText: string, params?: unknown[], ...rest: unknown[]) => {
          const result = Reflect.apply(member, target, [sqlText, params, ...rest]) as unknown;
          const captured = takeCapturedQuery(sink, sqlText, params ?? []);
          return captured && result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function"
            ? captureQueryResult(result, captured)
            : result;
        };
      }
      if ((property === "begin" || property === "savepoint") && typeof member === "function") {
        return (...args: unknown[]) => {
          if (typeof args[0] !== "function") return Reflect.apply(member, target, args);
          const callback = args[0] as (nested: postgres.Sql) => unknown;
          return Reflect.apply(member, target, [
            (nested: postgres.Sql) => callback(capturePostgresClient(nested, sink, cache)),
            ...args.slice(1),
          ]);
        };
      }
      return typeof member === "function" ? member.bind(target) : member;
    },
  }) as postgres.Sql;
  cache.set(client as object, proxy);
  return proxy;
}

function captureDatabaseQueries(client: postgres.Sql, sink: QuerySink): Database {
  const baseDb = drizzle(capturePostgresClient(client, sink), {
    schema,
    logger: {
      logQuery(sqlText, params) {
        const captured: CapturedQuery = { sql: sqlText, params: [...params], driverRows: null, driverJsonBytes: null };
        sink.queries.push(captured);
        const key = queryKey(sqlText, [...params]);
        const queue = sink.pending.get(key) ?? [];
        queue.push(captured);
        sink.pending.set(key, queue);
      },
    },
  }) as Database;

  return baseDb as Database;
}

function returnedCardinality(value: unknown): { items: number | null; projected: Record<string, number> | null } {
  if (!value || typeof value !== "object") return { items: null, projected: null };
  const row = value as Record<string, unknown>;
  if (Array.isArray(row.rows)) return { items: row.rows.length, projected: { matrixQuestions: row.rows.length } };
  if (Array.isArray(row.items)) return { items: row.items.length, projected: { listItems: row.items.length } };
  if (row.snapshot && typeof row.snapshot === "object") {
    const snapshot = row.snapshot as Record<string, unknown>;
    const claims = Array.isArray(snapshot.claimContexts) ? snapshot.claimContexts.length : 0;
    const syntheses = Array.isArray(snapshot.synthesisContexts) ? snapshot.synthesisContexts.length : 0;
    return { items: claims + syntheses, projected: { exactClaimContexts: claims, exactSynthesisContexts: syntheses } };
  }
  if (row.history && typeof row.history === "object" && Array.isArray((row.history as Record<string, unknown>).items)) {
    const history = (row.history as Record<string, unknown>).items as unknown[];
    return { items: history.length, projected: { historyEvents: history.length, targetDetails: 1 } };
  }
  if (row.links && typeof row.links === "object") {
    const links = row.links as Record<string, unknown>;
    const projected = Object.fromEntries(Object.entries(links).map(([key, page]) => [
      key,
      page && typeof page === "object" && Array.isArray((page as Record<string, unknown>).items)
        ? ((page as Record<string, unknown>).items as unknown[]).length : 0,
    ]));
    return { items: Object.values(projected).reduce((sum, count) => sum + count, 0), projected };
  }
  return { items: null, projected: null };
}

async function measure(sink: QuerySink, run: () => Promise<unknown>, captureDriverRows = true): Promise<Measurement> {
  clearQuerySink(sink);
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const startedAt = process.hrtime.bigint();
  try {
    const value = await run();
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const queries = [...sink.queries];
    const cardinality = returnedCardinality(value);
    const capturedRows = queries.every((query) => !/^\s*(select|with)\b/i.test(query.sql) || (query.driverRows !== null && query.driverJsonBytes !== null));
    const returnedPageHasMore = typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).hasMore === "boolean"
      ? Boolean((value as Record<string, unknown>).hasMore)
      : null;
    return {
      status: "completed",
      wallTimeMs: elapsed,
      apiPayloadBytes: Buffer.byteLength(jsonValue(value), "utf8"),
      projectedItemCount: cardinality.items,
      projectedCardinality: cardinality.projected,
      returnedPageHasMore,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
      statementCount: queries.length,
      selectCount: queries.filter((query) => /^\s*(select|with)\b/i.test(query.sql)).length,
      rawDriverRows: captureDriverRows && capturedRows ? queries.reduce((sum, query) => sum + (query.driverRows ?? 0), 0) : null,
      rawDriverJsonBytes: captureDriverRows && capturedRows ? queries.reduce((sum, query) => sum + (query.driverJsonBytes ?? 0), 0) : null,
      driverRowCaptureComplete: captureDriverRows && capturedRows,
      queries,
      value,
    };
  } catch (error) {
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const message = safeError(error);
    const queries = [...sink.queries];
    return {
      status: /statement timeout|canceling statement/i.test(message) ? "timed_out" : "failed",
      wallTimeMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      apiPayloadBytes: null,
      projectedItemCount: null,
      projectedCardinality: null,
      returnedPageHasMore: null,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
      statementCount: queries.length,
      selectCount: queries.filter((query) => /^\s*(select|with)\b/i.test(query.sql)).length,
      rawDriverRows: null,
      rawDriverJsonBytes: null,
      driverRowCaptureComplete: false,
      queries,
      value: null,
      error: message,
    };
  }
}

function flattenPlan(plan: Record<string, unknown>) {
  const nodes: Array<Record<string, unknown>> = [];
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    const current = node as Record<string, unknown>;
    nodes.push({
      nodeType: current["Node Type"], relation: current["Relation Name"], index: current["Index Name"],
      actualRows: current["Actual Rows"], loops: current["Actual Loops"],
      rowsRemovedByFilter: current["Rows Removed by Filter"], rowsRemovedByJoinFilter: current["Rows Removed by Join Filter"],
      sharedHitBlocks: current["Shared Hit Blocks"], sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"], tempWrittenBlocks: current["Temp Written Blocks"],
      sortMethod: current["Sort Method"], sortSpaceType: current["Sort Space Type"], sortSpaceUsed: current["Sort Space Used"],
      filter: current.Filter, indexCondition: current["Index Cond"],
    });
    if (Array.isArray(current.Plans)) for (const child of current.Plans) visit(child);
  }
  visit(plan.Plan);
  const root = plan.Plan as Record<string, unknown> | undefined;
  let scanNodeRowWork = 0;
  for (const node of nodes) {
    if (typeof node.nodeType !== "string" || !node.nodeType.includes("Scan")) continue;
    const loops = Number(node.loops ?? 1);
    scanNodeRowWork += (Number(node.actualRows ?? 0) + Number(node.rowsRemovedByFilter ?? 0) + Number(node.rowsRemovedByJoinFilter ?? 0)) * loops;
  }
  return {
    planningTimeMs: plan["Planning Time"] ?? null,
    executionTimeMs: plan["Execution Time"] ?? null,
    rootNodeType: root?.["Node Type"] ?? null,
    rootActualRows: root?.["Actual Rows"] ?? null,
    rootLoops: root?.["Actual Loops"] ?? null,
    rootSharedHitBlocks: root?.["Shared Hit Blocks"] ?? null,
    rootSharedReadBlocks: root?.["Shared Read Blocks"] ?? null,
    rootTempReadBlocks: root?.["Temp Read Blocks"] ?? null,
    rootTempWrittenBlocks: root?.["Temp Written Blocks"] ?? null,
    scanNodeRowWorkDiagnostic: {
      value: scanNodeRowWork,
      definition: "Sum of actual rows plus rows removed by filter/join filter across scan nodes, multiplied by loops. Nested, subquery, and CTE scans can recount rows; this is diagnostic scan-node work, not unique tuples or physical reads.",
    },
    nodes,
  };
}

async function explainMeasurement(client: postgres.Sql, name: string, measurement: Measurement) {
  const plans: Array<Record<string, unknown>> = [];
  for (let index = 0; index < measurement.queries.length; index += 1) {
    const query = measurement.queries[index]!;
    if (!/^\s*(select|with)\b/i.test(query.sql)) continue;
    try {
      const result = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params) as unknown as Array<Record<string, unknown>>;
      const raw = result[0]?.["QUERY PLAN"] ?? result[0]?.["query_plan"];
      const parsed = typeof raw === "string" ? JSON.parse(raw) as Array<Record<string, unknown>> : raw as Array<Record<string, unknown>>;
      const plan = parsed[0]!;
      plans.push({
        endpoint: name,
        queryIndex: index,
        status: "completed",
        sql: query.sql,
        params: query.params,
        summary: flattenPlan(plan),
        explainAnalyzeBuffersFormatJson: plan,
      });
    } catch (error) {
      plans.push({ endpoint: name, queryIndex: index, status: /statement timeout|canceling statement/i.test(safeError(error)) ? "timed_out" : "failed", sql: query.sql, params: query.params, error: safeError(error) });
    }
  }
  return plans;
}

async function recordMeasurement(client: postgres.Sql, name: string, measurement: Measurement, planCollection: Array<Record<string, unknown>>, shouldExplain = true) {
  const publicMeasurement = { ...measurement } as Record<string, unknown>;
  delete publicMeasurement.value;
  delete publicMeasurement.queries;
  const queryRecords = measurement.queries.map((query) => ({ ...query }));
  let plans: Array<Record<string, unknown>> = [];
  if (shouldExplain && measurement.status === "completed") plans = await explainMeasurement(client, name, measurement);
  planCollection.push(...plans);
  return { name, ...publicMeasurement, capturedSelects: queryRecords, explainPlanCount: plans.length };
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function makeIds(count: number) {
  return Array.from({ length: count }, () => randomUUID());
}

function encodeCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function seedQuestionRange(client: postgres.Sql, projectId: string, start: number, end: number) {
  if (end < start) return;
  await client.unsafe(
    `insert into research_questions (project_id,identifier,label,sort_order)
     select $1::uuid,
       case when n<=100 then repeat('界',96)||lpad(n::text,4,'0') else 'RQ-BENCH-'||lpad(n::text,8,'0') end,
       case when n<=100 then repeat('漢',${LONG_QUESTION_LABEL_CODEPOINTS})||n::text else 'Benchmark research question '||n::text end,
       n-1
     from generate_series($2::integer,$3::integer) n`,
    [projectId, start, end],
  );
}

async function seedPaperRange(client: postgres.Sql, projectId: string, start: number, end: number) {
  if (end < start) return [] as Array<{ id: string; title: string }>;
  const all: Array<{ id: string; title: string }> = [];
  for (let first = start; first <= end; first += SEED_CHUNK_SIZE) {
    const last = Math.min(end, first + SEED_CHUNK_SIZE - 1);
    await client.begin(async (tx) => {
      await tx.unsafe(`set local statement_timeout = '${SEED_TIMEOUT_MS}'`);
      const inserted = await tx.unsafe(
        `insert into papers (project_id,title,abstract,created_at)
         select $1::uuid,
           case when n=1 then 'Long-title fixture '||repeat('題',${LONG_PAPER_TITLE_CODEPOINTS}) else 'Slice 48 benchmark Paper '||lpad(n::text,8,'0') end,
           case when n=1 then repeat('文',1200) else 'Synthetic benchmark abstract for an included Paper.' end,
           '2026-01-01T00:00:00Z'::timestamptz + (n * interval '1 millisecond')
         from generate_series($2::integer,$3::integer) n returning id::text as id,title`,
        [projectId, first, last],
      ) as unknown as Array<{ id: string; title: string }>;
      all.push(...inserted);
      const ids = inserted.map((paper) => paper.id);
      await tx.unsafe(
        "insert into screening_decisions (project_id,paper_id,stage,decision) select $1::uuid,paper_id,'title_abstract','include' from unnest($2::uuid[]) as p(paper_id)",
        [projectId, ids],
      );
      await tx.unsafe(
        "insert into full_text_retrieval_attempts (project_id,paper_id,outcome,attempted_at) select $1::uuid,paper_id,'retrieved',now() from unnest($2::uuid[]) as p(paper_id)",
        [projectId, ids],
      );
      await tx.unsafe(
        "insert into full_text_screening_decisions (project_id,paper_id,decision) select $1::uuid,paper_id,'include' from unnest($2::uuid[]) as p(paper_id)",
        [projectId, ids],
      );
    });
  }
  return all;
}

async function seedExtractionValues(client: postgres.Sql, projectId: string, paperIds: string[], fieldIds: string[]) {
  let firstRevisionId: string | null = null;
  for (const paperChunk of chunks(paperIds, SEED_CHUNK_SIZE)) {
    await client.begin(async (tx) => {
      await tx.unsafe(`set local statement_timeout = '${SEED_TIMEOUT_MS}'`);
      const valueRows = await tx.unsafe(
        `insert into extraction_values (project_id,paper_id,field_id)
         select $1::uuid,p.paper_id,f.field_id
         from unnest($2::uuid[]) as p(paper_id) cross join unnest($3::uuid[]) as f(field_id)
         returning id::text as id,paper_id::text as paper_id,field_id::text as field_id`,
        [projectId, paperChunk, fieldIds],
      ) as unknown as Array<{ id: string; paper_id: string; field_id: string }>;
      const revisionRows = await tx.unsafe(
        `insert into extraction_value_revisions (project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value)
         select $1::uuid,paper_id,field_id,value_id,'short_text','present',
           case when paper_id=(select id from papers where project_id=$1::uuid order by created_at,id limit 1) then repeat('值',500) else 'Synthetic extraction value for '||left(paper_id::text,8) end
         from unnest($2::uuid[],$3::uuid[],$4::uuid[]) as v(value_id,paper_id,field_id)
         returning id::text as id,paper_id::text as paper_id,field_id::text as field_id`,
        [projectId, valueRows.map((row) => row.id), valueRows.map((row) => row.paper_id), valueRows.map((row) => row.field_id)],
      ) as unknown as Array<{ id: string; paper_id: string; field_id: string }>;
      if (!firstRevisionId && revisionRows.length) firstRevisionId = revisionRows[0]!.id;
      await tx.unsafe("update extraction_value_revisions set finalized_at=created_at where project_id=$1::uuid and id=any($2::uuid[])", [projectId, revisionRows.map((row) => row.id)]);
    });
  }
  assert(firstRevisionId, "Synthetic finally included Papers need one finalized extraction revision.");
  return firstRevisionId;
}

async function seedTargetDimensions(
  client: postgres.Sql,
  projectId: string,
  evidenceId: string,
  extractionRevisionId: string,
  fields: string[],
) {
  const evidenceSets = makeIds(TARGETS_PER_KIND);
  const synthesisStatements = makeIds(TARGETS_PER_KIND);
  const synthesisRevisions = makeIds(TARGETS_PER_KIND);
  const claims = makeIds(TARGETS_PER_KIND);
  const claimRevisions = makeIds(TARGETS_PER_KIND);
  const maxClaims = makeIds(100);
  const maxClaimRevisions = makeIds(100);
  const maxSynthesisStatements = makeIds(100);
  const maxSynthesisRevisions = makeIds(100);
  const offPageClaims = makeIds(OFF_PAGE_CLAIM_SUPPORTS);
  const offPageClaimRevisions = makeIds(OFF_PAGE_CLAIM_SUPPORTS);
  const claimText = "Literal %_ benchmark linked Claim text with exact support and page-bounded eligibility. ";
  const synthesisText = "Literal %_ benchmark synthesis statement text with an exact finalized support revision. ";
  await client.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${SEED_TIMEOUT_MS}'`);
    // Extraction fields are created before values so one current linked field
    // can carry real per-Paper coverage through the full benchmark scale.
    await tx.unsafe(
      `insert into evidence_sets (id,project_id,name)
       select id,$1::uuid,case when n>1000 then 'Literal %_ benchmark evidence set '||lpad(n::text,4,'0') else 'Benchmark evidence set '||lpad(n::text,4,'0') end
       from unnest($2::uuid[]) with ordinality as x(id,n)`,
      [projectId, evidenceSets],
    );
    await tx.unsafe(
      `insert into evidence_set_composition_revisions (project_id,evidence_set_id,operation_kind)
       select $1::uuid,set_id,'created' from unnest($2::uuid[]) as sets(set_id)`,
      [projectId, evidenceSets],
    );
    await tx.unsafe(
      `insert into synthesis_statements (id,project_id)
       select id,$1::uuid from unnest($2::uuid[]) as x(id)`,
      [projectId, synthesisStatements],
    );
    await tx.unsafe(
      `insert into synthesis_revisions (id,project_id,synthesis_statement_id,state,statement_text,finalized_at)
       select revision_id,$1::uuid,target_id,'active',
         case when n=1 then repeat('界',${PINNED_CONTEXT_CODEPOINTS}) else repeat($4::text,12)||lpad(n::text,4,'0') end,null
       from unnest($2::uuid[],$3::uuid[]) with ordinality as x(target_id,revision_id,n)`,
      [projectId, synthesisStatements, synthesisRevisions, synthesisText],
    );
    await tx.unsafe(
      `insert into synthesis_revision_supports (project_id,synthesis_revision_id,extraction_revision_id)
       select $1::uuid,revision_id,$3::uuid from unnest($2::uuid[]) as x(revision_id)`,
      [projectId, synthesisRevisions, extractionRevisionId],
    );
    await tx.unsafe(
      `insert into claims (id,project_id) select id,$1::uuid from unnest($2::uuid[]) as x(id)`,
      [projectId, [...claims, ...maxClaims, ...offPageClaims]],
    );
    await tx.unsafe(
      `insert into claim_revisions (id,project_id,claim_id,state,claim_text,finalized_at)
       select revision_id,$1::uuid,target_id,'active',
         case when n=1 then repeat('界',${PINNED_CONTEXT_CODEPOINTS}) else repeat($4::text,12)||lpad(n::text,4,'0') end,null
       from unnest($2::uuid[],$3::uuid[]) with ordinality as x(target_id,revision_id,n)`,
      [projectId, claims, claimRevisions, claimText],
    );
    await tx.unsafe(
      `insert into claim_revisions (id,project_id,claim_id,state,claim_text,finalized_at)
       select revision_id,$1::uuid,target_id,'active',
         'Literal %_ '||repeat('界',${PINNED_CONTEXT_CODEPOINTS - Array.from("Literal %_ ").length}),null
       from unnest($2::uuid[],$3::uuid[]) with ordinality as x(target_id,revision_id,n)`,
      [projectId, maxClaims, maxClaimRevisions],
    );
    await tx.unsafe(
      `insert into claim_revisions (id,project_id,claim_id,state,claim_text,finalized_at)
       select revision_id,$1::uuid,target_id,'active','Off-page Claim support row '||n::text,null
       from unnest($2::uuid[],$3::uuid[]) with ordinality as x(target_id,revision_id,n)`,
      [projectId, offPageClaims, offPageClaimRevisions],
    );
    await tx.unsafe(
      `insert into claim_revision_evidence_supports (project_id,claim_revision_id,evidence_id)
       select $1::uuid,revision_id,$3::uuid from unnest($2::uuid[]) as x(revision_id)`,
      [projectId, [...claimRevisions, ...maxClaimRevisions, ...offPageClaimRevisions], evidenceId],
    );

    await tx.unsafe(
      `insert into synthesis_statements (id,project_id)
       select id,$1::uuid from unnest($2::uuid[]) as x(id)`,
      [projectId, maxSynthesisStatements],
    );
    await tx.unsafe(
      `insert into synthesis_revisions (id,project_id,synthesis_statement_id,state,statement_text,finalized_at)
       select revision_id,$1::uuid,target_id,'active',
         'Literal %_ '||repeat('語',${PINNED_CONTEXT_CODEPOINTS - Array.from("Literal %_ ").length}),null
       from unnest($2::uuid[],$3::uuid[]) with ordinality as x(target_id,revision_id,n)`,
      [projectId, maxSynthesisStatements, maxSynthesisRevisions],
    );
    await tx.unsafe(
      `insert into synthesis_revision_supports (project_id,synthesis_revision_id,extraction_revision_id)
       select $1::uuid,revision_id,$3::uuid from unnest($2::uuid[]) as x(revision_id)`,
      [projectId, maxSynthesisRevisions, extractionRevisionId],
    );
    await tx.unsafe("update claim_revisions set finalized_at=created_at where project_id=$1::uuid and id=any($2::uuid[])", [projectId, [...claimRevisions, ...maxClaimRevisions, ...offPageClaimRevisions]]);
    await tx.unsafe("update synthesis_revisions set finalized_at=created_at where project_id=$1::uuid and id=any($2::uuid[])", [projectId, [...synthesisRevisions, ...maxSynthesisRevisions]]);
  });

  const eventSpecs = [
    { table: "research_question_extraction_field_events", column: "extraction_field_id", ids: fields },
    { table: "research_question_evidence_set_events", column: "evidence_set_id", ids: evidenceSets },
    { table: "research_question_synthesis_statement_events", column: "synthesis_statement_id", ids: synthesisStatements },
    { table: "research_question_claim_events", column: "claim_id", ids: claims },
  ] as const;
  const questionRows = await client.unsafe("select id::text as id from research_questions where project_id=$1 order by sort_order,id limit 1", [projectId]) as unknown as Array<{ id: string }>;
  const questionId = String(questionRows[0]?.id ?? "");
  assert(questionId, "Synthetic project has no first Research Question.");
  await client.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${SEED_TIMEOUT_MS}'`);
    for (const spec of eventSpecs) {
      const activeIds = spec.ids.slice(0, LINKED_PER_KIND);
      for (const action of ["linked", "unlinked"] as const) {
        await tx.unsafe(
          `insert into ${spec.table} (project_id,research_question_id,${spec.column},action)
           select $1::uuid,$2::uuid,target_id,$3::text from unnest($4::uuid[]) as x(target_id)`,
          [projectId, questionId, action, spec.ids],
        );
      }
      await tx.unsafe(
        `insert into ${spec.table} (project_id,research_question_id,${spec.column},action)
         select $1::uuid,$2::uuid,target_id,'linked' from unnest($3::uuid[]) as x(target_id)`,
        [projectId, questionId, activeIds],
      );
    }
    // Keep one target history genuinely deep while ending in the linked state.
    const noisyField = fields[0]!;
    for (let index = 0; index < 50; index += 1) {
      await tx.unsafe(
        `insert into research_question_extraction_field_events (project_id,research_question_id,extraction_field_id,action,note)
         values ($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text)`,
        [projectId, questionId, noisyField, index % 2 === 0 ? "unlinked" : "linked", `Benchmark history event ${index + 1}`],
      );
    }
    await tx.unsafe(
      `insert into research_question_claim_events (project_id,research_question_id,claim_id,action)
       select $1::uuid,$2::uuid,target_id,'linked' from unnest($3::uuid[]) as x(target_id)`,
      [projectId, questionId, maxClaims],
    );
    await tx.unsafe(
      `insert into research_question_synthesis_statement_events (project_id,research_question_id,synthesis_statement_id,action)
       select $1::uuid,$2::uuid,target_id,'linked' from unnest($3::uuid[]) as x(target_id)`,
      [projectId, questionId, maxSynthesisStatements],
    );
  });
  return {
    questionId,
    fields,
    evidenceSets,
    synthesisStatements,
    synthesisRevisions,
    claims,
    claimRevisions,
    maxClaims,
    maxClaimRevisions,
    maxSynthesisStatements,
    maxSynthesisRevisions,
    coverageFieldId: fields[0]!,
    offPageFieldId: fields[1]!,
  };
}

async function seedAnswerHistory(
  client: postgres.Sql,
  projectId: string,
  questionId: string,
  claimId: string,
  claimRevisionId: string,
  claimIds: string[],
  claimRevisionIds: string[],
  synthesisIds: string[],
  synthesisRevisionIds: string[],
) {
  const historyAnswerIds = makeIds(1_000);
  const historyRows = await client.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${SEED_TIMEOUT_MS}'`);
    const inserted = await tx.unsafe(
      `insert into research_question_answers (id,project_id,research_question_id,answer_text,finalized_at)
       select answer_id,$1::uuid,$2::uuid,'Synthetic Answer history row '||n::text,null
       from unnest($3::uuid[]) with ordinality as x(answer_id,n)
       returning id::text as id,sequence::text as sequence`,
      [projectId, questionId, historyAnswerIds],
    ) as unknown as Array<{ id: string; sequence: string }>;
    await tx.unsafe(
      `insert into research_question_answer_claim_contexts (project_id,research_question_id,answer_id,claim_id,claim_revision_id,sort_order)
       select $1::uuid,$2::uuid,answer_id,$3::uuid,$4::uuid,0 from unnest($5::uuid[]) as x(answer_id)`,
      [projectId, questionId, claimId, claimRevisionId, historyAnswerIds],
    );
    await tx.unsafe(
      "update research_question_answers set finalized_at=created_at where project_id=$1::uuid and id=any($2::uuid[])",
      [projectId, historyAnswerIds],
    );
    return inserted;
  });

  const answerId = randomUUID();
  await client.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${SEED_TIMEOUT_MS}'`);
    await tx.unsafe(
      `insert into research_question_answers (id,project_id,research_question_id,answer_text,researcher_note)
       values ($1::uuid,$2::uuid,$3::uuid,repeat('界',${LONG_ANSWER_CODEPOINTS}),repeat('語',${LONG_ANSWER_CODEPOINTS}))`,
      [answerId, projectId, questionId],
    );
    await tx.unsafe(
      `insert into research_question_answer_claim_contexts (project_id,research_question_id,answer_id,claim_id,claim_revision_id,sort_order)
       select $1::uuid,$2::uuid,$3::uuid,claim_id,revision_id,ordinality::int-1
       from unnest($4::uuid[],$5::uuid[]) with ordinality as x(claim_id,revision_id,ordinality)`,
      [projectId, questionId, answerId, claimIds, claimRevisionIds],
    );
    await tx.unsafe(
      `insert into research_question_answer_synthesis_contexts (project_id,research_question_id,answer_id,synthesis_statement_id,synthesis_revision_id,sort_order)
       select $1::uuid,$2::uuid,$3::uuid,statement_id,revision_id,ordinality::int-1
       from unnest($4::uuid[],$5::uuid[]) with ordinality as x(statement_id,revision_id,ordinality)`,
      [projectId, questionId, answerId, synthesisIds, synthesisRevisionIds],
    );
    await tx.unsafe("update research_question_answers set finalized_at=created_at where project_id=$1::uuid and id=$2::uuid", [projectId, answerId]);
  });
  return {
    historyRows,
    maxContextAnswerId: answerId,
    counts: {
      historyAnswers: historyRows.length,
      maxClaimContexts: claimIds.length,
      maxSynthesisContexts: synthesisIds.length,
      maxAnswerAndNoteCodepoints: LONG_ANSWER_CODEPOINTS,
      pinnedClaimAndSynthesisCodepoints: PINNED_CONTEXT_CODEPOINTS,
    },
  };
}

async function questionIdAt(client: postgres.Sql, projectId: string, sortOrder: number) {
  const rows = await client.unsafe(
    "select id::text as id from research_questions where project_id=$1::uuid and sort_order=$2::int limit 1",
    [projectId, sortOrder],
  ) as unknown as Array<{ id: string }>;
  assert(rows[0]?.id, `Missing synthetic Research Question at sort order ${sortOrder}.`);
  return rows[0]!.id;
}

async function targetHighWater(client: postgres.Sql, projectId: string, questionId: string, targetType: string) {
  const tableByType: Record<string, string> = {
    "extraction-field": "research_question_extraction_field_events",
    "evidence-set": "research_question_evidence_set_events",
    "synthesis-statement": "research_question_synthesis_statement_events",
    claim: "research_question_claim_events",
  };
  const table = tableByType[targetType];
  assert(table, `Unknown target type ${targetType}.`);
  const rows = await client.unsafe(
    `select coalesce(max(sequence),0)::text as high_water from ${table} where project_id=$1::uuid and research_question_id=$2::uuid`,
    [projectId, questionId],
  ) as unknown as Array<{ high_water: string }>;
  return String(rows[0]?.high_water ?? "0");
}

async function matrixCursorAt(client: postgres.Sql, projectId: string, index: number, pageSize = 100) {
  const rows = await client.unsafe(
    "select sort_order,id::text as id from research_questions where project_id=$1::uuid order by sort_order,id offset $2::int limit 1",
    [projectId, index],
  ) as unknown as Array<{ sort_order: number; id: string }>;
  assert(rows[0], `Missing matrix cursor fixture at offset ${index}.`);
  return encodeCursor({ v: 1, kind: "rq-matrix", projectId, pageSize, status: "all", sortOrder: Number(rows[0].sort_order), id: String(rows[0].id) });
}

async function coverageCursorAt(client: postgres.Sql, projectId: string, questionId: string, fieldId: string, epoch: string, highWaterSequence: string, index: number, pageSize = 100) {
  const rows = await client.unsafe(
    "select created_at::text as created_at,id::text as id from papers where project_id=$1::uuid order by created_at,id offset $2::int limit 1",
    [projectId, index],
  ) as unknown as Array<{ created_at: string; id: string }>;
  assert(rows[0], `Missing coverage cursor fixture at offset ${index}.`);
  return encodeCursor({ v: 1, kind: "rq-coverage", projectId, questionId, pageSize, epoch, highWaterSequence, fieldId, createdAt: String(rows[0].created_at), id: String(rows[0].id) });
}

async function answerHistoryCursorAt(client: postgres.Sql, projectId: string, questionId: string, highWaterSequence: string, index: number, pageSize = 25) {
  const rows = await client.unsafe(
    "select id::text as id,sequence::text as sequence from research_question_answers where project_id=$1::uuid and research_question_id=$2::uuid and finalized_at is not null order by sequence desc offset $3::int limit 1",
    [projectId, questionId, index],
  ) as unknown as Array<{ id: string; sequence: string }>;
  assert(rows[0], `Missing Answer history cursor fixture at offset ${index}.`);
  return encodeCursor({ v: 1, kind: "rq-answer-history", projectId, questionId, pageSize, highWaterSequence, sequence: String(rows[0].sequence), id: String(rows[0].id) });
}

async function targetHistoryCursorAt(client: postgres.Sql, projectId: string, questionId: string, targetId: string, epoch: string, highWaterSequence: string, index: number, pageSize = 25) {
  const rows = await client.unsafe(
    `select id::text as id,sequence::text as sequence from research_question_extraction_field_events
     where project_id=$1::uuid and research_question_id=$2::uuid and extraction_field_id=$3::uuid
     order by sequence desc,id desc offset $4::int limit 1`,
    [projectId, questionId, targetId, index],
  ) as unknown as Array<{ id: string; sequence: string }>;
  assert(rows[0], `Missing target history cursor fixture at offset ${index}.`);
  return encodeCursor({ v: 1, kind: "rq-target-history", projectId, questionId, pageSize, targetType: "extraction-field", targetId, epoch, highWaterSequence, sequence: String(rows[0].sequence), id: String(rows[0].id) });
}

function sortIds(values: string[]) {
  return [...values].sort();
}

function getPayloadCeiling(name: string): number | null {
  if (name.startsWith("matrix-page-")) return 256 * 1024;
  if (name.startsWith("link-ledger-")) return 128 * 1024;
  if (name.startsWith("target-picker-")) return 128 * 1024;
  if (name.startsWith("answer-candidates-")) return 128 * 1024;
  if (name.startsWith("extraction-coverage-")) return 256 * 1024;
  if (name.startsWith("answer-history-")) return 128 * 1024;
  if (name.startsWith("exact-extraction-field-detail-history-")) return 1024 * 1024;
  if (name.startsWith("workspace-summary-and-four-default-links-")) return 512 * 1024;
  return null;
}

async function recordCase(
  client: postgres.Sql,
  sink: QuerySink,
  name: string,
  run: () => Promise<unknown>,
  plans: Array<Record<string, unknown>>,
  shouldExplain = true,
) {
  const measurement = await measure(sink, run);
  return recordMeasurement(client, name, measurement, plans, shouldExplain);
}

async function createDisposableDatabaseUrl(adminUrl: string) {
  const base = new URL(adminUrl);
  base.hostname = "127.0.0.1";
  const databaseName = `slice48_bench_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, prepare: false });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const target = new URL(base.toString());
  target.pathname = `/${databaseName}`;
  return { admin, databaseName, databaseUrl: target.toString() };
}

async function main() {
  const startedAt = new Date().toISOString();
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: "Slice 48 bounded Research Question reads",
    startedAt,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    measurementDefinitions: {
      rawDriverRows: "Rows returned by postgres.js for each captured SELECT, including pageSize+1 sentinels.",
      rawDriverJsonBytes: "UTF-8 bytes from JSON serialization of raw postgres.js result rows; not PostgreSQL wire-protocol bytes.",
      apiPayloadBytes: "UTF-8 bytes from JSON serialization of the returned service DTO; not HTTP wire-protocol bytes.",
      projectedCardinality: "Item counts derived from DTO shapes as projected/renderable items; not measured DOM nodes.",
      scanNodeRowWorkDiagnostic: "Diagnostic sum of scan-node actual rows and rows removed by filters multiplied by loops; nested scans can recount tuples, and this is not unique tuples or physical reads.",
    },
    fixture: {
      questionPopulations: [...POPULATION_SIZES],
      finallyIncludedPaperPopulations: [...POPULATION_SIZES],
      targetInventoryPerType: TARGETS_PER_KIND,
      currentlyLinkedPerTypeBeforeAnswerContextTargets: LINKED_PER_KIND,
      extractionValuesPerIncludedPaper: 1,
      answerHistoryDepth: 1_000,
      maximumAnswerContextsPerType: 100,
      offPageSupportedClaims: OFF_PAGE_CLAIM_SUPPORTS,
      sourceTextCodepoints: {
        questionIdentifier: 100,
        questionIdentifierUtf16CodeUnits: 100,
        questionLabelAtSortOrderZero: LONG_QUESTION_LABEL_CODEPOINTS + 1,
        paperTitleAtCreatedOrderZero: Array.from("Long-title fixture ").length + LONG_PAPER_TITLE_CODEPOINTS,
        paperAbstract: 1_200,
        longestExtractionFieldName: Array.from("Literal %_ benchmark extraction field ").length + 260 + 4,
        literalEvidenceSetName: Array.from("Literal %_ benchmark evidence set ").length + 4,
        answerText: LONG_ANSWER_CODEPOINTS,
        researcherNote: LONG_ANSWER_CODEPOINTS,
        eachPinnedClaimContext: PINNED_CONTEXT_CODEPOINTS,
        eachPinnedSynthesisContext: PINNED_CONTEXT_CODEPOINTS,
      },
      matrixWorkScope: {
        questionPage: "Keyset page reads at most pageSize+1 Questions.",
        projectAndQuestionCounts: "Active/archived Question and protocol counts aggregate the relevant Project scope once; work can scale with that scope.",
        includedPaperCoverage: "Extraction diagnostics use the relevant Project's finally included Paper and finalized-value scope once; work can scale with that scope.",
        dimensionAggregates: "Four traceability dimension aggregates are joined to the visible Question page IDs.",
        answerAggregate: "Answer/context facts are restricted to visible Question page IDs.",
        wholeQueryConstantWorkClaim: false,
      },
      multibyteSearchTerm: "%_",
      note: "The matrix avoids per-Paper×Field application objects and restricts question-dimension/Answer facts to the selected page. Project and included-Paper aggregates may still scan their relevant scope once; no constant-work guarantee is made for the whole query.",
    },
    database: { disposable: true, cleanupCompleted: false },
    measurements: [] as Array<Record<string, unknown>>,
    explainPlans: [] as Array<Record<string, unknown>>,
  };
  let admin: postgres.Sql | null = null;
  let client: postgres.Sql | null = null;
  let databaseName: string | null = null;
  let projectId: string | null = null;
  let cleanupCompleted = false;
  let bounded: ReturnType<typeof createResearchQuestionBoundedReadServices> | null = null;
  const sink = createQuerySink();
  try {
    const created = await createDisposableDatabaseUrl(resolveDatabaseUrl());
    admin = created.admin;
    databaseName = created.databaseName;
    client = postgres(created.databaseUrl, { max: 1, prepare: false });
    const migrationDb = drizzle(client);
    await migrate(migrationDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });
    const projectOrderIndexCatalog = await readProjectOrderIndexCatalog(client);
    report.projectOrderIndexCatalog = { index: PROJECT_ORDER_INDEX, expectedColumns: ["project_id", "sort_order", "id"], actual: projectOrderIndexCatalog };
    assert(projectOrderIndexCatalog?.valid && projectOrderIndexCatalog.ready && JSON.stringify(projectOrderIndexCatalog.columns) === JSON.stringify(["project_id", "sort_order", "id"]), "The disposable database does not have the approved valid/ready Question order index in the expected column order.");
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}'`);
    const [version] = await client.unsafe("show server_version") as unknown as Array<{ server_version: string }>;
    const [versionNumber] = await client.unsafe("show server_version_num") as unknown as Array<{ server_version_num: string }>;
    report.postgres = { serverVersion: version?.server_version ?? null, serverVersionNumber: versionNumber?.server_version_num ?? null };

    const db = captureDatabaseQueries(client, sink);
    bounded = createResearchQuestionBoundedReadServices(db);
    const legacy = createReviewServices(db);
    const instrumentationOutsideTx = await measure(sink, () => db.execute(sql`select 'outside-transaction' as probe`));
    const instrumentationInsideTx = await measure(sink, () => db.transaction(async (tx) => tx.execute(sql`select 'inside-transaction' as probe`)));
    const instrumentation = {
      outsideTransaction: { rawDriverRows: instrumentationOutsideTx.rawDriverRows, rawDriverJsonBytes: instrumentationOutsideTx.rawDriverJsonBytes, apiPayloadBytes: instrumentationOutsideTx.apiPayloadBytes, selectCount: instrumentationOutsideTx.selectCount, captureComplete: instrumentationOutsideTx.driverRowCaptureComplete },
      insideTransaction: { rawDriverRows: instrumentationInsideTx.rawDriverRows, rawDriverJsonBytes: instrumentationInsideTx.rawDriverJsonBytes, apiPayloadBytes: instrumentationInsideTx.apiPayloadBytes, selectCount: instrumentationInsideTx.selectCount, captureComplete: instrumentationInsideTx.driverRowCaptureComplete },
    };
    assert(instrumentationOutsideTx.driverRowCaptureComplete && instrumentationOutsideTx.rawDriverRows === 1, "Raw driver capture did not record the outside-transaction SELECT.");
    assert(instrumentationInsideTx.driverRowCaptureComplete && instrumentationInsideTx.rawDriverRows === 1, "Raw driver capture did not record the transactional SELECT.");
    report.driverCaptureSelfTest = instrumentation;

    projectId = randomUUID();
    await client.unsafe("insert into projects (id,title) values ($1::uuid,$2::text)", [projectId, "Slice 48 disposable benchmark project"]);
    const instrumentationValues = await measure(sink, () => db.select({ id: schema.projects.id }).from(schema.projects).where(sql`${schema.projects.id}=${projectId}::uuid`).limit(1));
    const instrumentationNestedSavepoint = await measure(sink, () => db.transaction(async (tx) => tx.transaction(async (nested) =>
      nested.select({ id: schema.projects.id }).from(schema.projects).where(sql`${schema.projects.id}=${projectId}::uuid`).limit(1))));
    assert(instrumentationValues.driverRowCaptureComplete && instrumentationValues.rawDriverRows === 1, "Raw driver capture did not record the select-builder .values() result.");
    assert(instrumentationNestedSavepoint.driverRowCaptureComplete && instrumentationNestedSavepoint.rawDriverRows === 1, "Raw driver capture did not record the nested savepoint select-builder result.");
    report.driverCaptureSelfTest = {
      ...(report.driverCaptureSelfTest as Record<string, unknown>),
      selectBuilderValuesOutsideTransaction: { rawDriverRows: instrumentationValues.rawDriverRows, rawDriverJsonBytes: instrumentationValues.rawDriverJsonBytes, apiPayloadBytes: instrumentationValues.apiPayloadBytes, selectCount: instrumentationValues.selectCount, captureComplete: instrumentationValues.driverRowCaptureComplete },
      selectBuilderValuesInsideSavepoint: { rawDriverRows: instrumentationNestedSavepoint.rawDriverRows, rawDriverJsonBytes: instrumentationNestedSavepoint.rawDriverJsonBytes, apiPayloadBytes: instrumentationNestedSavepoint.apiPayloadBytes, selectCount: instrumentationNestedSavepoint.selectCount, captureComplete: instrumentationNestedSavepoint.driverRowCaptureComplete },
    };
    await seedQuestionRange(client, projectId, 1, POPULATION_SIZES[0]);
    await client.unsafe("analyze research_questions");
    const fieldIds = makeIds(TARGETS_PER_KIND);
    await client.unsafe(
      `insert into extraction_fields (id,project_id,name,field_type,sort_order)
       select id,$1::uuid,case when n=1 then repeat('欄',260) when n>1000 then 'Literal %_ benchmark extraction field '||repeat('欄',260)||lpad(n::text,4,'0') else 'Benchmark extraction field '||lpad(n::text,4,'0') end,'short_text',n::int
       from unnest($2::uuid[]) with ordinality as x(id,n)`,
      [projectId, fieldIds],
    );
    await seedPaperRange(client, projectId, 1, POPULATION_SIZES[0]);
    await client.unsafe("analyze papers");
    await client.unsafe("analyze screening_decisions");
    await client.unsafe("analyze full_text_screening_decisions");
    const firstPaperRows = await client.unsafe("select id::text as id from papers where project_id=$1::uuid order by created_at,id", [projectId]) as unknown as Array<{ id: string }>;
    let paperIds = firstPaperRows.map((row) => String(row.id));
    const extractionRevisionId = await seedExtractionValues(client, projectId, paperIds, [fieldIds[0]!]);
    await client.unsafe("analyze extraction_values");
    await client.unsafe("analyze extraction_value_revisions");
    const [evidence] = await client.unsafe(
      `insert into evidence (project_id,paper_id,source_text,page_number)
       select $1::uuid,id,repeat('證',800),1 from papers where project_id=$1::uuid order by created_at,id limit 1 returning id::text as id`,
      [projectId],
    ) as unknown as Array<{ id: string }>;
    assert(evidence?.id, "Benchmark evidence support fixture was not created.");
    const dimensions = await seedTargetDimensions(client, projectId, evidence.id, extractionRevisionId, fieldIds);
    const questionId = await questionIdAt(client, projectId, 0);
    const answerData = await seedAnswerHistory(
      client,
      projectId,
      questionId,
      dimensions.maxClaims[0]!,
      dimensions.maxClaimRevisions[0]!,
      dimensions.maxClaims,
      dimensions.maxClaimRevisions,
      dimensions.maxSynthesisStatements,
      dimensions.maxSynthesisRevisions,
    );
    report.fixture = {
      ...(report.fixture as Record<string, unknown>),
      projectQuestionId: questionId,
      maxAnswerContextAnswerId: answerData.maxContextAnswerId,
      answerContexts: answerData.counts,
      multibyteFixtures: {
        questionIdentifierSource: "96 BMP U+754C characters followed by four ASCII digits",
        questionIdentifierUtf16CodeUnits: 100,
        questionIdentifierCodepoints: 100,
        questionLabelCodepointsAtSortOrderZero: LONG_QUESTION_LABEL_CODEPOINTS + 1,
        questionLabelMatrixSqlLimit: 280,
        paperTitleCodepointsAtCreatedOrderZero: Array.from("Long-title fixture ").length + LONG_PAPER_TITLE_CODEPOINTS,
        paperTitleCoverageSqlLimit: 200,
        paperAbstractCodepoints: 1_200,
        extractionFieldNameSourceCodepointsForLiteralSearch: Array.from("Literal %_ benchmark extraction field ").length + 260 + 4,
        extractionFieldPickerSqlLimit: 240,
        evidenceSetNameSourceCodepointsForLiteralSearch: Array.from("Literal %_ benchmark evidence set ").length + 4,
        evidenceSetPickerSqlLimit: 240,
        literalSearchTerm: "%_",
        literalSearchTermCodepoints: 2,
        answerContextSourceCodepointsPerClaim: PINNED_CONTEXT_CODEPOINTS,
        answerContextSourceCodepointsPerSynthesis: PINNED_CONTEXT_CODEPOINTS,
        maxClaimContexts: 100,
        maxSynthesisContexts: 100,
        answerTextCodepoints: LONG_ANSWER_CODEPOINTS,
        researcherNoteCodepoints: LONG_ANSWER_CODEPOINTS,
      },
    };

    const legacyMeasurement = await measure(sink, () => legacy.getResearchQuestionMatrix(projectId!));
    (report.measurements as Array<Record<string, unknown>>).push(await recordMeasurement(client, "legacy-full-matrix-practical-1k-questions-1k-included-papers", legacyMeasurement, report.explainPlans as Array<Record<string, unknown>>, false));

    let previousQuestionCount = POPULATION_SIZES[0];
    for (const size of POPULATION_SIZES) {
      if (size > previousQuestionCount) {
        await seedQuestionRange(client, projectId, previousQuestionCount + 1, size);
        previousQuestionCount = size;
        await client.unsafe("analyze research_questions");
        const previousPaperCount = paperIds.length;
        const newPapers = await seedPaperRange(client, projectId, previousPaperCount + 1, size);
        const newPaperIds = newPapers.map((paper) => paper.id);
        paperIds = [...paperIds, ...newPaperIds];
        await seedExtractionValues(client, projectId, newPaperIds, [fieldIds[0]!]);
        await client.unsafe("analyze papers");
        await client.unsafe("analyze screening_decisions");
        await client.unsafe("analyze full_text_screening_decisions");
        await client.unsafe("analyze extraction_values");
        await client.unsafe("analyze extraction_value_revisions");
      }
      const matrixPageSizes = size === 50_000 ? [50, 100] : [100];
      for (const matrixPageSize of matrixPageSizes) {
        const firstPage = await recordCase(client, sink, `matrix-page-first-${size}-questions-${size}-included-papers-page-${matrixPageSize}`, () => bounded!.getResearchQuestionMatrixPage(projectId!, { pageSize: matrixPageSize, status: "all" }), report.explainPlans as Array<Record<string, unknown>>);
        const deepCursor = await matrixCursorAt(client, projectId, Math.floor(size * 0.9), matrixPageSize);
        const deepPage = await recordCase(client, sink, `matrix-page-deep-${size}-questions-${size}-included-papers-page-${matrixPageSize}`, () => bounded!.getResearchQuestionMatrixPage(projectId!, { pageSize: matrixPageSize, status: "all", cursor: deepCursor }), report.explainPlans as Array<Record<string, unknown>>);
        (report.measurements as Array<Record<string, unknown>>).push(firstPage, deepPage);
      }
    }

    const workspace = await recordCase(client, sink, "workspace-summary-and-four-default-links-50k-project", () => bounded!.getResearchQuestionWorkspace(projectId!, questionId), report.explainPlans as Array<Record<string, unknown>>);
    (report.measurements as Array<Record<string, unknown>>).push(workspace);
    const epochRows = await client.unsafe("select traceability_epoch::text as epoch from research_questions where project_id=$1::uuid and id=$2::uuid", [projectId, questionId]) as unknown as Array<{ epoch: string }>;
    const epoch = String(epochRows[0]?.epoch ?? "0");
    const fieldHighWater = await targetHighWater(client, projectId, questionId, "extraction-field");
    const fieldTargetId = dimensions.fields[0]!;
    const targetHistoryCursor = await targetHistoryCursorAt(client, projectId, questionId, fieldTargetId, epoch, fieldHighWater, 24);
    const targetFirst = await recordCase(client, sink, "exact-extraction-field-detail-history-first-max25", () => bounded!.getResearchQuestionTargetDetail(projectId!, questionId, "extraction-field", fieldTargetId, { pageSize: 25 }), report.explainPlans as Array<Record<string, unknown>>);
    const targetDeep = await recordCase(client, sink, "exact-extraction-field-detail-history-deep-max25", () => bounded!.getResearchQuestionTargetDetail(projectId!, questionId, "extraction-field", fieldTargetId, { pageSize: 25, cursor: targetHistoryCursor }), report.explainPlans as Array<Record<string, unknown>>);
    (report.measurements as Array<Record<string, unknown>>).push(targetFirst, targetDeep);

    const linkedIdsByType: Record<string, string[]> = {
      "extraction-field": dimensions.fields.slice(0, LINKED_PER_KIND),
      "evidence-set": dimensions.evidenceSets.slice(0, LINKED_PER_KIND),
      "synthesis-statement": dimensions.synthesisStatements.slice(0, LINKED_PER_KIND),
      claim: [...dimensions.claims.slice(0, LINKED_PER_KIND), ...dimensions.maxClaims],
    };
    const unlinkedIdsByType: Record<string, string[]> = {
      "extraction-field": dimensions.fields.slice(LINKED_PER_KIND),
      "evidence-set": dimensions.evidenceSets.slice(LINKED_PER_KIND),
      "synthesis-statement": dimensions.synthesisStatements.slice(LINKED_PER_KIND),
      claim: dimensions.claims.slice(LINKED_PER_KIND),
    };
    const pageSize = 50;
    for (const targetType of ["extraction-field", "evidence-set", "synthesis-statement", "claim"] as const) {
      const highWaterSequence = await targetHighWater(client, projectId, questionId, targetType);
      const sortedLinked = sortIds(linkedIdsByType[targetType]!);
      const linkedBoundary = sortedLinked[Math.floor(sortedLinked.length * 0.8) - 1]!;
      const linkCursor = encodeCursor({ v: 1, kind: "rq-link", projectId, questionId, pageSize, targetType, epoch, highWaterSequence, id: linkedBoundary });
      const linkFirst = await recordCase(client, sink, `link-ledger-${targetType}-first-max50`, () => bounded!.listResearchQuestionLinkPage(projectId!, questionId, targetType, { pageSize }), report.explainPlans as Array<Record<string, unknown>>);
      const linkDeep = await recordCase(client, sink, `link-ledger-${targetType}-deep-max50`, () => bounded!.listResearchQuestionLinkPage(projectId!, questionId, targetType, { pageSize, cursor: linkCursor }), report.explainPlans as Array<Record<string, unknown>>);
      (report.measurements as Array<Record<string, unknown>>).push(linkFirst, linkDeep);

      const sortedUnlinked = sortIds(unlinkedIdsByType[targetType]!);
      const pickerBoundary = sortedUnlinked[Math.floor(sortedUnlinked.length * 0.8) - 1]!;
      const pickerCursor = encodeCursor({ v: 1, kind: "rq-picker", projectId, questionId, pageSize, targetType, epoch, highWaterSequence, search: "", id: pickerBoundary });
      const pickerFirst = await recordCase(client, sink, `target-picker-${targetType}-first-max50`, () => bounded!.getResearchQuestionTargetPickerPage(projectId!, questionId, targetType, { pageSize }), report.explainPlans as Array<Record<string, unknown>>);
      const pickerDeep = await recordCase(client, sink, `target-picker-${targetType}-deep-max50`, () => bounded!.getResearchQuestionTargetPickerPage(projectId!, questionId, targetType, { pageSize, cursor: pickerCursor }), report.explainPlans as Array<Record<string, unknown>>);
      (report.measurements as Array<Record<string, unknown>>).push(pickerFirst, pickerDeep);

      const literalSearch = "%_";
      const literalIds = sortedUnlinked;
      const literalBoundary = literalIds[Math.floor(literalIds.length * 0.8) - 1]!;
      const literalCursor = encodeCursor({ v: 1, kind: "rq-picker", projectId, questionId, pageSize, targetType, epoch, highWaterSequence, search: literalSearch, id: literalBoundary });
      const literalFirst = await recordCase(client, sink, `target-picker-${targetType}-literal-percent-underscore-first-max50`, () => bounded!.getResearchQuestionTargetPickerPage(projectId!, questionId, targetType, { pageSize, search: literalSearch }), report.explainPlans as Array<Record<string, unknown>>);
      const literalDeep = await recordCase(client, sink, `target-picker-${targetType}-literal-percent-underscore-deep-max50`, () => bounded!.getResearchQuestionTargetPickerPage(projectId!, questionId, targetType, { pageSize, search: literalSearch, cursor: literalCursor }), report.explainPlans as Array<Record<string, unknown>>);
      (report.measurements as Array<Record<string, unknown>>).push(literalFirst, literalDeep);
    }

    const coverageHighWater = await targetHighWater(client, projectId, questionId, "extraction-field");
    const coverageCursor = await coverageCursorAt(client, projectId, questionId, dimensions.coverageFieldId, epoch, coverageHighWater, 45_000);
    const coverageFirst = await recordCase(client, sink, "extraction-coverage-first-max100-50k-included-papers", () => bounded!.getResearchQuestionExtractionCoveragePage(projectId!, questionId, dimensions.coverageFieldId, { pageSize: 100 }), report.explainPlans as Array<Record<string, unknown>>);
    const coverageDeep = await recordCase(client, sink, "extraction-coverage-deep-max100-50k-included-papers", () => bounded!.getResearchQuestionExtractionCoveragePage(projectId!, questionId, dimensions.coverageFieldId, { pageSize: 100, cursor: coverageCursor }), report.explainPlans as Array<Record<string, unknown>>);
    (report.measurements as Array<Record<string, unknown>>).push(coverageFirst, coverageDeep);

    for (const targetType of ["claim", "synthesis"] as const) {
      const highWaterSequence = await targetHighWater(client, projectId, questionId, targetType === "claim" ? "claim" : "synthesis-statement");
      const ids = sortIds(targetType === "claim" ? linkedIdsByType.claim! : [...dimensions.synthesisStatements.slice(0, LINKED_PER_KIND), ...dimensions.maxSynthesisStatements]);
      const boundary = ids[Math.floor(ids.length * 0.8) - 1]!;
      const cursor = encodeCursor({ v: 1, kind: "rq-answer-candidate", projectId, questionId, pageSize, targetType, epoch, highWaterSequence, search: "", id: boundary });
      const candidateFirst = await recordCase(client, sink, `answer-candidates-${targetType}-first-max50`, () => bounded!.listResearchQuestionAnswerCandidatePage(projectId!, questionId, targetType, { pageSize }), report.explainPlans as Array<Record<string, unknown>>);
      const candidateDeep = await recordCase(client, sink, `answer-candidates-${targetType}-deep-max50`, () => bounded!.listResearchQuestionAnswerCandidatePage(projectId!, questionId, targetType, { pageSize, cursor }), report.explainPlans as Array<Record<string, unknown>>);
      (report.measurements as Array<Record<string, unknown>>).push(candidateFirst, candidateDeep);

      const literalSearch = "%_";
      const literalIds = sortIds(targetType === "claim"
        ? [...dimensions.claims.slice(1, LINKED_PER_KIND), ...dimensions.maxClaims]
        : [...dimensions.synthesisStatements.slice(1, LINKED_PER_KIND), ...dimensions.maxSynthesisStatements]);
      const literalBoundary = literalIds[Math.floor(literalIds.length * 0.8) - 1]!;
      const literalCursor = encodeCursor({ v: 1, kind: "rq-answer-candidate", projectId, questionId, pageSize, targetType, epoch, highWaterSequence, search: literalSearch, id: literalBoundary });
      const literalFirst = await recordCase(client, sink, `answer-candidates-${targetType}-literal-percent-underscore-first-max50`, () => bounded!.listResearchQuestionAnswerCandidatePage(projectId!, questionId, targetType, { pageSize, search: literalSearch }), report.explainPlans as Array<Record<string, unknown>>);
      const literalDeep = await recordCase(client, sink, `answer-candidates-${targetType}-literal-percent-underscore-deep-max50`, () => bounded!.listResearchQuestionAnswerCandidatePage(projectId!, questionId, targetType, { pageSize, search: literalSearch, cursor: literalCursor }), report.explainPlans as Array<Record<string, unknown>>);
      (report.measurements as Array<Record<string, unknown>>).push(literalFirst, literalDeep);
    }

    const answerRows = await client.unsafe(
      "select coalesce(max(sequence),0)::text as high_water from research_question_answers where project_id=$1::uuid and research_question_id=$2::uuid and finalized_at is not null",
      [projectId, questionId],
    ) as unknown as Array<{ high_water: string }>;
    const answerHighWater = String(answerRows[0]?.high_water ?? "0");
    const answerHistoryDefault = await recordCase(client, sink, "answer-history-default-page-size-10", () => bounded!.listResearchQuestionAnswerHistoryPage(projectId!, questionId), report.explainPlans as Array<Record<string, unknown>>);
    const answerHistoryFirst = await recordCase(client, sink, "answer-history-first-max25", () => bounded!.listResearchQuestionAnswerHistoryPage(projectId!, questionId, { pageSize: 25 }), report.explainPlans as Array<Record<string, unknown>>);
    const answerCursor = await answerHistoryCursorAt(client, projectId, questionId, answerHighWater, 800);
    const answerHistoryDeep = await recordCase(client, sink, "answer-history-deep-max25", () => bounded!.listResearchQuestionAnswerHistoryPage(projectId!, questionId, { pageSize: 25, cursor: answerCursor }), report.explainPlans as Array<Record<string, unknown>>);
    const answerSnapshot = await recordCase(client, sink, "exact-answer-browser-snapshot-100-claim-100-synthesis-contexts", () => bounded!.getResearchQuestionAnswerBrowserSnapshot(projectId!, questionId, answerData.maxContextAnswerId), report.explainPlans as Array<Record<string, unknown>>);
    (report.measurements as Array<Record<string, unknown>>).push(answerHistoryDefault, answerHistoryFirst, answerHistoryDeep, answerSnapshot);

    const [counts] = await client.unsafe(
      `select
         (select count(*)::int from research_questions where project_id=$1::uuid and archived_at is null) as active_questions,
         (select count(*)::int from papers p join(select distinct on(project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=$1::uuid and stage='title_abstract' order by project_id,paper_id,sequence desc) ta on ta.project_id=p.project_id and ta.paper_id=p.id and ta.decision='include' join(select distinct on(project_id,paper_id) project_id,paper_id,decision from full_text_screening_decisions where project_id=$1::uuid order by project_id,paper_id,sequence desc) ft on ft.project_id=p.project_id and ft.paper_id=p.id and ft.decision='include' where p.project_id=$1::uuid) as finally_included_papers`,
      [projectId],
    ) as unknown as Array<{ active_questions: number; finally_included_papers: number }>;
    report.finalCounts = { activeQuestions: Number(counts?.active_questions), finallyIncludedPapers: Number(counts?.finally_included_papers) };
  } catch (error) {
    report.error = safeError(error);
  } finally {
    if (client) await client.end().catch((error: unknown) => { report.closeError = safeError(error); });
    if (admin && databaseName) {
      try {
        await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
        cleanupCompleted = true;
      } catch (error) {
        report.cleanupError = safeError(error);
      }
      await admin.end().catch((error: unknown) => { report.adminCloseError = safeError(error); });
    }
  }
  report.database = { disposable: true, cleanupCompleted };
  report.completedAt = new Date().toISOString();
  const measurements = report.measurements as Array<Record<string, unknown>>;
  const plans = report.explainPlans as Array<Record<string, unknown>>;
  const failed = measurements.filter((measurement) => measurement.status !== "completed").map((measurement) => ({
    name: measurement.name,
    status: measurement.status,
    error: measurement.error,
    legacyBaseline: measurement.name === LEGACY_BASELINE_CASE,
  }));
  const failedBoundedCases = failed.filter((measurement) => measurement.name !== LEGACY_BASELINE_CASE);
  const captureRequired = measurements.filter((measurement) => measurement.name !== LEGACY_BASELINE_CASE || measurement.status === "completed");
  const incompleteQueryCaptures = captureRequired.flatMap((measurement) => {
    const capturedSelects = Array.isArray(measurement.capturedSelects) ? measurement.capturedSelects as Array<Record<string, unknown>> : [];
    const missing = capturedSelects.flatMap((query, queryIndex) => {
      const select = /^\s*(select|with)\b/i.test(String(query.sql ?? ""));
      return select && (typeof query.driverRows !== "number" || typeof query.driverJsonBytes !== "number")
        ? [{ name: measurement.name, queryIndex, sql: query.sql, params: query.params }]
        : [];
    });
    return Number(measurement.selectCount ?? 0) > 0 && (measurement.driverRowCaptureComplete !== true || capturedSelects.length === 0)
      ? [...missing, { name: measurement.name, queryIndex: null, sql: null, params: null }]
      : missing;
  });
  const completedBounded = measurements.filter((measurement) => measurement.name !== LEGACY_BASELINE_CASE && measurement.status === "completed");
  const selectPlanProblems = completedBounded.flatMap((measurement) => {
    const capturedSelects = Array.isArray(measurement.capturedSelects) ? measurement.capturedSelects as Array<Record<string, unknown>> : [];
    const selectCount = capturedSelects.filter((query) => /^\s*(select|with)\b/i.test(String(query.sql ?? ""))).length;
    const measurementPlans = plans.filter((plan) => plan.endpoint === measurement.name);
    return measurementPlans.length === selectCount && measurementPlans.every((plan) => plan.status === "completed")
      ? []
      : [{ name: measurement.name, expectedSelectPlans: selectCount, actualPlanCount: measurementPlans.length, statuses: measurementPlans.map((plan) => plan.status) }];
  });
  const matrixMeasurements = measurements.filter((measurement) => String(measurement.name).startsWith("matrix-page-"));
  const matrixSelectCounts = matrixMeasurements.map((measurement) => ({ name: measurement.name, selectCount: measurement.selectCount }));
  const matrixPagesUseSixSelects = matrixMeasurements.length > 0 && matrixMeasurements.every((measurement) => measurement.selectCount === 6);
  const matrixSentinelNames = [
    "matrix-page-first-50000-questions-50000-included-papers-page-50",
    "matrix-page-deep-50000-questions-50000-included-papers-page-50",
    "matrix-page-first-50000-questions-50000-included-papers-page-100",
    "matrix-page-deep-50000-questions-50000-included-papers-page-100",
  ];
  const matrixSentinelEvidence = matrixSentinelNames.map((name) => {
    const measurement = measurements.find((item) => item.name === name);
    const pageSize = name.endsWith("page-50") ? 50 : 100;
    const capturedSelects = Array.isArray(measurement?.capturedSelects) ? measurement.capturedSelects as Array<Record<string, unknown>> : [];
    const pageQueryIndex = capturedSelects.findIndex((query) => /with\s+project_scope\s+as\s+materialized/i.test(String(query.sql ?? "")));
    const pageQuery = pageQueryIndex >= 0 ? capturedSelects[pageQueryIndex] : undefined;
    return {
      name,
      pageSize,
      selectCount: measurement?.selectCount ?? null,
      projectedItemCount: measurement?.projectedItemCount ?? null,
      returnedPageHasMore: measurement?.returnedPageHasMore ?? null,
      pageQueryIndex: pageQueryIndex < 0 ? null : pageQueryIndex,
      rawPageQueryRows: pageQuery?.driverRows ?? null,
      rawPageQueryJsonBytes: pageQuery?.driverJsonBytes ?? null,
      valid: measurement?.status === "completed" && measurement.driverRowCaptureComplete === true && measurement.selectCount === 6
        && measurement.projectedItemCount === pageSize && measurement.returnedPageHasMore === true
        && pageQuery?.driverRows === pageSize + 1 && typeof pageQuery.driverJsonBytes === "number",
    };
  });
  const indexPlanEvidence = matrixSentinelNames.map((name) => {
    const pagePlan = plans.find((plan) => plan.endpoint === name && /with\s+project_scope\s+as\s+materialized/i.test(String(plan.sql ?? "")));
    const summary = pagePlan?.summary as Record<string, unknown> | undefined;
    const nodes = Array.isArray(summary?.nodes) ? summary.nodes as Array<Record<string, unknown>> : [];
    return { name, planStatus: pagePlan?.status ?? "missing", usesApprovedIndex: nodes.some((node) => node.index === PROJECT_ORDER_INDEX) };
  });
  const literalSearchMeasurements = measurements.filter((measurement) => String(measurement.name).includes("literal-percent-underscore"));
  const literalSearchCases = literalSearchMeasurements.map((measurement) => {
    const capturedSelects = Array.isArray(measurement.capturedSelects) ? measurement.capturedSelects as Array<Record<string, unknown>> : [];
    return {
      name: measurement.name,
      selectCount: measurement.selectCount,
      projectedItemCount: measurement.projectedItemCount,
      returnedPageHasMore: measurement.returnedPageHasMore,
      hasRawPagePlusOne: capturedSelects.some((query) => query.driverRows === 51 && typeof query.driverJsonBytes === "number"),
      valid: measurement.status === "completed" && measurement.driverRowCaptureComplete === true && Number(measurement.selectCount) <= 2
        && measurement.projectedItemCount === 50 && measurement.returnedPageHasMore === true
        && capturedSelects.some((query) => query.driverRows === 51 && typeof query.driverJsonBytes === "number"),
    };
  });
  const answerSnapshotMeasurement = measurements.find((measurement) => measurement.name === "exact-answer-browser-snapshot-100-claim-100-synthesis-contexts");
  const maxContextPayloadEvidence = {
    name: answerSnapshotMeasurement?.name ?? null,
    projectedItemCount: answerSnapshotMeasurement?.projectedItemCount ?? null,
    projectedCardinality: answerSnapshotMeasurement?.projectedCardinality ?? null,
    apiPayloadBytes: answerSnapshotMeasurement?.apiPayloadBytes ?? null,
    rawDriverRows: answerSnapshotMeasurement?.rawDriverRows ?? null,
    rawDriverJsonBytes: answerSnapshotMeasurement?.rawDriverJsonBytes ?? null,
    valid: answerSnapshotMeasurement?.status === "completed" && answerSnapshotMeasurement.driverRowCaptureComplete === true
      && answerSnapshotMeasurement.projectedItemCount === 200
      && (answerSnapshotMeasurement.projectedCardinality as Record<string, unknown> | undefined)?.exactClaimContexts === 100
      && (answerSnapshotMeasurement.projectedCardinality as Record<string, unknown> | undefined)?.exactSynthesisContexts === 100
      && Number(answerSnapshotMeasurement.apiPayloadBytes) >= 5_800_000,
  };
  const finalCounts = report.finalCounts as Record<string, unknown> | undefined;
  const finalPopulationMatches = finalCounts?.activeQuestions === 50_000 && finalCounts?.finallyIncludedPapers === 50_000;
  const indexCatalog = report.projectOrderIndexCatalog as { actual?: { valid?: boolean; ready?: boolean; columns?: string[] } } | undefined;
  const indexCatalogValid = indexCatalog?.actual?.valid === true && indexCatalog.actual.ready === true
    && JSON.stringify(indexCatalog.actual.columns) === JSON.stringify(["project_id", "sort_order", "id"]);
  report.validation = {
    allBoundedCasesCompleted: failedBoundedCases.length === 0,
    legacyBaseline: failed.find((measurement) => measurement.name === LEGACY_BASELINE_CASE) ?? { name: LEGACY_BASELINE_CASE, status: "completed" },
    allSelectRowsAndJsonBytesCaptured: incompleteQueryCaptures.length === 0,
    incompleteQueryCaptures,
    allBoundedSelectPlansCompleted: selectPlanProblems.length === 0,
    selectPlanProblems,
    matrixSelectCounts,
    matrixPagesUseSixSelects,
    matrixSentinelEvidence,
    allMatrixPageSentinelsCaptured: matrixSentinelEvidence.every((evidence) => evidence.valid),
    indexCatalogValid,
    baselineOrderIndexMatrixPagePlans: indexPlanEvidence,
    allBaselineOrderIndexMatrixPagePlansUseExistingIndex: indexPlanEvidence.every((evidence) => evidence.planStatus === "completed" && evidence.usesApprovedIndex),
    literalSearchCases,
    allLiteralSearchCasesReturnPagePlusOne: literalSearchCases.length === 12 && literalSearchCases.every((evidence) => evidence.valid),
    maxContextPayloadEvidence,
    maxContextPayloadValidated: maxContextPayloadEvidence.valid,
    payloadCeilingEvidence: completedBounded.map((measurement) => {
      const ceiling = getPayloadCeiling(String(measurement.name));
      const bytes = typeof measurement.apiPayloadBytes === "number" ? measurement.apiPayloadBytes : null;
      return {
        name: measurement.name,
        ceilingBytes: ceiling,
        apiPayloadBytes: bytes,
        withinCeiling: ceiling === null || (bytes !== null && bytes <= ceiling),
      };
    }),
    allPayloadCeilingsMet: completedBounded.every((measurement) => {
      const ceiling = getPayloadCeiling(String(measurement.name));
      const bytes = typeof measurement.apiPayloadBytes === "number" ? measurement.apiPayloadBytes : null;
      return ceiling === null || (bytes !== null && bytes <= ceiling);
    }),
    finalCounts,
    finalPopulationMatches,
    failedCases: failed,
    failedBoundedCases,
  };
  const validation = report.validation as Record<string, unknown>;
  const gatesPassed = validation.allBoundedCasesCompleted === true
    && validation.allSelectRowsAndJsonBytesCaptured === true
    && validation.allBoundedSelectPlansCompleted === true
    && validation.matrixPagesUseSixSelects === true
    && validation.allMatrixPageSentinelsCaptured === true
    && validation.indexCatalogValid === true
    && validation.allPostIndexMatrixPagePlansUseApprovedIndex === true
    && validation.allLiteralSearchCasesReturnPagePlusOne === true
    && validation.maxContextPayloadValidated === true
    && validation.allPayloadCeilingsMet === true
    && validation.finalPopulationMatches === true;
  mkdirSync(resolve(BENCHMARK_OUTPUT, ".."), { recursive: true });
  writeFileSync(BENCHMARK_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: BENCHMARK_OUTPUT, measurementCount: measurements.length, planCount: (report.explainPlans as unknown[]).length, cleanupCompleted, validation: report.validation, error: report.error ?? null })}\n`);
  if (report.error || !cleanupCompleted || !gatesPassed) process.exitCode = 1;
}

void main();
