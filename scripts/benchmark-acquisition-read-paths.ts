import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createAcquisitionReadServices } from "@/application/acquisition-read-services";

const SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const INDEX_NAME = "retrieved_records_project_run_order_idx";

function quoteIdentifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }

function captureQuery(query: SQL) {
  const rendered = new PgDialect().sqlToQuery(query);
  return { sql: rendered.sql, params: rendered.params as unknown[] };
}

type CapturedQuery = ReturnType<typeof captureQuery> & { driverRows: number };
type ReaderCounters = { selectCount: number; driverRows: number; statements: CapturedQuery[] };

function safeParameterShape(params: unknown[]) {
  return params.map((value) => {
    if (value == null) return value;
    if (typeof value === "number") return Number.isInteger(value) ? "<integer>" : "<number>";
    if (typeof value === "boolean") return value;
    if (value instanceof Date) return "<timestamptz>";
    if (typeof value === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return "<uuid>";
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return "<timestamptz>";
      return `<string:${Array.from(value).length} code points>`;
    }
    if (Array.isArray(value)) return `<array:${value.length}>`;
    return `<${typeof value}>`;
  });
}

function sanitizePlan(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)\b/g, "<timestamp>")
      .replace(/'(?:[^']|'')*'/g, "'<literal>'")
      .replace(/(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w.])/g, "<number>");
  }
  if (Array.isArray(value)) return value.map(sanitizePlan);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizePlan(entry)]));
  return value;
}

function planSummary(value: unknown) {
  const raw = Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : undefined;
  const root = raw?.Plan as Record<string, unknown> | undefined;
  const nodes: Array<Record<string, unknown>> = [];
  const walk = (node: Record<string, unknown>) => {
    nodes.push({
      nodeType: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"],
      planRows: node["Plan Rows"], actualRows: node["Actual Rows"], actualLoops: node["Actual Loops"], rowsRemovedByFilter: node["Rows Removed by Filter"],
      sharedHitBlocks: node["Shared Hit Blocks"], sharedReadBlocks: node["Shared Read Blocks"],
      tempReadBlocks: node["Temp Read Blocks"], tempWrittenBlocks: node["Temp Written Blocks"],
      sortMethod: (node["Sort Key"] as unknown[] | undefined)?.join(", "),
    });
    if (Array.isArray(node.Plans)) for (const child of node.Plans) walk(child as Record<string, unknown>);
  };
  if (root) walk(root);
  return { planningTimeMs: raw?.["Planning Time"], executionTimeMs: raw?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, label: string, query: SQL | CapturedQuery) {
  const captured = "sql" in query ? query : captureQuery(query);
  const started = process.hrtime.bigint();
  const rows = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`, captured.params as never) as unknown as Array<Record<string, unknown>>;
  const rawPlan = rows[0]?.["QUERY PLAN"];
  return {
    label,
    sql: captured.sql,
    params: safeParameterShape(captured.params),
    sqlBytes: Buffer.byteLength(captured.sql),
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    planJson: sanitizePlan(rawPlan),
    planSummary: planSummary(rawPlan),
  };
}

function monitorDatabase(database: Database, counters: ReaderCounters): Database {
  const recordReadResult = (query: SQL | null, result: unknown) => {
    const driverRows = Array.isArray(result)
      ? result.length
      : result && typeof result === "object" && Array.isArray(Reflect.get(result, "rows"))
        ? (Reflect.get(result, "rows") as unknown[]).length
        : 0;
    counters.selectCount += 1;
    counters.driverRows += driverRows;
    if (query) counters.statements.push({ ...captureQuery(query), driverRows });
  };
  const observedExecute = async (query: SQL, execute: (query: SQL) => Promise<unknown>) => {
    const result = await execute(query);
    if (/^\s*(?:select|with)\b/i.test(captureQuery(query).sql)) recordReadResult(query, result);
    return result;
  };
  const wrapQueryBuilder = (builder: unknown): unknown => {
    if (!builder || typeof builder !== "object") return builder;
    return new Proxy(builder, {
      get(target, key) {
        if (key === "then" || key === "execute") {
          const method = Reflect.get(target, key, target);
          if (typeof method !== "function") return method;
          const getSql = Reflect.get(target, "getSQL", target);
          const query = typeof getSql === "function" ? getSql.call(target) as SQL : null;
          if (key === "then") return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
            const execute = Reflect.get(target, "execute", target);
            const result = Promise.resolve(Reflect.apply(execute, target, [])).then((value) => { recordReadResult(query, value); return value; });
            return result.then(onFulfilled, onRejected);
          };
          return (...args: unknown[]) => Promise.resolve(Reflect.apply(method, target, args)).then((value) => { recordReadResult(query, value); return value; });
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]) => wrapQueryBuilder(Reflect.apply(value, target, args))
          : value;
      },
    });
  };
  const wrapTarget = (target: object): object => new Proxy(target, {
    get(object, key) {
      if (key === "execute") return (query: SQL) => observedExecute(query, (captured) => Promise.resolve((object as { execute: (query: SQL) => unknown }).execute(captured)));
      if (key === "select" || key === "selectDistinct" || key === "selectDistinctOn") {
        const select = Reflect.get(object, key, object);
        if (typeof select === "function") return (...args: unknown[]) => wrapQueryBuilder(Reflect.apply(select, object, args));
      }
      if (key === "transaction") {
        const transaction = Reflect.get(object, key, object);
        if (typeof transaction === "function") return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => Reflect.apply(transaction, object, [
          (tx: object) => callback(wrapTarget(tx)), options,
        ]);
      }
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return wrapTarget(database as unknown as object) as Database;
}

function resetCounters(counters: ReaderCounters) {
  counters.selectCount = 0;
  counters.driverRows = 0;
  counters.statements.length = 0;
}

function createCounters(): ReaderCounters {
  return { selectCount: 0, driverRows: 0, statements: [] };
}

function requireCapturedQuery(counters: ReaderCounters, predicate: (query: CapturedQuery) => boolean, label: string) {
  const query = counters.statements.find(predicate);
  if (!query) throw new Error(`Could not capture the application ${label} query.`);
  return query;
}

function rowPayloadBytes(rows: unknown[]) { return Buffer.byteLength(JSON.stringify(rows)); }

function worstCaseProjectedPageBytes(rowCount: number) {
  const controls = (codePoints: number) => "\u0001".repeat(codePoints);
  const row = {
    id: "a".repeat(36), retrievedAt: "2026-01-01T00:00:00.000Z", title: controls(200),
    authorsPreview: [controls(80), controls(80), controls(80)], additionalAuthorsCount: 2_147_483_647,
    publicationYear: 3000, venuePreview: controls(100), doiPreview: controls(120),
    sourceRecordIdPreview: controls(120), abstractPreview: controls(240), rawCitationPreview: controls(300),
    currentMatch: { paperId: "b".repeat(36), paperTitle: controls(200) },
  };
  return Buffer.byteLength(JSON.stringify(Array.from({ length: rowCount }, () => row)));
}

function assertStructuralCaps(rows: Array<Record<string, unknown>>) {
  for (const row of rows) {
    const codePoints = (value: unknown) => typeof value === "string" ? Array.from(value).length : 0;
    if (codePoints(row.title) > 200) throw new Error("RetrievedRecord title exceeds its SQL preview cap.");
    if (!Array.isArray(row.authorsPreview) || row.authorsPreview.length > 3 || row.authorsPreview.some((author) => codePoints(author) > 80)) throw new Error("RetrievedRecord author preview exceeds its structural cap.");
    if (codePoints(row.venuePreview) > 100 || codePoints(row.doiPreview) > 120 || codePoints(row.sourceRecordIdPreview) > 120 || codePoints(row.abstractPreview) > 240 || codePoints(row.rawCitationPreview) > 300) throw new Error("RetrievedRecord text projection exceeds a SQL preview cap.");
    if (row.currentMatch && (codePoints((row.currentMatch as Record<string, unknown>).paperTitle) > 200 || typeof (row.currentMatch as Record<string, unknown>).paperId !== "string")) throw new Error("Current Paper projection exceeds its structural cap.");
    if ("url" in row || "authors" in row || "abstract" in row || "rawCitation" in row) throw new Error("The bounded row projection returned a full detail field.");
  }
}

async function main() {
  if (process.version !== "v22.13.0") throw new Error(`The benchmark requires Node 22.13.0; running ${process.version}.`);
  const configuredUrl = process.env.DATABASE_URL?.trim();
  if (!configuredUrl) throw new Error("Set DATABASE_URL to a PostgreSQL 16 server with permission to create and drop a uniquely named disposable database.");
  const databaseName = `litreview_slice46_read_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(configuredUrl, { max: 1, prepare: false });
  const benchmarkUrl = new URL(configuredUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  let databaseCreated = false;
  let benchmarkClient: postgres.Sql | undefined;
  let created: ReturnType<typeof createDb> | undefined;
  try {
    const versionRows = await admin`select current_setting('server_version_num')::integer as version, current_setting('server_version') as version_text`;
    const version = Number(versionRows[0]?.version);
    if (Math.floor(version / 10_000) !== 16) throw new Error(`The benchmark requires PostgreSQL 16; connected server_version_num=${version}.`);
    const postgresVersion = String(versionRows[0]?.version_text ?? "PostgreSQL 16");
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    benchmarkClient = postgres(benchmarkUrl.toString(), { max: 4, prepare: false });
    created = createDb(benchmarkUrl.toString());
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    const app = createReviewServices(created.db);
    const project = await app.createProject({ title: `Slice 46 acquisition benchmark ${randomUUID()}` });
    const source = (await app.listSearchSources(project.id))[0]!;
    const strategy = await app.createSearchStrategy(project.id, { searchSourceId: source.id, name: "Benchmark strategy", queryText: "slice46 benchmark query" });
    const runs = new Map<number, string>();
    for (const size of SIZES) {
      const run = await app.createSearchRun(project.id, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, reportedResultCount: size, executedAt: new Date("2026-01-01T00:00:00Z") });
      runs.set(size, run.id);
      await benchmarkClient.unsafe(`
        insert into retrieved_records(project_id, search_run_id, search_source_id, source_record_id, title, authors, abstract, doi, publication_year, venue, raw_citation, retrieved_at)
        select $1::uuid, $2::uuid, $3::uuid,
          case when n=1 then 'slice46-shared-source-id' when n=500 or n % 5000 = 0 then 'bench-' || $4::text || '-' || n::text else null end,
          case when n % 500 = 0 then 'Shared benchmark title' else 'Benchmark record ' || $4::text || ' ' || n::text end,
          array['Benchmark Author ' || n::text, 'Second Author', 'Third Author', 'Fourth Author'],
          repeat('Abstract preview text ', 80),
          case when n % 100 = 0 then 'https://doi.org/10.9999/slice46-shared' else '10.9999/benchmark-' || $4::text || '-' || n::text end,
          case when n % 500 = 0 then 2024 else 2000 + (n % 25) end,
          repeat('Benchmark Venue ', 20), repeat('Raw citation data ', 35),
          '2026-01-01T00:00:00Z'::timestamptz
        from generate_series(1, $4::integer) as series(n)
      `, [project.id, run.id, source.id, size]);
    }
    const candidateRun = await app.createSearchRun(project.id, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, reportedResultCount: 25, executedAt: new Date("2026-01-01T00:00:00Z") });
    const candidatePapers = [] as Array<{ id: string }>;
    const candidateRecordIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const candidateRecord = await app.createRetrievedRecord(project.id, { searchRunId: candidateRun.id, searchSourceId: source.id, sourceRecordId: `candidate-density-${index + 1}`, title: `Shared benchmark title candidate ${index + 1}`, doi: "10.9999/slice46-shared", publicationYear: 2024, retrievedAt: new Date("2026-01-01T00:00:00Z") });
      const createdPaper = await app.createPaperFromRetrievedRecord(project.id, candidateRecord.id);
      candidateRecordIds.push(candidateRecord.id);
      candidatePapers.push({ id: createdPaper.paper.id });
    }
    for (let index = 0; index < 147; index += 1) {
      await app.createSearchRun(project.id, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, reportedResultCount: 0, executedAt: new Date("2026-01-01T00:00:00Z") });
    }
    for (const [size, runId] of runs) {
      const linked = await app.createRetrievedRecord(project.id, { searchRunId: runId, searchSourceId: source.id, title: `Benchmark linked state ${size}`, retrievedAt: new Date("2026-01-04T00:00:00Z") });
      await app.linkRetrievedRecordToPaper(project.id, linked.id, candidatePapers[0]!.id);
      const unlinked = await app.createRetrievedRecord(project.id, { searchRunId: runId, searchSourceId: source.id, title: `Benchmark unlinked state ${size}`, retrievedAt: new Date("2026-01-03T00:00:00Z") });
      await app.linkRetrievedRecordToPaper(project.id, unlinked.id, candidatePapers[0]!.id);
      await app.unlinkRetrievedRecordFromPaper(project.id, unlinked.id, candidatePapers[0]!.id);
      const relinked = await app.createRetrievedRecord(project.id, { searchRunId: runId, searchSourceId: source.id, title: `Benchmark relinked state ${size}`, retrievedAt: new Date("2026-01-02T00:00:00Z") });
      await app.linkRetrievedRecordToPaper(project.id, relinked.id, candidatePapers[0]!.id);
      await app.relinkRetrievedRecord(project.id, relinked.id, candidatePapers[0]!.id, candidatePapers[1]!.id);
    }
    const sharedPaper = candidatePapers[0]!;
    for (const size of SIZES) {
      const runId = runs.get(size)!;
      await benchmarkClient.unsafe(`
        insert into retrieved_record_matches(project_id, retrieved_record_id, paper_id, action)
        select rr.project_id, rr.id, $3::uuid, 'linked'
        from retrieved_records rr
        where rr.project_id=$1::uuid and rr.search_run_id=$2::uuid
          and ((rr.source_record_id='slice46-shared-source-id' and $4::integer < 50000) or (rr.source_record_id like 'bench-' || $4::text || '-%' and split_part(rr.source_record_id, '-', 3)::integer % 10 = 0))
      `, [project.id, runId, sharedPaper.id, size]);
      await benchmarkClient.unsafe(`
        insert into retrieved_record_matches(project_id, retrieved_record_id, paper_id, action)
        select rr.project_id, rr.id, $3::uuid, 'unlinked'
        from retrieved_records rr
        where rr.project_id=$1::uuid and rr.search_run_id=$2::uuid
          and rr.source_record_id like 'bench-' || $4::text || '-%'
          and split_part(rr.source_record_id, '-', 3)::integer % 20 = 0
      `, [project.id, runId, sharedPaper.id, size]);
      await benchmarkClient.unsafe(`
        insert into retrieved_record_matches(project_id, retrieved_record_id, paper_id, action)
        select rr.project_id, rr.id, $3::uuid, event.action
        from retrieved_records rr
        cross join (values ('linked'), ('unlinked'), ('linked')) as event(action)
        where rr.project_id=$1::uuid and rr.search_run_id=$2::uuid
          and rr.source_record_id like 'bench-' || $4::text || '-%'
          and split_part(rr.source_record_id, '-', 3)::integer % 100 = 0
      `, [project.id, runId, candidatePapers[1]!.id, size]);
    }
    const fiftyKRunIdForFixtures = runs.get(50_000)!;
    const historyRecord = await app.createRetrievedRecord(project.id, { searchRunId: fiftyKRunIdForFixtures, searchSourceId: source.id, sourceRecordId: "benchmark-deep-history", title: "Benchmark deep history record", retrievedAt: new Date("2026-01-01T00:00:00Z") });
    const historyPaper = await app.addPaper(project.id, { title: "Benchmark deep history Paper" });
    for (let index = 0; index < 13; index += 1) {
      await app.linkRetrievedRecordToPaper(project.id, historyRecord.id, historyPaper.id);
      await app.unlinkRetrievedRecordFromPaper(project.id, historyRecord.id, historyPaper.id);
    }
    const titleSignalRecord = await app.createRetrievedRecord(project.id, { searchRunId: fiftyKRunIdForFixtures, searchSourceId: source.id, sourceRecordId: "benchmark-title-only-signal", title: "Slice46 benchmark title signal", publicationYear: 2024, retrievedAt: new Date("2026-01-01T00:00:00Z") });
    await app.addPaper(project.id, { title: "Slice46 benchmark title signal", publicationYear: 2024 });
    await benchmarkClient.unsafe("ANALYZE retrieved_records;");
    await benchmarkClient.unsafe("ANALYZE retrieved_record_matches;");
    await benchmarkClient.unsafe("ANALYZE papers;");
    const indexRows = await benchmarkClient`select to_regclass(${`public.${INDEX_NAME}`}) as index_name`;
    const indexFromMigration = indexRows[0]?.index_name != null;
    if (indexFromMigration) await benchmarkClient.unsafe(`DROP INDEX ${quoteIdentifier(INDEX_NAME)}`);
    await benchmarkClient.unsafe("ANALYZE retrieved_records;");

    const rawDatabase = created.db;
    const counters = createCounters();
    const readServices = createAcquisitionReadServices(monitorDatabase(rawDatabase, counters));
    const legacyCounters = createCounters();
    const legacyServices = createReviewServices(monitorDatabase(rawDatabase, legacyCounters));
    const workload: Array<Record<string, unknown>> = [];
    const plansBefore: Array<Record<string, unknown>> = [];
    const plansAfter: Array<Record<string, unknown>> = [];
    const finalPlans: Array<Record<string, unknown>> = [];
    const retrievedRecordQueries = new Map<number, { first: CapturedQuery; deep: CapturedQuery }>();
    const candidateQueries: Array<{ signal: string; first: CapturedQuery; deep?: CapturedQuery }> = [];
    const searchQueries: Array<{ field: string; query: CapturedQuery }> = [];
    let fiftyKRunId = "";

    for (const size of SIZES) {
      const runId = runs.get(size)!;
      resetCounters(counters);
      const page = await readServices.getRetrievedRecordPage(project.id, runId, { pageSize: PAGE_SIZE });
      const firstPageMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
      const firstQuery = requireCapturedQuery(counters, (query) => query.sql.includes("from retrieved_records rr"), "RetrievedRecord first page");
      assertStructuralCaps(page.items as unknown as Array<Record<string, unknown>>);
      const payloadBytes = rowPayloadBytes(page.items);
      if (payloadBytes > 512 * 1024) throw new Error(`50-row payload is ${payloadBytes} bytes, above 512 KiB.`);
      if (size === 50_000) {
        resetCounters(counters);
        const maxPage = await readServices.getRetrievedRecordPage(project.id, runId, { pageSize: 100 });
        const maxPageMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
        const maxPayloadBytes = rowPayloadBytes(maxPage.items);
        assertStructuralCaps(maxPage.items as unknown as Array<Record<string, unknown>>);
        if (maxPayloadBytes > 1024 * 1024) throw new Error(`100-row payload is ${maxPayloadBytes} bytes, above 1 MiB.`);
        workload.push({ read: "retrievedRecordMaximumPage", size, pageSize: 100, returnedItems: maxPage.items.length, ...maxPageMetrics, payloadUtf8Bytes: maxPayloadBytes });
      }
      resetCounters(counters);
      const cursorPage = await readServices.getRetrievedRecordPage(project.id, runId, { pageSize: PAGE_SIZE, cursor: page.nextCursor ?? undefined });
      const deepPageMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
      const deepQuery = requireCapturedQuery(counters, (query) => query.sql.includes("from retrieved_records rr"), "RetrievedRecord continuation");
      retrievedRecordQueries.set(size, { first: firstQuery, deep: deepQuery });
      if (size === 50_000) {
        fiftyKRunId = runId;
      }
      workload.push({
        read: "retrievedRecordPage", size, pageSize: PAGE_SIZE, returnedItems: page.items.length,
        hasMore: page.hasMore, ...firstPageMetrics, payloadUtf8Bytes: payloadBytes,
        selectedCurrentMatches: page.items.filter((item) => item.currentMatch).length,
      }, {
        read: "retrievedRecordContinuation", size, pageSize: PAGE_SIZE, returnedItems: cursorPage.items.length,
        hasMore: cursorPage.hasMore, ...deepPageMetrics, payloadUtf8Bytes: rowPayloadBytes(cursorPage.items),
      });
      plansBefore.push(await explain(benchmarkClient, `${size}-row RetrievedRecord first page before ordering index`, firstQuery));
      plansBefore.push(await explain(benchmarkClient, `${size}-row RetrievedRecord deep page before ordering index`, deepQuery));
    }

    resetCounters(counters);
    const runPage = await readServices.getSearchRunPage(project.id, { pageSize: 50 });
    const searchRunFirstMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
    const searchRunFirstQuery = requireCapturedQuery(counters, (query) => /select\s+run\.id/i.test(query.sql), "SearchRun first page");
    if (!runPage.nextCursor) throw new Error("The SearchRun workload did not produce a deep-page cursor.");
    resetCounters(counters);
    const runContinuation = await readServices.getSearchRunPage(project.id, { pageSize: 50, cursor: runPage.nextCursor });
    const searchRunDeepMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
    const searchRunDeepQuery = requireCapturedQuery(counters, (query) => /select\s+run\.id/i.test(query.sql), "SearchRun continuation");
    workload.push(
      { read: "searchRunPage", pageSize: 50, returnedItems: runPage.items.length, hasMore: runPage.hasMore, ...searchRunFirstMetrics, payloadUtf8Bytes: rowPayloadBytes(runPage.items) },
      { read: "searchRunContinuation", pageSize: 50, returnedItems: runContinuation.items.length, hasMore: runContinuation.hasMore, ...searchRunDeepMetrics, payloadUtf8Bytes: rowPayloadBytes(runContinuation.items) },
    );
    finalPlans.push(await explain(benchmarkClient, "SearchRun first page", searchRunFirstQuery));
    finalPlans.push(await explain(benchmarkClient, "SearchRun deep page", searchRunDeepQuery));

    resetCounters(counters);
    const detail = await readServices.getRetrievedRecordDetail(project.id, fiftyKRunId, historyRecord.id);
    const detailMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
    const detailQuery = requireCapturedQuery(counters, (query) => /select\s+rr\.id\s+as\s+record_id/i.test(query.sql), "exact RetrievedRecord detail");
    if (!detail) throw new Error("The exact benchmark RetrievedRecord was not found.");
    workload.push({ read: "exactRetrievedRecordDetail", returned: Boolean(detail), payloadUtf8Bytes: rowPayloadBytes([detail]), ...detailMetrics });
    finalPlans.push(await explain(benchmarkClient, "Exact RetrievedRecord detail", detailQuery));

    console.log("Captured bounded RetrievedRecord page workload; measuring the legacy full projection at smaller sizes next.");
    for (const size of [1_000, 10_000]) {
      resetCounters(legacyCounters);
      console.log(`Measuring legacy full projection at ${size.toLocaleString()} RetrievedRecords.`);
      const legacyStartedAt = process.hrtime.bigint();
      const legacyProjection = await legacyServices.listRetrievedRecordProjections(project.id, runs.get(size)!);
      const elapsedMs = Number(process.hrtime.bigint() - legacyStartedAt) / 1_000_000;
      workload.push({
        read: "legacyListRetrievedRecordProjections", size, returnedItems: legacyProjection.length,
        selectCount: legacyCounters.selectCount, rowsCrossingDriver: legacyCounters.driverRows,
        payloadUtf8Bytes: rowPayloadBytes(legacyProjection), elapsedMs,
      });
      console.log(`Completed ${size.toLocaleString()}-record legacy projection in ${elapsedMs.toFixed(1)} ms.`);
    }

    resetCounters(counters);
    const history = await readServices.getRetrievedRecordMatchHistoryPage(project.id, fiftyKRunId, historyRecord.id, { pageSize: 25 });
    const historyFirstMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
    const historyFirstQuery = requireCapturedQuery(counters, (query) => /select\s+match\.id/i.test(query.sql), "match-history first page");
    if (!history.nextCursor) throw new Error("The deep match-history workload did not produce a continuation cursor.");
    resetCounters(counters);
    const historyDeep = await readServices.getRetrievedRecordMatchHistoryPage(project.id, fiftyKRunId, historyRecord.id, { pageSize: 25, cursor: history.nextCursor });
    const historyDeepMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
    const historyDeepQuery = requireCapturedQuery(counters, (query) => /select\s+match\.id/i.test(query.sql), "match-history continuation");
    workload.push(
      { read: "matchHistoryPage", returnedItems: history.items.length, hasMore: history.hasMore, ...historyFirstMetrics, payloadUtf8Bytes: rowPayloadBytes(history.items) },
      { read: "matchHistoryContinuation", returnedItems: historyDeep.items.length, hasMore: historyDeep.hasMore, ...historyDeepMetrics, payloadUtf8Bytes: rowPayloadBytes(historyDeep.items) },
    );
    finalPlans.push(await explain(benchmarkClient, "Match-history first page", historyFirstQuery));
    finalPlans.push(await explain(benchmarkClient, "Match-history deep page", historyDeepQuery));

    const sourceSignalRecord = await benchmarkClient`select id from retrieved_records where project_id=${project.id}::uuid and search_run_id=${fiftyKRunId}::uuid and source_record_id='slice46-shared-source-id' limit 1`;
    if (!sourceSignalRecord[0]?.id) throw new Error("The stable source-record duplicate signal fixture was not found.");

    const measureCandidateSignal = async (signal: string, runId: string, recordId: string) => {
      resetCounters(counters);
      const first = await readServices.getRetrievedRecordDuplicateCandidatePage(project.id, runId, recordId, { pageSize: 20 });
      const firstMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
      const firstQuery = requireCapturedQuery(counters, (query) => /select\s+paper\.id/i.test(query.sql), `${signal} duplicate-candidate first page`);
      let deep: CapturedQuery | undefined;
      let continuationItems = 0;
      let continuationHasMore = false;
      let continuationPayloadUtf8Bytes = 0;
      let continuationMetrics = { selectCount: 0, rowsCrossingDriver: 0 };
      if (first.nextCursor) {
        resetCounters(counters);
        const next = await readServices.getRetrievedRecordDuplicateCandidatePage(project.id, runId, recordId, { pageSize: 20, cursor: first.nextCursor });
        continuationItems = next.items.length;
        continuationHasMore = next.hasMore;
        continuationPayloadUtf8Bytes = rowPayloadBytes(next.items);
        continuationMetrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
        deep = requireCapturedQuery(counters, (query) => /select\s+paper\.id/i.test(query.sql), `${signal} duplicate-candidate continuation`);
      }
      candidateQueries.push({ signal, first: firstQuery, deep });
      workload.push({
        read: "duplicateCandidates", signal, firstPageItems: first.items.length, firstPageHasMore: first.hasMore,
        firstPagePayloadUtf8Bytes: rowPayloadBytes(first.items), ...firstMetrics,
        continuationItems, continuationHasMore, continuationPayloadUtf8Bytes,
        continuationSelectCount: continuationMetrics.selectCount, continuationRowsCrossingDriver: continuationMetrics.rowsCrossingDriver,
        linkedSiblingPaperIncluded: signal === "stable sourceRecordId" && first.items.some((paper) => paper.id === sharedPaper.id),
      });
    };

    await measureCandidateSignal("DOI", candidateRun.id, candidateRecordIds[0]!);
    await measureCandidateSignal("title and year", fiftyKRunId, titleSignalRecord.id);
    await measureCandidateSignal("stable sourceRecordId", fiftyKRunId, String(sourceSignalRecord[0].id));

    for (const search of [
      { field: "title" as const, query: "Shared benchmark title" },
      { field: "doi" as const, query: "https://doi.org/10.9999/slice46-shared" },
      { field: "sourceRecordId" as const, query: "bench-50000-500" },
    ]) {
      resetCounters(counters);
      const resultPage = await readServices.getRetrievedRecordPage(project.id, fiftyKRunId, { pageSize: 50, searchField: search.field, query: search.query });
      const metrics = { selectCount: counters.selectCount, rowsCrossingDriver: counters.driverRows };
      const query = requireCapturedQuery(counters, (captured) => captured.sql.includes("from retrieved_records rr"), `${search.field} search`);
      searchQueries.push({ field: search.field, query });
      workload.push({ read: "retrievedRecordExactSearch", field: search.field, returnedItems: resultPage.items.length, hasMore: resultPage.hasMore, payloadUtf8Bytes: rowPayloadBytes(resultPage.items), ...metrics });
    }

    for (const size of [1_000, 10_000, 50_000]) {
      const pair = retrievedRecordQueries.get(size)!;
      plansBefore.push(await explain(benchmarkClient, `${size}-row RetrievedRecord first page before 0035`, pair.first));
      plansBefore.push(await explain(benchmarkClient, `${size}-row RetrievedRecord deep page before 0035`, pair.deep));
    }
    for (const candidate of candidateQueries) {
      plansBefore.push(await explain(benchmarkClient, `${candidate.signal} duplicate-candidate first page before 0035`, candidate.first));
      if (candidate.deep) plansBefore.push(await explain(benchmarkClient, `${candidate.signal} duplicate-candidate deep page before 0035`, candidate.deep));
    }

    await benchmarkClient.unsafe(`CREATE INDEX ${quoteIdentifier(INDEX_NAME)} ON retrieved_records(project_id, search_run_id, retrieved_at DESC NULLS LAST, id DESC NULLS LAST)`);
    await benchmarkClient.unsafe("ANALYZE retrieved_records;");
    for (const size of [1_000, 10_000, 50_000]) {
      const pair = retrievedRecordQueries.get(size)!;
      plansAfter.push(await explain(benchmarkClient, `${size}-row RetrievedRecord first page after 0035`, pair.first));
      plansAfter.push(await explain(benchmarkClient, `${size}-row RetrievedRecord deep page after 0035`, pair.deep));
    }
    for (const candidate of candidateQueries) {
      plansAfter.push(await explain(benchmarkClient, `${candidate.signal} duplicate-candidate first page after 0035`, candidate.first));
      if (candidate.deep) plansAfter.push(await explain(benchmarkClient, `${candidate.signal} duplicate-candidate deep page after 0035`, candidate.deep));
    }
    const fiftyKDeepPlan = plansAfter.find((plan) => plan.label === "50000-row RetrievedRecord deep page after 0035");
    const fiftyKRecordScan = (fiftyKDeepPlan?.planSummary as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes?.find((node) => node.relation === "retrieved_records");
    const actualRows = Number(fiftyKRecordScan?.actualRows);
    const actualLoops = Number(fiftyKRecordScan?.actualLoops);
    const rowsRemovedByFilter = Number(fiftyKRecordScan?.rowsRemovedByFilter ?? 0);
    const visitedRows = (actualRows + rowsRemovedByFilter) * actualLoops;
    if (
      fiftyKRecordScan?.index !== INDEX_NAME ||
      !Number.isFinite(actualRows) ||
      !Number.isFinite(actualLoops) || actualLoops < 1 ||
      !Number.isFinite(rowsRemovedByFilter) || rowsRemovedByFilter < 0 ||
      visitedRows > PAGE_SIZE + 1
    ) {
      throw new Error("The 50k deep RetrievedRecord page did not use the ordering index while visiting at most pageSize+1 rows.");
    }
    const searchPlans = await Promise.all(searchQueries.map(({ field, query }) => explain(benchmarkClient, `${field} exact search`, query)));
    finalPlans.push(...searchPlans);
    const otherPlans = await Promise.all([searchRunFirstQuery, searchRunDeepQuery, detailQuery, historyFirstQuery, historyDeepQuery].map((query, index) => explain(benchmarkClient, ["SearchRun first page", "SearchRun deep page", "Exact RetrievedRecord detail", "Match-history first page", "Match-history deep page"][index]!, query)));
    finalPlans.push(...otherPlans);
    const finalIndex = await benchmarkClient`select pg_get_indexdef(indexrelid) as definition from pg_index where indexrelid=to_regclass(${`public.${INDEX_NAME}`})`;
    const worstCase50Rows = worstCaseProjectedPageBytes(50);
    const worstCase100Rows = worstCaseProjectedPageBytes(100);
    if (worstCase50Rows > 512 * 1024 || worstCase100Rows > 1024 * 1024) throw new Error(`Worst-case capped JSON payload exceeds the UI bound: ${worstCase50Rows} / ${worstCase100Rows} bytes.`);
    const result = {
      slice: 46,
      runtime: process.version,
      postgresMajor: 16,
      postgresVersion,
      baseline: "0034_evidence_set_composition_timeline",
      migratedIndexPresent: indexFromMigration,
      indexDefinition: finalIndex[0]?.definition ?? null,
      workloadSizes: SIZES,
      methodology: "Queries are captured from the application read services. EXPLAIN retains full sanitized JSON for first and deep RetrievedRecord pages before and after the 0035 ordering index, SearchRun first/deep pages, exact record detail, match history first/deep pages, DOI/title-year/stable-source candidate signals, and title/DOI/sourceRecordId exact searches. Current-match projection is embedded in the RetrievedRecord page SQL. The legacy full run projection is measured at 1k and 10k rows. Driver-row counts include the pageSize+1 lookahead rows; retained SQL parameters and plan literals are redacted to shape only. The workload includes never-linked, linked, linked-then-unlinked, relinked, deep-history, candidate-dense, and noncandidate records. EXPLAIN is structural evidence; wall time is diagnostic.",
      projectedPayloadCaps: { defaultPageBytes: 512 * 1024, maxPageBytes: 1024 * 1024, worstCaseControlCharacterJsonBytesAt50: worstCase50Rows, worstCaseControlCharacterJsonBytesAt100: worstCase100Rows, sqlCodePointCaps: { title: 200, authorCount: 3, author: 80, venue: 100, doi: 120, sourceRecordId: 120, abstract: 240, rawCitation: 300, currentPaperTitle: 200 } },
      exact50kRetrievedRecordPageQuery: {
        sql: retrievedRecordQueries.get(50_000)!.first.sql,
        params: safeParameterShape(retrievedRecordQueries.get(50_000)!.first.params),
        rowsCrossingDriver: retrievedRecordQueries.get(50_000)!.first.driverRows,
      },
      workload,
      beforeOrderingIndex: plansBefore,
      afterOrderingIndex: plansAfter,
      finalQueryPlans: finalPlans,
    };
    const outPath = path.resolve(process.cwd(), "docs", "benchmarks", "slice46-acquisition-read-paths.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ outPath, workload, indexFromMigration, indexDefinition: result.indexDefinition }, null, 2));
  } finally {
    if (created) await created.client.end();
    if (benchmarkClient) await benchmarkClient.end();
    if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]"));
  process.exitCode = 1;
});
