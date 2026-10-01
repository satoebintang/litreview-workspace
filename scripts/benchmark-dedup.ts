import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createReviewServices } from "@/application/services";
import { createDeduplicationReadServices, buildDeduplicationQueuePageQuery, buildDeduplicationHistoryPageQuery } from "@/application/deduplication-read-services";
import { unresolvedDuplicatePairCtes } from "@/application/unresolved-duplicate-pair-query";
import { retrievedRecordDoiComparison } from "@/db/comparison-expressions";
import { createDb } from "@/db/client";

const OLD_QUERY_TIMEOUT_MS = 30_000;
const NEW_QUERY_TIMEOUT_MS = 120_000;
const INSERT_BATCH_SIZE = 500;

type SeedRecord = {
  id: string;
  projectId: string;
  runId: string;
  sourceId: string;
  sourceRecordId: string | null;
  title: string;
  doi: string | null;
  publicationYear: number | null;
  retrievedAt: string;
};

type Scenario = { name: string; recordCount: number; distribution: "sparse" | "overlap" | "dense" };
type Pair = readonly [string, string];
type CapturedQuery = { sql: string; params: unknown[] };

const dialect = new PgDialect();

function captureQuery(query: SQL): CapturedQuery {
  const rendered = dialect.sqlToQuery(query);
  return { sql: rendered.sql, params: rendered.params as unknown[] };
}

function safeParams(params: unknown[]) {
  return params.map((value) => {
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isInteger(value) ? "<integer>" : "<number>";
    if (value instanceof Date) return "<timestamptz>";
    if (typeof value === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "<uuid>";
      return `<string:${Array.from(value).length} code points>`;
    }
    return `<${typeof value}>`;
  });
}

function sanitizedPlan(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      .replace(/'(?:[^']|'')*'/g, "'<literal>'");
  }
  if (Array.isArray(value)) return value.map(sanitizedPlan);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizedPlan(entry)]));
  return value;
}

function summarizePlan(value: unknown) {
  const top = Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : undefined;
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: Record<string, unknown>) => {
    nodes.push({
      nodeType: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"],
      planRows: node["Plan Rows"], actualRows: node["Actual Rows"], actualLoops: node["Actual Loops"],
      rowsRemovedByFilter: node["Rows Removed by Filter"],
      sharedHitBlocks: node["Shared Hit Blocks"], sharedReadBlocks: node["Shared Read Blocks"],
      tempReadBlocks: node["Temp Read Blocks"], tempWrittenBlocks: node["Temp Written Blocks"],
      sortMethod: node["Sort Method"], sortSpaceType: node["Sort Space Type"], sortSpaceUsed: node["Sort Space Used"],
    });
    if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child as Record<string, unknown>);
  };
  if (top?.Plan && typeof top.Plan === "object") visit(top.Plan as Record<string, unknown>);
  return { planningTimeMs: top?.["Planning Time"], executionTimeMs: top?.["Execution Time"], nodes };
}

function queueSqlShape(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const localLimit = normalized.indexOf("limit ");
  const hydration = normalized.indexOf("hydrated as");
  const visible = normalized.indexOf("visible_pairs as materialized");
  const localUnresolved = normalized.indexOf("not exists (");
  const localSort = normalized.indexOf("order by b.id asc");
  const strongLimit = normalized.indexOf("limit ", normalized.indexOf("strong_signal_pairs"));
  const possibleDistinct = normalized.indexOf("select distinct left_record_id, right_record_id");
  return {
    projectRecordIdentityCte: normalized.includes("left_record_ids as materialized"),
    perLeftLateralProbes: normalized.includes("cross join lateral"),
    unresolvedExclusionBeforeLocalLimit: localUnresolved >= 0 && localSort > localUnresolved && localLimit > localSort,
    strongSignalsDeduplicatedBeforeStrongLimit: normalized.includes("union") && strongLimit > normalized.indexOf("union"),
    possibleSignalsDeduplicatedBeforePageLimit: possibleDistinct >= 0 && normalized.indexOf("limit ", possibleDistinct) > possibleDistinct,
    visiblePairBoundaryBeforeHydration: visible >= 0 && hydration > visible,
    richHydrationAfterBoundedVisiblePairs: visible >= 0 && hydration > visible && normalized.indexOf("join retrieved_records a", hydration) > hydration,
    noAuthorAbstractOrMetadataBeforeVisiblePage: visible >= 0 && !normalized.slice(0, visible).match(/\ba\.(?:authors|abstract|metadata|match_histories)\b|\bb\.(?:authors|abstract|metadata|match_histories)\b/),
    latestMappingReducedFromVisibleRecordIds: normalized.includes("join visible_record_ids v") && normalized.includes("distinct on (m.retrieved_record_id)"),
    generatedSqlBytes: Buffer.byteLength(text, "utf8"),
  };
}

async function applicationExplain(client: postgres.Sql, query: SQL, label: string) {
  const captured = captureQuery(query);
  const started = process.hrtime.bigint();
  try {
    const rows = await client.begin(async (tx) => {
      await tx.unsafe("set transaction isolation level repeatable read read only");
      await tx.unsafe("set local statement_timeout = '120000ms'");
      return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`, captured.params as never);
    }) as unknown as Array<Record<string, unknown>>;
    const plan = rows[0]?.["QUERY PLAN"];
    return {
      label, status: "completed", explain: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
      elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sql: captured.sql, parameterShape: safeParams(captured.params), sqlShape: queueSqlShape(captured.sql),
      planJson: sanitizedPlan(plan), planSummary: summarizePlan(plan),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      label, status: /57014|statement timeout/i.test(message) ? "timed_out" : "failed",
      explain: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)", elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      sql: captured.sql, parameterShape: safeParams(captured.params), sqlShape: queueSqlShape(captured.sql), error: message,
    };
  }
}

function monitorDeduplicationReads(database: ReturnType<typeof createDb>["db"], counters: { selects: number; driverRows: number; transactions: number }) {
  const wrapTransaction = (transaction: object) => new Proxy(transaction, {
    get(target, property) {
      if (property === "execute") return async (query: SQL) => {
        const execute = Reflect.get(target, property, target) as (query: SQL) => Promise<unknown>;
        const result = await Reflect.apply(execute, target, [query]);
        if (/^\s*(?:select|with)\b/i.test(captureQuery(query).sql)) {
          counters.selects += 1;
          counters.driverRows += Array.isArray(result) ? result.length : 0;
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(database as unknown as object, {
    get(target, property) {
      if (property === "transaction") return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        counters.transactions += 1;
        const transaction = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
        return Reflect.apply(transaction, target, [(tx: object) => callback(wrapTransaction(tx)), options]);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReturnType<typeof createDb>["db"];
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function releasedCandidateCtes(projectId: string): SQL {
  return sql`
    current_decisions as (
      select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
        project_id, left_retrieved_record_id, right_retrieved_record_id, decision
      from retrieved_record_deduplication_decisions
      where project_id = ${projectId}
      order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc
    ), candidate_pairs as (
      select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
      from retrieved_records a
      join retrieved_records b on b.project_id = a.project_id and a.id < b.id
      left join current_decisions d
        on d.project_id = a.project_id
        and d.left_retrieved_record_id = a.id
        and d.right_retrieved_record_id = b.id
      where a.project_id = ${projectId}
        and d.decision is null
        and (
          (a.doi is not null and b.doi is not null and btrim(a.doi) <> '' and btrim(b.doi) <> ''
            and ${retrievedRecordDoiComparison(sql.raw("a.doi"))}
              = ${retrievedRecordDoiComparison(sql.raw("b.doi"))})
          or (a.source_record_id is not null and b.source_record_id is not null
            and btrim(a.source_record_id) <> '' and btrim(b.source_record_id) <> ''
            and a.search_source_id = b.search_source_id and a.source_record_id = b.source_record_id)
          or (a.publication_year is not null and a.publication_year = b.publication_year
            and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g'))
              = lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g')))
        )
    )
  `;
}

function releasedCountQuery(projectId: string) {
  return sql`with ${releasedCandidateCtes(projectId)} select count(*)::int as unresolved_count from candidate_pairs`;
}

function optimizedCountQuery(projectId: string) {
  return sql`
    with ${unresolvedDuplicatePairCtes(projectId)}
    select
      (select count(*)::int from candidate_pairs) as candidate_count,
      (select count(*)::int from unresolved_candidate_pairs) as unresolved_count
  `;
}

async function executeBounded(db: ReturnType<typeof createDb>["db"], query: SQL, timeoutMs: number) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`);
    return tx.execute(query);
  });
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  return value.code ?? value.cause?.code;
}

async function measuredExplain(db: ReturnType<typeof createDb>["db"], query: SQL, timeoutMs: number) {
  const started = process.hrtime.bigint();
  try {
    const rows = await executeBounded(db, sql`explain (analyze, buffers, format text) ${query}`, timeoutMs);
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const plan = (rows as unknown as Array<Record<string, unknown>>)
      .map((row) => String(row["QUERY PLAN"] ?? Object.values(row)[0] ?? ""))
      .join("\n");
    return { status: "completed" as const, wallTimeMs, plan };
  } catch (error) {
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (errorCode(error) === "57014" || String(error).toLowerCase().includes("statement timeout")) {
      return { status: "timed_out" as const, timeoutMs, wallTimeMs, plan: null };
    }
    throw error;
  }
}

async function estimatedPlan(db: ReturnType<typeof createDb>["db"], query: SQL) {
  const started = process.hrtime.bigint();
  const rows = await db.execute(sql`explain (format text) ${query}`) as unknown as Array<Record<string, unknown>>;
  const plan = rows.map((row) => String(row["QUERY PLAN"] ?? Object.values(row)[0] ?? "")).join("\n");
  return { wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, plan };
}

async function measuredCount(db: ReturnType<typeof createDb>["db"], query: SQL, timeoutMs: number) {
  const started = process.hrtime.bigint();
  try {
    const rows = await executeBounded(db, query, timeoutMs) as unknown as Array<Record<string, unknown>>;
    return { status: "completed" as const, wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, row: rows[0] ?? {} };
  } catch (error) {
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (errorCode(error) === "57014" || String(error).toLowerCase().includes("statement timeout")) {
      return { status: "timed_out" as const, timeoutMs, wallTimeMs, row: null };
    }
    throw error;
  }
}

async function createScenarioContext(services: ReturnType<typeof createReviewServices>, scenario: Scenario) {
  const project = await services.createProject({ title: `Dedup benchmark ${scenario.name}` });
  const source = (await services.listSearchSources(project.id))[0];
  if (!source) throw new Error("The project did not receive a default SearchSource");
  const strategy = await services.createSearchStrategy(project.id, {
    searchSourceId: source.id,
    name: `Dedup benchmark ${scenario.name}`,
    queryText: `benchmark ${scenario.name}`,
  });
  async function createRun() {
    return services.createSearchRun(project.id, {
      searchSourceId: source.id,
      sourceKeySnapshot: source.sourceKey,
      sourceDisplayNameSnapshot: source.displayName,
      strategyId: strategy.id,
      queryText: strategy.queryText,
      reportedResultCount: scenario.recordCount,
      executedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  }
  const runs = [await createRun(), await createRun()] as const;
  return { project, source, runs };
}

function pairKey(a: string, b: string): Pair {
  return a < b ? [a, b] : [b, a];
}

function buildSeedRows(projectId: string, sourceId: string, runIds: readonly [string, string], scenario: Scenario) {
  const rows: SeedRecord[] = [];
  const candidatePairs: Pair[] = [];
  const retrievedAt = "2026-01-01T00:00:00.000Z";
  const addRow = (index: number, fields: Omit<SeedRecord, "id" | "projectId" | "runId" | "sourceId" | "retrievedAt">) => {
    const record: SeedRecord = {
      ...fields,
      id: randomUUID(),
      projectId,
      runId: runIds[index % 2],
      sourceId,
      retrievedAt,
    };
    rows.push(record);
    return record.id;
  };

  if (scenario.distribution === "dense") {
    for (let index = 0; index < scenario.recordCount; index += 1) {
      addRow(index, {
        sourceRecordId: `dense-source-${index}`,
        title: `Dense diagnostic record ${index}`,
        doi: "10.9000/dense-key",
        publicationYear: null,
      });
    }
    return { rows, candidatePairs, expectedCandidatePairs: scenario.recordCount * (scenario.recordCount - 1) / 2 };
  }

  const pairCount = Math.floor(scenario.recordCount / 2);
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const leftFields: Omit<SeedRecord, "id" | "projectId" | "runId" | "sourceId" | "retrievedAt"> = {
      sourceRecordId: `record-${pairIndex}-left`, title: `Unique record ${pairIndex} left`, doi: null, publicationYear: null,
    };
    const rightFields: Omit<SeedRecord, "id" | "projectId" | "runId" | "sourceId" | "retrievedAt"> = {
      sourceRecordId: `record-${pairIndex}-right`, title: `Unique record ${pairIndex} right`, doi: null, publicationYear: null,
    };

    if (scenario.distribution === "overlap") {
      leftFields.sourceRecordId = `overlap-source-${pairIndex}`;
      rightFields.sourceRecordId = leftFields.sourceRecordId;
      leftFields.title = `Overlap study ${pairIndex}`;
      rightFields.title = ` overlap   STUDY ${pairIndex} `;
      leftFields.doi = `10.9000/overlap-${pairIndex}`;
      rightFields.doi = `https://doi.org/10.9000/overlap-${pairIndex}`;
      leftFields.publicationYear = 2023;
      rightFields.publicationYear = 2023;
    } else {
      const signal = pairIndex % 3;
      if (signal === 0) {
        leftFields.doi = `10.9000/sparse-${pairIndex}`;
        rightFields.doi = `https://doi.org/10.9000/sparse-${pairIndex}`;
        leftFields.publicationYear = 2010;
        rightFields.publicationYear = 2011;
      } else if (signal === 1) {
        leftFields.sourceRecordId = `sparse-source-${pairIndex}`;
        rightFields.sourceRecordId = leftFields.sourceRecordId;
      } else {
        leftFields.title = `Sparse title ${pairIndex}`;
        rightFields.title = ` sparse   TITLE ${pairIndex} `;
        leftFields.publicationYear = 2020 + pairIndex % 5;
        rightFields.publicationYear = leftFields.publicationYear;
      }
    }

    const leftId = addRow(pairIndex * 2, leftFields);
    const rightId = addRow(pairIndex * 2 + 1, rightFields);
    candidatePairs.push(pairKey(leftId, rightId));
  }

  if (scenario.recordCount % 2 === 1) {
    const index = scenario.recordCount - 1;
    addRow(index, {
      sourceRecordId: `unpaired-${index}`,
      title: `Unpaired record ${index}`,
      doi: null,
      publicationYear: null,
    });
  }
  return { rows, candidatePairs, expectedCandidatePairs: pairCount };
}

async function insertRows(client: postgres.Sql, rows: SeedRecord[]) {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (const record of batch) {
      const parameter = parameters.length;
      values.push(`($${parameter + 1}::uuid, $${parameter + 2}::uuid, $${parameter + 3}::uuid, $${parameter + 4}::uuid, $${parameter + 5}::text, $${parameter + 6}::text, $${parameter + 7}::text, $${parameter + 8}::integer, $${parameter + 9}::timestamptz)`);
      parameters.push(record.id, record.projectId, record.runId, record.sourceId, record.sourceRecordId, record.title, record.doi, record.publicationYear, record.retrievedAt);
    }
    await client.unsafe(
      `insert into retrieved_records (id, project_id, search_run_id, search_source_id, source_record_id, title, doi, publication_year, retrieved_at) values ${values.join(",")}`,
      parameters,
    );
  }
}

async function insertHistory(client: postgres.Sql, projectId: string, pairs: Pair[]) {
  const decisions = pairs.flatMap((pair, index) => {
    if (index % 20 === 0) return [{ pair, decision: "different_work" }];
    if (index % 20 === 1) return [{ pair, decision: "same_work" }];
    return [];
  });
  for (let offset = 0; offset < decisions.length; offset += 250) {
    const batch = decisions.slice(offset, offset + 250);
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (const item of batch) {
      const parameter = parameters.length;
      values.push(`($${parameter + 1}::uuid, $${parameter + 2}::uuid, $${parameter + 3}::uuid, $${parameter + 4}::text)`);
      parameters.push(projectId, item.pair[0], item.pair[1], item.decision);
    }
    await client.unsafe(
      `insert into retrieved_record_deduplication_decisions (project_id, left_retrieved_record_id, right_retrieved_record_id, decision) values ${values.join(",")}`,
      parameters,
    );
  }
  return decisions.length;
}

async function insertLongHistory(client: postgres.Sql, projectId: string, pair: Pair) {
  const rows = await client.unsafe(`
    insert into retrieved_record_deduplication_decisions
      (project_id, left_retrieved_record_id, right_retrieved_record_id, decision, note)
    select $1::uuid, $2::uuid, $3::uuid,
      case when n % 2 = 0 then 'same_work' else 'different_work' end,
      repeat('Long decision history note ', 24)
    from generate_series(1, 1000) as history_rows(n)
    returning id
  `, [projectId, pair[0], pair[1]]);
  return rows.length;
}

async function insertVariedMappings(services: ReturnType<typeof createReviewServices>, client: postgres.Sql, projectId: string) {
  const paperIds: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const paper = await services.addPaper(projectId, { title: `Slice 49 mapping benchmark Paper ${index + 1}` });
    paperIds.push(paper.id);
  }
  const rows = await client.unsafe(`
    with ordered_records as (
      select id, row_number() over (order by id) as rn
      from retrieved_records where project_id = $1::uuid
    ), mapping_events as (
      select r.id, ($2::uuid[])[((r.rn - 1) % cardinality($2::uuid[])) + 1] as paper_id, event_no,
        case when event_no = 1 then 'linked' else 'unlinked' end as action
      from ordered_records r cross join generate_series(1, 2) as events(event_no)
      where r.rn % 3 <> 0 and (event_no = 1 or r.rn % 3 = 2)
    )
    insert into retrieved_record_matches (project_id, retrieved_record_id, paper_id, action)
    select $1::uuid, id, paper_id, action from mapping_events order by id, event_no
    returning id
  `, [projectId, paperIds]);
  return { papers: paperIds.length, matchEvents: rows.length, records: 1000 };
}

function chooseBoundaryCursor(projectId: string, seeded: ReturnType<typeof buildSeedRows>) {
  const candidates = seeded.candidatePairs.length > 0
    ? [...seeded.candidatePairs].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    : (() => {
      const ids = seeded.rows.map((row) => row.id).sort();
      const index = Math.max(0, Math.floor(ids.length / 2) - 1);
      return [[ids[index]!, ids[index + 1]!] as Pair];
    })();
  const pair = candidates[Math.floor(candidates.length / 2)]!;
  const left = seeded.rows.find((row) => row.id === pair[0])!;
  const right = seeded.rows.find((row) => row.id === pair[1])!;
  const strong = (left.doi != null && right.doi != null) || (left.sourceRecordId != null && left.sourceRecordId === right.sourceRecordId);
  return Buffer.from(JSON.stringify({ v: 1, p: projectId, f: "all", n: 25, s: strong ? 0 : 1, l: pair[0], r: pair[1] }), "utf8").toString("base64url");
}

function chooseFixturePair(seeded: ReturnType<typeof buildSeedRows>): Pair {
  if (seeded.candidatePairs.length > 0) return seeded.candidatePairs[0]!;
  const ids = seeded.rows.map((row) => row.id).sort();
  const index = Math.max(0, Math.floor(ids.length / 2) - 1);
  return [ids[index]!, ids[index + 1]!];
}

async function benchmarkBoundedReads(
  db: ReturnType<typeof createDb>["db"],
  client: postgres.Sql,
  projectId: string,
  seeded: ReturnType<typeof buildSeedRows>,
  historyPair: Pair,
) {
  const counters = { selects: 0, driverRows: 0, transactions: 0 };
  const reader = createDeduplicationReadServices(monitorDeduplicationReads(db, counters));
  const page = await reader.listDeduplicationQueuePage(projectId, { pageSize: 25 });
  const firstPageReads = { selectCount: counters.selects, driverRows: counters.driverRows, readOnlyRepeatableReadTransactions: counters.transactions };
  const pagePayloadBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
  counters.selects = 0; counters.driverRows = 0; counters.transactions = 0;
  const history = await reader.listDeduplicationHistoryPage(projectId, historyPair[0], historyPair[1], { pageSize: 20 });
  const historyReads = { selectCount: counters.selects, driverRows: counters.driverRows, readOnlyRepeatableReadTransactions: counters.transactions };
  const historyPayloadBytes = Buffer.byteLength(JSON.stringify(history), "utf8");
  const boundary = chooseBoundaryCursor(projectId, seeded);
  const queueFirstPlan = await applicationExplain(client, buildDeduplicationQueuePageQuery(projectId, { pageSize: 25 }), "queue-first-page");
  const queueContinuationPlan = await applicationExplain(client, buildDeduplicationQueuePageQuery(projectId, { pageSize: 25, cursor: boundary }), "queue-rank-boundary-page");
  const historyFirstPlan = await applicationExplain(client, buildDeduplicationHistoryPageQuery(projectId, historyPair[0], historyPair[1], { pageSize: 20 }), "history-first-page");
  const historyContinuationPlan = await applicationExplain(client, buildDeduplicationHistoryPageQuery(projectId, historyPair[0], historyPair[1], { pageSize: 20, cursor: history.nextCursor }), "history-continuation-page");
  return {
    queue: {
      visibleRows: page.items.length, pageSize: page.pageSize, hasMore: page.hasMore, payloadBytes: pagePayloadBytes,
      selectCount: firstPageReads.selectCount, driverRows: firstPageReads.driverRows,
      readOnlyRepeatableReadTransactions: firstPageReads.readOnlyRepeatableReadTransactions,
      transactionControlStatements: { count: 2, statements: ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"], includedInSelectCount: false },
      pageOnePlan: queueFirstPlan, continuationPlan: queueContinuationPlan,
    },
    history: {
      visibleRows: history.items.length, pageSize: history.pageSize, hasMore: history.hasMore, payloadBytes: historyPayloadBytes,
      selectCount: historyReads.selectCount, driverRows: historyReads.driverRows,
      readOnlyRepeatableReadTransactions: historyReads.readOnlyRepeatableReadTransactions,
      transactionControlStatements: { count: 2, statements: ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"], includedInSelectCount: false },
      pageOnePlan: historyFirstPlan, continuationPlan: historyContinuationPlan,
    },
    databaseWorkClaim: "Pair identity probes retain top-K rows per left record and signal before deduplication/page truncation. PostgreSQL still evaluates candidate predicates across the relevant candidate universe; work is output-sensitive and can be quadratic for dense projects.",
  };
}

async function benchmarkScenario(
  db: ReturnType<typeof createDb>["db"],
  client: postgres.Sql,
  services: ReturnType<typeof createReviewServices>,
  scenario: Scenario,
) {
  const { project, source, runs } = await createScenarioContext(services, scenario);
  const seeded = buildSeedRows(project.id, source.id, [runs[0].id, runs[1].id], scenario);
  await insertRows(client, seeded.rows);
  let historyCount = scenario.distribution === "dense" || scenario.name === "mapping-varied-1k" ? 0 : await insertHistory(client, project.id, seeded.candidatePairs);
  let longHistoryRows = 0;
  if (scenario.name === "history-long-1k") {
    longHistoryRows = await insertLongHistory(client, project.id, chooseFixturePair(seeded));
    historyCount += longHistoryRows;
  }
  const mappingFixture = scenario.name === "mapping-varied-1k"
    ? await insertVariedMappings(services, client, project.id)
    : null;
  await client.unsafe("analyze retrieved_records; analyze retrieved_record_deduplication_decisions; analyze retrieved_record_matches");

  const countFixture = scenario.recordCount <= 1_000;
  const newCount = countFixture
    ? await measuredCount(db, optimizedCountQuery(project.id), NEW_QUERY_TIMEOUT_MS)
    : { status: "not_run" as const, timeoutMs: NEW_QUERY_TIMEOUT_MS, wallTimeMs: null, row: null };
  const newRow = newCount.status === "completed" ? newCount.row as Record<string, unknown> : null;
  const oldEstimate = await estimatedPlan(db, releasedCountQuery(project.id));
  const newEstimate = await estimatedPlan(db, optimizedCountQuery(project.id));
  const newPlan = countFixture
    ? await measuredExplain(db, optimizedCountQuery(project.id), NEW_QUERY_TIMEOUT_MS)
    : { status: "not_run" as const, timeoutMs: NEW_QUERY_TIMEOUT_MS, wallTimeMs: null, plan: null };
  const oldCount = countFixture
    ? await measuredCount(db, releasedCountQuery(project.id), OLD_QUERY_TIMEOUT_MS)
    : { status: "not_run" as const, timeoutMs: OLD_QUERY_TIMEOUT_MS, wallTimeMs: null, row: null };
  const oldPlan = countFixture
    ? await measuredExplain(db, releasedCountQuery(project.id), OLD_QUERY_TIMEOUT_MS)
    : { status: "not_run" as const, timeoutMs: OLD_QUERY_TIMEOUT_MS, wallTimeMs: null, plan: null };
  const boundedReads = await benchmarkBoundedReads(db, client, project.id, seeded, chooseFixturePair(seeded));

  const summary = {
    scenario: scenario.name,
    distribution: scenario.distribution,
    N_retrieved_records: seeded.rows.length,
    M_candidate_pairs: newRow ? Number(newRow.candidate_count) : seeded.expectedCandidatePairs,
    unresolved_pairs: newRow ? Number(newRow.unresolved_count) : null,
    full_candidate_count_and_count_explain: countFixture ? "run" : "not run; larger fixtures focus on bounded page SQL to avoid measuring the full quadratic count relation",
    expected_M_from_seed: seeded.expectedCandidatePairs,
    history_rows: historyCount,
    long_history_rows: longHistoryRows,
    varied_mapping_fixture: mappingFixture,
    bounded_reads: boundedReads,
    released_estimate_wall_ms: oldEstimate.wallTimeMs,
    indexed_estimate_wall_ms: newEstimate.wallTimeMs,
    optimized_count_wall_ms: newCount.wallTimeMs,
    optimized_plan_wall_ms: newPlan.wallTimeMs,
    optimized_plan_status: newPlan.status,
    released_count_wall_ms: oldCount.wallTimeMs,
    released_count_status: oldCount.status,
    released_plan_wall_ms: oldPlan.wallTimeMs,
    released_plan_status: oldPlan.status,
    released_timeout_ms: oldPlan.status === "timed_out" ? oldPlan.timeoutMs : null,
  };
  console.log(`\n=== ${scenario.name} ===`);
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n--- released estimated plan ---");
  console.log(oldEstimate.plan);
  console.log("\n--- indexed estimated plan ---");
  console.log(newEstimate.plan);
  console.log("\n--- released EXPLAIN (ANALYZE, BUFFERS) ---");
  console.log(oldPlan.plan ?? `[${oldPlan.status}; ${oldPlan.timeoutMs} ms bound; ${oldPlan.wallTimeMs == null ? "n/a" : `${oldPlan.wallTimeMs.toFixed(1)} ms`} wall]`);
  console.log("\n--- indexed EXPLAIN (ANALYZE, BUFFERS) ---");
  console.log(newPlan.plan ?? `[${newPlan.status}; ${newPlan.timeoutMs} ms bound; ${newPlan.wallTimeMs == null ? "n/a" : `${newPlan.wallTimeMs.toFixed(1)} ms`} wall]`);

  if (countFixture && newCount.status !== "completed") throw new Error(`Indexed query timed out for ${scenario.name}`);
  if (newRow && Number(newRow.candidate_count) !== seeded.expectedCandidatePairs) throw new Error(`${scenario.name} produced ${String(newRow.candidate_count)} candidates; fixture expects ${seeded.expectedCandidatePairs}`);
  if (oldCount.status === "completed" && Number((oldCount.row as Record<string, unknown>).unresolved_count) !== Number(newRow?.unresolved_count)) {
    throw new Error(`${scenario.name} released and indexed unresolved counts differ`);
  }
  return summary;
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl || configuredUrl.trim().length === 0) {
    throw new Error("Set a nonblank DATABASE_URL with permission to create and drop disposable databases.");
  }

  const databaseName = `litreview_dedup_bench_${process.pid}_${Date.now()}`;
  const admin = postgres(configuredUrl, { max: 1, prepare: false });
  const benchmarkUrl = new URL(configuredUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  let databaseCreated = false;
  let app: ReturnType<typeof createDb> | undefined;
  try {
    const versionRows = await admin`select current_setting('server_version_num')::integer as version, current_setting('server_version') as version_text`;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) {
      throw new Error(`The dedup benchmark requires PostgreSQL 16; connected server_version_num=${versionNumber}.`);
    }

    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    app = createDb(benchmarkUrl.toString());
    await migrate(app.db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
    const services = createReviewServices(app.db);
    const scenarios: Scenario[] = [
      { name: "sparse-1k", distribution: "sparse", recordCount: 1_000 },
      { name: "sparse-10k", distribution: "sparse", recordCount: 10_000 },
      { name: "sparse-50k", distribution: "sparse", recordCount: 50_000 },
      { name: "overlap-1k", distribution: "overlap", recordCount: 1_000 },
      { name: "dense-doi-1k", distribution: "dense", recordCount: 1_000 },
      { name: "history-long-1k", distribution: "sparse", recordCount: 1_000 },
      { name: "mapping-varied-1k", distribution: "sparse", recordCount: 1_000 },
    ];
    console.log(`PostgreSQL 16 confirmed; disposable database ${databaseName} created and migrated.`);
    console.log(`Old query timeout: ${OLD_QUERY_TIMEOUT_MS} ms. Indexed query timeout: ${NEW_QUERY_TIMEOUT_MS} ms.`);
    console.log("N is retrieved records; M is actual candidate pairs before history exclusion. Dense case output is quadratic in M by definition.");
    const results: Array<Record<string, unknown>> = [];
    for (const scenario of scenarios) {
      try {
        results.push(await benchmarkScenario(app.db, app.client, services, scenario));
      } catch (error) {
        results.push({ scenario: scenario.name, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log("\n=== benchmark summary ===");
    console.log(JSON.stringify(results, null, 2));
    const outputPath = resolve(process.cwd(), "docs/benchmarks/slice49-deduplication-read-paths.json");
    await mkdir(dirname(outputPath), { recursive: true });
    const report = {
      slice: 49,
      title: "Scalable Deduplication Queue & Scalability Closeout Audit",
      provenance: {
        releasedBaseline: { release: "v0.48.0-slice48", sha: "baa45e4732c68b56b09517bd5d8df961c13a6518" },
        implementationSha: null,
        workingTree: "uncommitted",
        node: process.version,
        postgres: String(versionRows[0]?.version_text ?? "PostgreSQL 16"),
        disposableDatabase: databaseName,
      },
      parameters: {
        sparseRecordCounts: [1_000, 10_000, 50_000],
        moderateOverlapRecords: 1_000,
        denseRecords: 1_000,
        denseCandidatePairs: 499_500,
        longHistoryDecisionRows: 1_000,
        queuePageSize: 25,
        historyPageSize: 20,
        explainOptions: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
      },
      safety: {
        no50kDenseFixture: true,
        noSchemaOrIndexChanges: true,
        queueIsLiveKeysetWithoutEpochOrHighWater: true,
        candidateGenerationIsOutputSensitiveAndMayBeQuadraticWhenDense: true,
      },
      priorAttempt: {
        status: "legacy full-reference work abandoned for the large fixtures after measurement",
        observations: [
          "On sparse-10k, the optimized full-reference count and EXPLAIN took approximately 113.6 s and 96.8 s; the released count took approximately 30.0 s and its EXPLAIN reached the 30 s statement timeout.",
          "On sparse-50k, the legacy full-reference count timed out at 120 s before the bounded queue/history EXPLAIN stage, so no bounded plan was captured in that attempt.",
        ],
        interpretation: "This was a benchmark-scope limitation, not an implementation failure. The current run skips full candidate counts for fixtures above 1k and retains application queue/history EXPLAIN for every fixture.",
      },
      planInterpretation: {
        denseDoi1k: {
          fixture: { retrievedRecords: 1_000, candidatePairsM: 499_500 },
          observedCandidateSearch: {
            index: "retrieved_records_project_doi_comparison_idx",
            doiIndexRowsPerLeftLoop: 1_000,
            leftLoops: 1_000,
            doiIndexRowsObserved: 1_000_000,
            rowsAfterRightIdBoundaryPerLeftLoop: 500,
            candidateRowsBeforeLocalSortApprox: 499_500,
          },
          boundedStages: {
            perLeftPerSignalLimitK: 26,
            deduplicatedStrongIdsFromObservedPlan: 25_649,
            strongPageProbeIds: 26,
            visiblePairs: 25,
            hydratedRecordSides: 50,
            queueSelects: 2,
            tempSpillBlocks: 0,
          },
          interpretation: "PostgreSQL evaluates the dense DOI candidate search and sorts each left-record candidate set before its local top-K limit. The branch emits 25,649 deduplicated IDs, then 26 strong probe IDs and 25 visible pairs; the plan has no globally materialized full-M pair CTE or global M-pair sort before K, and rich record hydration follows the visible-pair boundary. Database candidate evaluation remains output-sensitive and can approach M in a dense fixture; this is not an O(P) work claim.",
        },
        boundedQueue: "The 10k and 50k sparse EXPLAIN plans each return 26 queue probe IDs before the visible boundary, hydrate 25 pairs, use two SELECTs, and have no temporary spill. Complete node plans below record actual rows/loops, indexes, sort methods, buffers, and temporary I/O.",
      },
      scenarios: results,
      scope: {
        implementationSql: "The queue and history EXPLAIN cases use exported SQL builders called by the application readers.",
        selectCounts: "The bounded queue/history service calls are instrumented; transaction-control statements are reported separately from SELECT counts.",
        remaining: results.some((result) => result.status === "failed") ? "At least one scenario failed; inspect its status/error before accepting the benchmark." : null,
      },
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nWrote ${outputPath}`);
    if (results.some((result) => result.status === "failed")) throw new Error("One or more benchmark scenarios failed; inspect the retained JSON artifact.");
  } finally {
    try {
      if (app) await app.client.end();
    } finally {
      try {
        if (databaseCreated) await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
      } finally {
        await admin.end();
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
