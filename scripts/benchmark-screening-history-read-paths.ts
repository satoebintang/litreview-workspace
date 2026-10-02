import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createScreeningHistoryReadServices } from "@/application/screening-history-read-services";
import { encodeScreeningHistoryCursor } from "@/application/screening-history-cursor";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";

const EVENT_COUNTS = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 60_000;
const LONG_TEXT = "repeat(md5(item::text), 16)";
const LONG_TOAST_TEXT = "(select string_agg(md5(item::text || ':' || part::text), '') from generate_series(1,$6::integer) as part)";
const LONG_TOAST_RETRIEVAL_TEXT = "(select string_agg(md5(item::text || ':' || part::text), '') from generate_series(1,$5::integer) as part)";
const LONG_TOAST_PARTS = 4_096;
const LONG_TOAST_CHARACTERS = 32 * LONG_TOAST_PARTS;

type CapturedQuery = { query: string; params: unknown[] };
type Stream = "title-abstract-decision" | "full-text-decision" | "full-text-retrieval-attempt";
type QueryMeasurement<T> = {
  value: T;
  queries: CapturedQuery[];
  metrics: { selectCount: number; databaseRowsReturned: number; serializedPayloadBytes: number; diagnosticWallTimeMs: number };
};

let observedDatabaseRowsReturned = 0;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function selectQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function measure<T>(queries: CapturedQuery[], operation: () => Promise<T>): Promise<QueryMeasurement<T>> {
  queries.length = 0;
  observedDatabaseRowsReturned = 0;
  const started = process.hrtime.bigint();
  const value = await operation();
  const readSql = selectQueries(queries);
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

function planSummary(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const top = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
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
  visit(top?.Plan);
  return { planningTimeMs: top?.["Planning Time"], executionTimeMs: top?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, label: string, captured: CapturedQuery | undefined) {
  assert(captured, "Benchmark could not capture final SQL for EXPLAIN: " + label);
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + captured.query,
      captured.params as never,
    ) as unknown as Array<{ "QUERY PLAN"?: unknown }>;
    return {
      label,
      status: "completed" as const,
      sql: captured.query,
      parameters: captured.params,
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      plan: planSummary(rows[0]?.["QUERY PLAN"]),
    };
  } catch (error) {
    const details = safeError(error);
    return {
      label,
      status: details.code === "57014" ? "timed_out" as const : "failed" as const,
      sql: captured.query,
      parameters: captured.params,
      diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      error: details,
      plan: null,
    };
  }
}

async function eventAnchor(client: postgres.Sql, stream: Stream, projectId: string, paperId: string, offset: number) {
  const table = stream === "title-abstract-decision"
    ? "screening_decisions"
    : stream === "full-text-decision"
      ? "full_text_screening_decisions"
      : "full_text_retrieval_attempts";
  const stagePredicate = stream === "title-abstract-decision" ? "and stage='title_abstract'" : "";
  const rows = await client.unsafe(
    `select sequence::text as sequence, id::text as id from ${table} where project_id=$1::uuid and paper_id=$2::uuid ${stagePredicate} order by ${table}.sequence asc, ${table}.id asc limit 1 offset $3::integer`,
    [projectId, paperId, offset],
  ) as unknown as Array<{ sequence: string; id: string }>;
  const anchor = rows[0];
  assert(anchor, `Could not resolve ${stream} cursor anchor at offset ${offset}.`);
  return encodeScreeningHistoryCursor({
    v: 1,
    projectId,
    paperId,
    historyType: stream,
    pageSize: PAGE_SIZE,
    lastSequence: anchor.sequence,
    lastEventId: anchor.id,
  });
}

async function exactEventId(client: postgres.Sql, stream: Stream, projectId: string, paperId: string, offset: number) {
  const table = stream === "title-abstract-decision"
    ? "screening_decisions"
    : stream === "full-text-decision"
      ? "full_text_screening_decisions"
      : "full_text_retrieval_attempts";
  const stagePredicate = stream === "title-abstract-decision" ? "and stage='title_abstract'" : "";
  const rows = await client.unsafe(
    `select id::text as id from ${table} where project_id=$1::uuid and paper_id=$2::uuid ${stagePredicate} order by sequence asc, id asc limit 1 offset $3::integer`,
    [projectId, paperId, offset],
  ) as unknown as Array<{ id: string }>;
  assert(rows[0]?.id, `Could not resolve ${stream} exact event.`);
  return rows[0].id;
}

async function createBenchmarkPaper(services: ReturnType<typeof createReviewServices>, projectId: string, label: string) {
  return services.addPaper(projectId, {
    title: `Slice 51 history ${label}`,
    authors: ["Benchmark Researcher"],
    abstract: "Exact Paper abstract is preserved in normal detail payloads.",
    doi: `10.5555/slice51-${randomUUID()}`,
  });
}

async function seedHistory(
  client: postgres.Sql,
  services: ReturnType<typeof createReviewServices>,
  projectId: string,
  paperId: string,
  count: number,
) {
  const titleCriterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Benchmark title/abstract exclusion criterion with current identity." });
  const fullTextCriterion = await services.createFullTextScreeningCriterion(projectId, { text: "Benchmark full-text exclusion criterion with current identity." });
  const titleCount = count - 1;
  await client.unsafe(
    [
      "insert into screening_decisions (project_id,paper_id,stage,decision,exclusion_criterion_id,exclusion_criterion_type,note)",
      "select $1::uuid,$2::uuid,'title_abstract',case when mod(item,5)=0 then 'exclude' else 'maybe' end,",
      "  case when mod(item,5)=0 then $3::uuid else null end,",
      "  case when mod(item,5)=0 then 'exclusion' else null end,",
      `  case when item=$5::integer then ${LONG_TOAST_TEXT} else ${LONG_TEXT} end from generate_series(1,$4::integer) as item`,
    ].join("\n"),
    [projectId, paperId, titleCriterion.id, titleCount, Math.floor(count / 2) + 1, LONG_TOAST_PARTS],
  );
  await services.recordScreeningDecision(projectId, paperId, { decision: "include", note: "Current title/abstract state is compact." + "x".repeat(1_000) });

  const retrievalCount = count - 1;
  await client.unsafe(
    [
      "insert into full_text_retrieval_attempts (project_id,paper_id,outcome,method,source_reference,note,attempted_at)",
      `select $1::uuid,$2::uuid,'unavailable','publisher',case when item=$4::integer then ${LONG_TOAST_RETRIEVAL_TEXT} else ${LONG_TEXT} end,case when item=$4::integer then ${LONG_TOAST_RETRIEVAL_TEXT} else ${LONG_TEXT} end,timestamptz '2026-01-01 00:00:00+00' + item * interval '1 second'`,
      "from generate_series(1,$3::integer) as item",
    ].join("\n"),
    [projectId, paperId, retrievalCount, Math.floor(count / 2) + 1, LONG_TOAST_PARTS],
  );
  await services.recordFullTextRetrievalAttempt(projectId, paperId, {
    outcome: "retrieved",
    method: "publisher",
    sourceReference: "Current retrieved source" + "s".repeat(1_000),
    note: "Current retrieval note" + "n".repeat(1_000),
    attemptedAt: new Date("1999-01-01T00:00:00.000Z"),
  });

  await client.unsafe(
    [
      "insert into full_text_screening_decisions (project_id,paper_id,decision,exclusion_criterion_id,note)",
      "select $1::uuid,$2::uuid,case when mod(item,5)=0 then 'exclude' else 'maybe' end,",
      "  case when mod(item,5)=0 then $3::uuid else null end,",
      `  case when item=$5::integer then ${LONG_TOAST_TEXT} else ${LONG_TEXT} end from generate_series(1,$4::integer) as item`,
    ].join("\n"),
    [projectId, paperId, fullTextCriterion.id, count - 1, Math.floor(count / 2) + 1, LONG_TOAST_PARTS],
  );
  await services.recordFullTextScreeningDecision(projectId, paperId, { decision: "include", note: "Current full-text state is compact." + "f".repeat(1_000) });
}

async function seedEverRetrievedCase(
  client: postgres.Sql,
  services: ReturnType<typeof createReviewServices>,
  projectId: string,
  caseName: "no_success" | "early_success" | "late_success",
  count: number,
) {
  const paper = await createBenchmarkPaper(services, projectId, caseName);
  await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
  const retrievedOrdinal = caseName === "no_success" ? 0 : caseName === "early_success" ? 1 : count;
  await client.unsafe(
    [
      "insert into full_text_retrieval_attempts (project_id,paper_id,outcome,attempted_at)",
      "select $1::uuid,$2::uuid,case when item=$3::integer then 'retrieved' else 'unavailable' end,",
      "  timestamptz '2026-01-01 00:00:00+00' + item * interval '1 second'",
      "from generate_series(1,$4::integer) as item",
    ].join("\n"),
    [projectId, paper.id, retrievedOrdinal, count],
  );
  return paper.id;
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop a uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_screening_history_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let droppedOwnDatabase = false;
  let cleanupVerified = false;
  let postgresVersion = "unknown";
  let client: postgres.Sql | undefined;
  let evidence: Record<string, unknown> | undefined;
  const scenarios: Array<Record<string, unknown>> = [];
  const plans: Array<Record<string, unknown>> = [];
  const queries: CapturedQuery[] = [];
  let failure: unknown;

  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version_number,current_setting('server_version') as version") as unknown as Array<{ version_number: string; version: string }>;
    const versionNumber = Number(versionRows[0]?.version_number);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; connected server is ${versionRows[0]?.version}.`);
    postgresVersion = versionRows[0]?.version ?? "PostgreSQL 16";
    await admin.unsafe("create database " + quoteIdentifier(databaseName));
    created = true;
    await admin.unsafe("alter database " + quoteIdentifier(databaseName) + " set statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");

    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    client = postgres(benchmarkUrl.toString(), {
      max: 8,
      prepare: false,
      onnotice: () => {},
      transform: { row: { from(row) { observedDatabaseRowsReturned += 1; return row; } } },
    });
    const db = drizzle(client, { schema, logger: { logQuery(query, params) { queries.push({ query, params: [...params] }); } } }) as Database;
    const services = createReviewServices(db);
    const reads = createScreeningHistoryReadServices(db);
    let largestFixture: { projectId: string; paperId: string } | undefined;

    for (const count of EVENT_COUNTS) {
      const project = await services.createProject({ title: `Slice 51 history benchmark ${count} ${randomUUID()}` });
      const paper = await createBenchmarkPaper(services, project.id, String(count));
      await seedHistory(client, services, project.id, paper.id, count);
      await client.unsafe("analyze screening_decisions");
      await client.unsafe("analyze full_text_screening_decisions");
      await client.unsafe("analyze full_text_retrieval_attempts");
      if (count === 50_000) largestFixture = { projectId: project.id, paperId: paper.id };

      const streamResults: Record<string, unknown> = {};
      for (const stream of ["title-abstract-decision", "full-text-decision", "full-text-retrieval-attempt"] as const) {
        const table = stream === "title-abstract-decision"
          ? "screening_decisions"
          : stream === "full-text-decision"
            ? "full_text_screening_decisions"
            : "full_text_retrieval_attempts";
        const stagePredicate = stream === "title-abstract-decision" ? "and stage='title_abstract'" : "";
        const actualRows = await client.unsafe(
          `select count(*)::integer as count from ${table} where project_id=$1::uuid and paper_id=$2::uuid ${stagePredicate}`,
          [project.id, paper.id],
        ) as unknown as Array<{ count: number }>;
        assert(actualRows[0]?.count === count, `${stream} fixture row count mismatch: expected=${count}, actual=${actualRows[0]?.count}.`);
        const first = await measure(queries, () => stream === "title-abstract-decision"
          ? reads.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE })
          : stream === "full-text-decision"
            ? reads.getFullTextScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE })
            : reads.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE }));
        const deepCursor = await eventAnchor(client, stream, project.id, paper.id, Math.floor(count / 2) - PAGE_SIZE);
        const deep = await measure(queries, () => stream === "title-abstract-decision"
          ? reads.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE, cursor: deepCursor })
          : stream === "full-text-decision"
            ? reads.getFullTextScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE, cursor: deepCursor })
            : reads.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE, cursor: deepCursor }));
        const finalCursor = await eventAnchor(client, stream, project.id, paper.id, count - PAGE_SIZE - 1);
        const finalBoundary = JSON.parse(Buffer.from(finalCursor, "base64url").toString("utf8")) as { lastSequence: string; lastEventId: string };
        const remainingRows = await client.unsafe(
          `select count(*)::integer as count from ${table} where project_id=$1::uuid and paper_id=$2::uuid ${stagePredicate} and (sequence > $3::bigint or (sequence=$3::bigint and id > $4::uuid))`,
          [project.id, paper.id, finalBoundary.lastSequence, finalBoundary.lastEventId],
        ) as unknown as Array<{ count: number }>;
        const anchorStats = await client.unsafe(
          `select (select count(*)::integer from ${table} prior where prior.project_id=$1::uuid and prior.paper_id=$2::uuid ${stream === "title-abstract-decision" ? "and prior.stage='title_abstract'" : ""} and (prior.sequence < anchor.sequence or (prior.sequence=anchor.sequence and prior.id<=anchor.id))) as ordinal from ${table} anchor where anchor.project_id=$1::uuid and anchor.paper_id=$2::uuid ${stream === "title-abstract-decision" ? "and anchor.stage='title_abstract'" : ""} and anchor.id=$3::uuid`,
          [project.id, paper.id, finalBoundary.lastEventId],
        ) as unknown as Array<{ ordinal: number }>;
        const final = await measure(queries, () => stream === "title-abstract-decision"
          ? reads.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE, cursor: finalCursor })
          : stream === "full-text-decision"
            ? reads.getFullTextScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE, cursor: finalCursor })
            : reads.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: PAGE_SIZE, cursor: finalCursor }));
        const exactId = await exactEventId(client, stream, project.id, paper.id, Math.floor(count / 2));
        const exact = await measure(queries, () => stream === "title-abstract-decision"
          ? reads.getScreeningDecisionEvent(project.id, paper.id, exactId)
          : stream === "full-text-decision"
            ? reads.getFullTextScreeningDecisionEvent(project.id, paper.id, exactId)
            : reads.getFullTextRetrievalAttemptEvent(project.id, paper.id, exactId));
        const deepItems = deep.value.page.items as unknown as Array<Record<string, unknown>>;
        const longPreview = deepItems.find((item) => item.id === exactId);
        assert(longPreview && longPreview.noteTruncated === true, `${stream} deep page did not encounter the exact event's long note preview at ${count}.`);
        const expectedNotePreviewLength = stream === "full-text-retrieval-attempt" ? 384 : 600;
        assert(typeof longPreview.note === "string" && longPreview.note.length === expectedNotePreviewLength, `${stream} long note preview length changed at ${count}.`);
        const exactEvent = exact.value.event as unknown as Record<string, unknown>;
        assert(typeof exactEvent.note === "string" && exactEvent.note.length === LONG_TOAST_CHARACTERS, `${stream} exact event did not restore its complete long note at ${count}.`);
        if (stream === "full-text-retrieval-attempt") {
          assert(longPreview.sourceReferenceTruncated === true, `Retrieval sourceReference preview was not marked truncated at ${count}.`);
          assert(typeof longPreview.sourceReference === "string" && longPreview.sourceReference.length === 384, `Retrieval sourceReference preview length changed at ${count}.`);
          assert(typeof exactEvent.sourceReference === "string" && exactEvent.sourceReference.length === LONG_TOAST_CHARACTERS, `Retrieval exact event did not restore complete long sourceReference at ${count}.`);
        }
        assert(first.value.page.items.length === PAGE_SIZE && first.value.page.hasMore, `${stream} first-page shape failed at ${count}.`);
        assert(deep.value.page.items.length === PAGE_SIZE && deep.value.page.hasMore, `${stream} deep-page shape failed at ${count}.`);
        assert(final.value.page.items.length === PAGE_SIZE && !final.value.page.hasMore, `${stream} final-page shape failed at ${count}: rows=${final.value.page.items.length}, hasMore=${final.value.page.hasMore}, expectedRemaining=${remainingRows[0]?.count}, anchorOrdinal=${anchorStats[0]?.ordinal}, boundaryOffset=${count - PAGE_SIZE - 1}, anchorSequence=${finalBoundary.lastSequence}.`);
        streamResults[stream] = {
          firstPage: { ...first.metrics, hasMore: first.value.page.hasMore, pageSize: first.value.page.pageSize, sqlAndParameters: first.queries },
          deepPage: { ...deep.metrics, hasMore: deep.value.page.hasMore, pageSize: deep.value.page.pageSize, sqlAndParameters: deep.queries },
          finalPage: { ...final.metrics, hasMore: final.value.page.hasMore, pageSize: final.value.page.pageSize, sqlAndParameters: final.queries },
          exactEvent: { ...exact.metrics, eventId: exactId, sqlAndParameters: exact.queries },
        };
        if (count === 50_000) {
          plans.push(await explain(client, `${count} ${stream} first page`, first.queries.at(-1)));
          plans.push(await explain(client, `${count} ${stream} deep page`, deep.queries.at(-1)));
          plans.push(await explain(client, `${count} ${stream} final page`, final.queries.at(-1)));
          plans.push(await explain(client, `${count} ${stream} exact event`, exact.queries.at(-1)));
        }
      }

      const titleDetail = await measure(queries, () => reads.getTitleAbstractScreeningDetail(project.id, paper.id));
      const fullTextDetail = await measure(queries, () => reads.getFullTextScreeningDetail(project.id, paper.id));
      const retrievalDetail = await measure(queries, () => reads.getFullTextRetrievalDetail(project.id, paper.id));
      assert(titleDetail.metrics.selectCount === 4, `Title/abstract detail used ${titleDetail.metrics.selectCount} SELECTs at ${count}.`);
      assert(fullTextDetail.metrics.selectCount === 4, `Full-text detail used ${fullTextDetail.metrics.selectCount} SELECTs at ${count}.`);
      assert(retrievalDetail.metrics.selectCount === 2, `Retrieval detail used ${retrievalDetail.metrics.selectCount} SELECTs at ${count}.`);
      const detailPayloadBytes = byteSize({
        decisionHistory: fullTextDetail.value.history,
        retrievalHistory: fullTextDetail.value.retrievalHistory,
      });
      assert(detailPayloadBytes <= 256 * 1024, `Two-stream full-text first-page payload exceeds 256 KiB at ${count}.`);

      const legacy: Record<string, unknown> = {};
      for (const [key, operation] of [
        ["titleAbstract", () => services.getPaperScreening(project.id, paper.id)],
        ["fullText", () => services.getPaperFullTextScreening(project.id, paper.id)],
        ["retrieval", () => services.getPaperFullTextRetrieval(project.id, paper.id)],
      ] as const) {
        const result = await measure(queries, operation);
        legacy[key] = { ...result.metrics, sqlAndParameters: result.queries };
      }
      scenarios.push({
        eventsPerPaperPerStream: count,
        titleAbstract: streamResults["title-abstract-decision"],
        fullTextDecision: streamResults["full-text-decision"],
        retrievalAttempt: streamResults["full-text-retrieval-attempt"],
        normalDetail: {
          titleAbstract: { ...titleDetail.metrics, firstHistoryRows: titleDetail.value.history.items.length, sqlAndParameters: titleDetail.queries },
          fullText: { ...fullTextDetail.metrics, twoStreamHistoryPayloadBytes: detailPayloadBytes, sqlAndParameters: fullTextDetail.queries },
          retrieval: { ...retrievalDetail.metrics, firstHistoryRows: retrievalDetail.value.history.items.length, sqlAndParameters: retrievalDetail.queries },
        },
        legacyCompleteHistoryComparison: legacy,
      });
      console.log(JSON.stringify({ eventCountPerStream: count, phase: "read paths measured" }));
    }

    // Distinguish the indexed current-state probe from the historical ever-retrieved probe.
    const everProject = await services.createProject({ title: `Slice 51 everRetrieved benchmark ${randomUUID()}` });
    const everCases: Record<string, string> = {};
    for (const caseName of ["no_success", "early_success", "late_success"] as const) {
      everCases[caseName] = await seedEverRetrievedCase(client, services, everProject.id, caseName, 50_000);
      await client.unsafe("analyze full_text_retrieval_attempts");
    }
    for (const [caseName, paperId] of Object.entries(everCases)) {
      const detail = await measure(queries, () => createScreeningHistoryReadServices(db).getFullTextRetrievalDetail(everProject.id, paperId));
      plans.push(await explain(client, `everRetrieved ${caseName} with 50000 attempts`, detail.queries[0]));
      scenarios.push({ everRetrievedCase: caseName, retrievalAttemptCount: 50_000, result: { currentState: detail.value.currentState, everRetrieved: detail.value.everRetrieved }, measurement: { ...detail.metrics, sqlAndParameters: detail.queries } });
    }

    // Detail EXPLAINs include compact current probes plus bounded stream reads; no current note or sourceReference is selected.
    assert(largestFixture, "Missing 50000-event fixture.");
    const { projectId: detailProjectId, paperId: detailPaperId } = largestFixture;
    const titleDetailExplain = await measure(queries, () => reads.getTitleAbstractScreeningDetail(detailProjectId, detailPaperId));
    const fullDetailExplain = await measure(queries, () => reads.getFullTextScreeningDetail(detailProjectId, detailPaperId));
    const retrievalDetailExplain = await measure(queries, () => reads.getFullTextRetrievalDetail(detailProjectId, detailPaperId));
    plans.push(await explain(client, "50000 title-abstract normal detail current probe", titleDetailExplain.queries[0]));
    plans.push(await explain(client, "50000 full-text two-stream detail current probes", fullDetailExplain.queries[0]));
    plans.push(await explain(client, "50000 retrieval detail current and everRetrieved probes", retrievalDetailExplain.queries[0]));
    plans.push(await explain(client, "50000 full-text detail limited decision-page criteria join", fullDetailExplain.queries[2]));
    plans.push(await explain(client, "50000 full-text detail limited retrieval-page preview", fullDetailExplain.queries[3]));

    const catalogRows = await client.unsafe(
      "select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('screening_decisions','full_text_screening_decisions','full_text_retrieval_attempts') order by tablename,indexname",
    ) as unknown as Array<{ tablename: string; indexname: string; indexdef: string }>;
    const indexSummary = catalogRows.map(({ tablename, indexname, indexdef }) => ({ tablename, indexname, indexdef }));
    const essentialIndexes = {
      titleAbstractSequence: catalogRows.some(({ indexname }) => indexname === "screening_decisions_project_paper_sequence_idx"),
      fullTextSequence: catalogRows.some(({ indexname }) => indexname === "full_text_screening_decisions_project_paper_sequence_idx"),
      retrievalSequence: catalogRows.some(({ indexname }) => indexname === "full_text_retrieval_attempts_project_paper_sequence_idx"),
    };
    assert(Object.values(essentialIndexes).every(Boolean), "An existing history sequence index is absent in the disposable database.");
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sourceStatus = execFileSync("git", ["status", "--short"], { encoding: "utf8" })
      .trim().split(/\r?\n/).filter(Boolean);

    evidence = {
      schemaVersion: 1,
      benchmark: "Slice 51 scalable screening and full-text workflow histories",
      startedAt: new Date().toISOString(),
      sourceProvenance: {
        headCommit: sourceHead,
        workingTree: sourceStatus.length === 0 ? "clean" : "uncommitted changes present",
        changedPaths: sourceStatus,
        benchmarkScript: "scripts/benchmark-screening-history-read-paths.ts",
        readService: "src/application/screening-history-read-services.ts",
        finalSqlSource: "src/application/screening-history-read-queries.ts",
      },
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      postgres: { serverVersion: postgresVersion, majorVersion: 16 },
      fixture: {
        eventCountsPerPaperPerStream: EVENT_COUNTS,
        maxHistoryPageSize: PAGE_SIZE,
        longTextSeedCharactersPerField: 512,
        oneMidstreamEventCharactersPerLongField: LONG_TOAST_CHARACTERS,
        everRetrievedProbeCases: everCases,
        sequenceIndexes: essentialIndexes,
        sequenceIndexDefinitions: indexSummary,
      },
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      measurementNotes: [
        "All service reads use the final application SQL against a uniquely named disposable PostgreSQL 16 database.",
        "Each history page reports first, deep, and final page reads, selected-row counts, serialized DTO bytes, and diagnostic wall time.",
        "Page key selection applies LIMIT pageSize+1 before criterion joins and preview projection.",
        "One midstream event per stream has 128 KiB incompressible text fields; its preview is read on a deep page and its exact event restores the full text.",
        "Full-text normal detail embeds two independent first pages and is measured as one service call; its combined history envelopes are asserted below 256 KiB.",
        "Legacy full-return service calls are compared at each fixture size. Their unbounded result sizes are measured as-is.",
        "EXPLAIN plans are diagnostic observations, not proof that all database work is O(pageSize); sequence uniqueness is not assumed.",
        "JSON EXPLAIN plans include actual rows, loops, index use, sort nodes, buffer activity, and execution time where available.",
        "Page payload measurements preserve all returned rows; tests reject oversized DTOs rather than dropping history items.",
      ],
      scenarios,
      explainAnalyzeBuffersFormatJson: plans,
      migrationVerdict: {
        migration0038: "not created",
        decision: "Existing (project_id, paper_id, sequence) indexes are reused for all three history streams; deep ranges scan about one page and the sequence/ID incremental sort remains limited to pageSize+1 rows. The acknowledged everRetrieved probe scans the scoped attempt history for no-success and late-success cases. No migration was approved or added.",
      },
      cleanup: { disposableDatabaseName: databaseName, droppedInFinally: false, verifiedAbsent: false },
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (client) await client.end({ timeout: 1 });
    } finally {
      try {
        if (created) {
          await admin.unsafe("drop database if exists " + quoteIdentifier(databaseName) + " with (force)");
          droppedOwnDatabase = true;
          const remains = await admin.unsafe("select exists(select 1 from pg_database where datname=$1) as present", [databaseName]) as unknown as Array<{ present: boolean }>;
          cleanupVerified = !remains[0]?.present;
        }
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }

  if (failure) {
    const details = safeError(failure);
    console.error(JSON.stringify({ error: details, droppedOwnDatabase, cleanupVerified }));
    throw failure;
  }
  assert(evidence, "Benchmark did not produce a result record.");
  assert(droppedOwnDatabase && cleanupVerified, "Disposable benchmark database cleanup was not verified.");
  evidence.cleanup = { disposableDatabaseName: databaseName, droppedInFinally: droppedOwnDatabase, verifiedAbsent: cleanupVerified };
  await mkdir(resolve(process.cwd(), "docs", "benchmarks"), { recursive: true });
  await writeFile(resolve(process.cwd(), "docs", "benchmarks", "slice51-screening-history-read-paths.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ benchmark: evidence.benchmark, nodeVersion: process.version, postgresVersion, scenarioCount: scenarios.length, planCount: plans.length, droppedOwnDatabase, cleanupVerified, artifact: "docs/benchmarks/slice51-screening-history-read-paths.json" }));
}

main().catch((error: unknown) => {
  const details = safeError(error);
  console.error(JSON.stringify({ error: details }));
  process.exitCode = 1;
});
