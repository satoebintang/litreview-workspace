import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createClaimSynthesisHistoryReadServices } from "@/application/claim-synthesis-history-read-services";
import { encodeClaimSynthesisHistoryCursor } from "@/application/claim-synthesis-history-cursor";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";
import type { Database } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createClaimReadServices } from "@/application/claim-read-services";
import { createClaimSupportReadServices } from "@/application/claim-support-read-services";
import { createSynthesisReadServices } from "@/application/synthesis-read-services";
import { createSynthesisInterpretationExactReadServices } from "@/application/synthesis-interpretation-exact-read-services";
import { createClaimRevisionExactAuditReadServices } from "@/application/claim-revision-exact-audit-read-services";
import { createSynthesisInterpretationCurrentReadServices } from "@/application/synthesis-interpretation-current-read-services";
import { createSynthesisRevisionExactRouteReadServices } from "@/application/synthesis-revision-exact-route-read-services";

const POPULATIONS = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const TIE_COUNT = 1_000;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_TIMEOUT_MS = 600_000;
const PREINDEX_ARTIFACT = "docs/benchmarks/slice52-claim-synthesis-history-read-paths-pre-index.json";
const FINAL_ARTIFACT = "docs/benchmarks/slice52-claim-synthesis-history-read-paths.json";
const EXPECTED_PREINDEX_SHA256 = "f45f0eb906118bc4e613441f1feaf85396934026ca0a0b675656a026819b06c0";
const HISTORY_INDEX_NAMES_0038 = [
  "claim_revisions_project_claim_sequence_id_idx",
  "synthesis_revisions_project_statement_sequence_id_idx",
  "synthesis_interpretations_project_revision_sequence_id_idx",
] as const;
const INTERPRETATION_CHILD_TABLES = [
  "synthesis_interpretation_limitations",
  "synthesis_interpretation_questions",
  "synthesis_interpretation_contradictions",
] as const;
const STAGE_C_PAGE_QUERIES = [
  { stream: "claim", queryKind: "page-keys", table: "claim_revisions", sourceSymbol: "claimHistoryPageQuery", cursorOrder: "(sequence,id) DESC", cteMarker: "page_keys as materialized", requiredSqlMarkers: [] as const },
  { stream: "synthesis", queryKind: "page-and-support", table: "synthesis_revisions", sourceSymbol: "synthesisHistoryPageQuery", cursorOrder: "(sequence,id) ASC", cteMarker: "page_keys as materialized", requiredSqlMarkers: ["cross join lateral", "from synthesis_revision_supports s"] as const },
  { stream: "interpretation", queryKind: "page-keys", table: "synthesis_interpretations", sourceSymbol: "interpretationHistoryScopeAndPageKeysQuery", cursorOrder: "(sequence,id) DESC", cteMarker: "page_keys as materialized", requiredSqlMarkers: [] as const },
  { stream: "interpretation", queryKind: "child-hydration", table: "synthesis_interpretations", sourceSymbol: "interpretationHistoryHydrationQuery", cursorOrder: "(sequence,id) DESC", cteMarker: "visible_page as materialized", requiredSqlMarkers: [
    "from synthesis_interpretation_limitations l",
    "from synthesis_interpretation_questions q",
    "from synthesis_interpretation_contradictions c",
    "interpretation_id=any(",
  ] as const },
] as const;
type CapturedQuery = { sql: string; params: unknown[] };
type Measurement = {
  status: "completed" | "failed" | "timed_out";
  wallTimeMs: number;
  selectCount: number;
  driverRows: number;
  driverDecodedJsonBytes: number;
  dtoUtf8Bytes: number | null;
  queries: CapturedQuery[];
  valueSummary?: unknown;
  error?: string;
};
function quoteIdentifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function sha256(bytes: Uint8Array | string) { return createHash("sha256").update(bytes).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function loadHistoricalStageEvidence() {
  const preIndexPath = resolve(PREINDEX_ARTIFACT);
  const preIndexBytes = await readFile(preIndexPath);
  const preIndexSha256 = sha256(preIndexBytes);
  if (preIndexSha256 !== EXPECTED_PREINDEX_SHA256) {
    throw new Error(`The immutable stage-A artifact hash changed: ${preIndexSha256}.`);
  }

  const finalPath = resolve(FINAL_ARTIFACT);
  const previousBytes = await readFile(finalPath);
  const previous = JSON.parse(previousBytes.toString("utf8")) as Record<string, unknown>;
  const previousStages = isRecord(previous.stages) ? previous.stages : {};
  const previousStageB = isRecord(previousStages.stageB) ? previousStages.stageB : {};
  const previousPlans = Array.isArray(previous.plans) ? previous.plans.filter(isRecord) : [];
  const storedStageBPlans = Array.isArray(previousStageB.oldQueryShapeDeepPagePlans)
    ? previousStageB.oldQueryShapeDeepPagePlans.filter(isRecord)
    : [];
  const stageBDeepPlans = storedStageBPlans.length > 0 ? storedStageBPlans : previousPlans.filter((plan) =>
    typeof plan.label === "string" && /^(claim|synthesis|interpretation)-deep-50000-select-\d+$/i.test(plan.label) &&
    typeof plan.sql === "string" && /\bpage_candidates\s+as\s+materialized\b/i.test(plan.sql),
  );
  const previousComparison = previousStageB.pairedDeepPageIndexComparison ?? previous.pairedDeepPageIndexComparison;
  const stageBSourceArtifact = typeof previousStageB.sourceArtifact === "string" ? previousStageB.sourceArtifact : FINAL_ARTIFACT;
  const stageBSourceArtifactSha256 = typeof previousStageB.sourceArtifactSha256 === "string"
    ? previousStageB.sourceArtifactSha256
    : sha256(previousBytes);
  const stageBSourceDatabase = isRecord(previousStageB.sourceDatabase) ? previousStageB.sourceDatabase : previous.database;
  const stageBPairedObjectSha256 = typeof previousStageB.pairedObjectSha256 === "string"
    ? previousStageB.pairedObjectSha256
    : sha256(JSON.stringify(previousComparison));
  const comparisonPlans = isRecord(previousComparison) && Array.isArray(previousComparison.plans)
    ? previousComparison.plans.filter(isRecord)
    : [];
  if (stageBDeepPlans.length !== 3 || comparisonPlans.length !== 6 || comparisonPlans.some((plan) => plan.status !== "completed")) {
    throw new Error("Cannot preserve stage B: the prior old-query deep plans or six completed paired 0038 plans are incomplete.");
  }

  return {
    stageA: {
      stage: "A",
      description: "Original sequence-only index evidence before migration 0038",
      artifact: PREINDEX_ARTIFACT,
      sha256: preIndexSha256,
      fileIntegrityVerifiedBeforeRun: true,
    },
    stageB: {
      stage: "B",
      description: "Migration 0038 with the original page_candidates query shape; historical evidence preserved without replay",
      sourceArtifact: stageBSourceArtifact,
      sourceArtifactSha256: stageBSourceArtifactSha256,
      sourceDatabase: stageBSourceDatabase,
      oldQueryShapeDeepPagePlans: stageBDeepPlans,
      pairedDeepPageIndexComparison: previousComparison,
      pairedObjectSha256: stageBPairedObjectSha256,
      sortInputRowsInterpretation: "Stage B plan summaries are preserved verbatim from the prior artifact. Its sortInputRows field sums all listed child plan tuples, including EXPLAIN InitPlan/SubPlan nodes, and is not the actual input count for an individual Sort node.",
    },
  };
}

async function get0038IndexInventory(client: postgres.Sql) {
  return await client.unsafe(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[]) ORDER BY indexname",
    [[...HISTORY_INDEX_NAMES_0038]],
  ) as Array<{ indexname: string; indexdef: string }>;
}

function matchingHistoryPageQueries(measurement: Measurement, source: (typeof STAGE_C_PAGE_QUERIES)[number]) {
  const tablePattern = new RegExp(`\\bfrom\\s+${source.table}\\b`, "i");
  return measurement.queries.filter((query) =>
    /^(with|select)\b/i.test(query.sql.trim()) &&
    query.sql.toLocaleLowerCase().includes(source.cteMarker) && tablePattern.test(query.sql),
  ).filter((query) => source.requiredSqlMarkers.every((marker) => query.sql.toLocaleLowerCase().includes(marker)));
}

async function getInterpretationChildIndexInventory(client: postgres.Sql) {
  return await client.unsafe(
    "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=ANY($1::text[]) ORDER BY tablename, indexname",
    [[...INTERPRETATION_CHILD_TABLES]],
  ) as Array<{ tablename: string; indexname: string; indexdef: string }>;
}

function stableUuid(seed: string) {
  const hex = createHash("md5").update(seed).digest("hex");
  const bytes = hex.match(/../g)!.map((value) => Number.parseInt(value, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x0f) | 0xa0;
  const v = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}
function uuidSql(expression: string) {
  const d = `md5(${expression})`;
  return `(substring(${d} from 1 for 12) || '5' || substring(${d} from 14 for 3) || 'a' || substring(${d} from 18 for 15))::uuid`;
}
function safeError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause as { code?: unknown; message?: unknown } : undefined;
  const detail = cause ? ` [cause ${String(cause.code ?? "")}: ${String(cause.message ?? "").split("\n")[0]}]` : "";
  return `${message}${detail}`.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1_500);
}
function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value, (_key, current) => typeof current === "bigint" ? current.toString() : current));
}
function isTimeout(error: unknown) {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return value?.code === "57014" || value?.cause?.code === "57014" || /statement timeout|canceling statement/i.test(safeError(error));
}

const querySink: { queries: CapturedQuery[]; rows: number; decodedBytes: number } = { queries: [], rows: 0, decodedBytes: 0 };
let activeStage = "startup";
const countedSqlCache = new WeakMap<object, postgres.Sql>();
function countedResult(query: object): object {
  return new Proxy(query, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (property === "then" && typeof member === "function") {
        return (resolve: ((value: unknown) => unknown) | undefined, reject: ((reason: unknown) => unknown) | undefined) => Reflect.apply(member, target, [
          (result: unknown) => {
            const rows = Array.isArray(result) ? result : null;
            if (rows) {
              querySink.rows += rows.length;
              querySink.decodedBytes += jsonBytes(rows);
            }
            return resolve ? resolve(result) : result;
          },
          reject,
        ]);
      }
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const next = Reflect.apply(member, target, args) as unknown;
        return next && typeof next === "object" && typeof (next as { then?: unknown }).then === "function"
          ? countedResult(next)
          : next;
      };
    },
  });
}
function countedSql(client: postgres.Sql): postgres.Sql {
  const cached = countedSqlCache.get(client as object);
  if (cached) return cached;
  const proxy = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "unsafe" && typeof value === "function") {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args) as unknown;
          return result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function"
            ? countedResult(result)
            : result;
        };
      }
      if (property === "begin" && typeof value === "function") {
        return (...args: unknown[]) => {
          if (typeof args[0] !== "function") return Reflect.apply(value, target, args);
          const callback = args[0] as (tx: postgres.Sql) => unknown;
          return Reflect.apply(value, target, [(tx: postgres.Sql) => callback(countedSql(tx)), ...args.slice(1)]);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as postgres.Sql;
  countedSqlCache.set(client as object, proxy);
  return proxy;
}
function makeDatabase(client: postgres.Sql): Database {
  return drizzle(countedSql(client), {
    schema,
    logger: { logQuery(query, params) { querySink.queries.push({ sql: query, params: [...params] }); } },
  }) as Database;
}
async function measured<T>(label: string, run: () => Promise<T>): Promise<{ label: string; measurement: Measurement; value: T | null }> {
  querySink.queries.length = 0;
  querySink.rows = 0;
  querySink.decodedBytes = 0;
  const start = process.hrtime.bigint();
  try {
    const value = await run();
    const queries = [...querySink.queries];
    return { label, value, measurement: {
      status: "completed", wallTimeMs: Number(process.hrtime.bigint() - start) / 1e6,
      selectCount: queries.filter((q) => /^(with|select)\b/i.test(q.sql.trim())).length,
      driverRows: querySink.rows, driverDecodedJsonBytes: querySink.decodedBytes,
      dtoUtf8Bytes: jsonBytes(value), queries, valueSummary: summarizeValue(value),
    } };
  } catch (error) {
    const queries = [...querySink.queries];
    return { label, value: null, measurement: {
      status: isTimeout(error) ? "timed_out" : "failed", wallTimeMs: Number(process.hrtime.bigint() - start) / 1e6,
      selectCount: queries.filter((q) => /^(with|select)\b/i.test(q.sql.trim())).length,
      driverRows: querySink.rows, driverDecodedJsonBytes: querySink.decodedBytes, dtoUtf8Bytes: null,
      queries, error: safeError(error),
    } };
  }
}
function summarizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return { itemCount: value.length };
  if (!value || typeof value !== "object") return value == null ? null : { type: typeof value };
  const row = value as Record<string, unknown>;
  const items = Array.isArray(row.items) ? row.items : null;
  const revisions = Array.isArray(row.revisions) ? row.revisions : null;
  const limitations = Array.isArray(row.limitations) ? row.limitations : null;
  const questions = Array.isArray(row.questions) ? row.questions : null;
  const contradictions = Array.isArray(row.contradictions) ? row.contradictions : null;
  return {
    keys: Object.keys(row).slice(0, 30),
    itemCount: items?.length,
    revisionCount: revisions?.length,
    hasMore: row.hasMore,
    nextCursorPresent: typeof row.nextCursor === "string" && row.nextCursor.length > 0,
    limitationCount: limitations?.length,
    questionCount: questions?.length,
    contradictionCount: contradictions?.length,
    supportCount: typeof row.supportingRevisionCount === "number" ? row.supportingRevisionCount : undefined,
  };
}
function summarizePlan(rows: unknown) {
  const result = rows as Array<Record<string, unknown>>;
  const queryPlan = result[0]?.["QUERY PLAN"];
  const root = Array.isArray(queryPlan) ? queryPlan[0] as Record<string, unknown> : undefined;
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const current = node as Record<string, unknown>;
    const children = Array.isArray(current.Plans) ? current.Plans as Array<Record<string, unknown>> : [];
    // EXPLAIN nests InitPlan/SubPlan nodes alongside a node's tuple-producing
    // input. They are not rows fed into a Sort and must not inflate this count.
    const tupleInputChildren = children.filter((child) =>
      child["Parent Relationship"] !== "InitPlan" && child["Parent Relationship"] !== "SubPlan",
    );
    const actualRows = typeof current["Actual Rows"] === "number" ? current["Actual Rows"] : null;
    const loops = typeof current["Actual Loops"] === "number" ? current["Actual Loops"] : null;
    const rowsRemovedByFilter = typeof current["Rows Removed by Filter"] === "number" ? current["Rows Removed by Filter"] : null;
    const rowsRemovedByIndexRecheck = typeof current["Rows Removed by Index Recheck"] === "number" ? current["Rows Removed by Index Recheck"] : null;
    nodes.push({
      nodeType: current["Node Type"],
      relation: current["Relation Name"],
      index: current["Index Name"],
      planRows: current["Plan Rows"],
      actualRows,
      loops,
      actualTuples: actualRows !== null && loops !== null ? actualRows * loops : null,
      heapFetches: current["Heap Fetches"],
      heapTuplesVisited: actualRows !== null && loops !== null && (current["Node Type"] === "Index Scan" || current["Node Type"] === "Bitmap Heap Scan")
        ? (actualRows + (rowsRemovedByFilter ?? 0) + (rowsRemovedByIndexRecheck ?? 0)) * loops
        : null,
      rowsRemovedByFilter,
      rowsRemovedByIndexRecheck,
      filter: current.Filter,
      indexCondition: current["Index Cond"],
      sortMethod: current["Sort Method"],
      sortInputRows: current["Node Type"] === "Sort" || current["Node Type"] === "Incremental Sort"
        ? tupleInputChildren.reduce((sum, child) => sum + Number(child["Actual Rows"] ?? 0) * Number(child["Actual Loops"] ?? 0), 0)
        : null,
      sortSpaceUsed: current["Sort Space Used"],
      sortSpaceType: current["Sort Space Type"],
      sharedHitBlocks: current["Shared Hit Blocks"],
      sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"],
      tempWrittenBlocks: current["Temp Written Blocks"],
    });
    if (Array.isArray(current.Plans)) current.Plans.forEach(visit);
  };
  if (root?.Plan) visit(root.Plan);
  const rootPlan = root?.Plan && typeof root.Plan === "object" ? root.Plan as Record<string, unknown> : undefined;
  return {
    planningTimeMs: root?.["Planning Time"],
    executionTimeMs: root?.["Execution Time"],
    returnedRows: rootPlan?.["Actual Rows"],
    rootLoops: rootPlan?.["Actual Loops"],
    nodes,
  };
}
async function explainQuery(client: postgres.Sql, query: CapturedQuery | undefined, label: string) {
  if (!query) return { label, status: "skipped", reason: "No SELECT captured" };
  const start = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never);
    return { label, status: "completed", wallTimeMs: Number(process.hrtime.bigint() - start) / 1e6, sql: query.sql, params: query.params, plan: summarizePlan(rows) };
  } catch (error) {
    return { label, status: isTimeout(error) ? "timed_out" : "failed", wallTimeMs: Number(process.hrtime.bigint() - start) / 1e6, sql: query.sql, params: query.params, error: safeError(error) };
  }
}
async function explain(client: postgres.Sql, measurement: Measurement, label: string, match?: RegExp) {
  const selects = measurement.queries.filter((item) => /^(with|select)\b/i.test(item.sql.trim()));
  return explainQuery(client, selects.find((item) => !match || match.test(item.sql)) ?? (!match ? selects[0] : undefined), label);
}
async function seedEvent(client: postgres.Sql, stream: "claim" | "synthesis" | "interpretation", projectId: string, parentId: string, size: number, parentRevisionId?: string, fixture?: { evidenceId?: string; extractionRevisionId?: string; synthesisRevisionId?: string; maxInterpretationChildren?: boolean }) {
  const tieCount = size === 50_000 ? TIE_COUNT : 0;
  const ordinary = size - tieCount;
  const config = stream === "claim"
    ? { table: "claim_revisions", parent: "claim_id", kind: "claim-revision" }
    : stream === "synthesis"
      ? { table: "synthesis_revisions", parent: "synthesis_statement_id", kind: "synthesis-revision" }
      : { table: "synthesis_interpretations", parent: "synthesis_revision_id", kind: "synthesis-interpretation" };
  await client.begin(async (tx) => {
    if (ordinary > 0) {
      const sqlText = stream === "claim"
        ? `INSERT INTO claim_revisions (id, project_id, claim_id, state, claim_text, researcher_note) SELECT ${uuidSql(`$2::text || ':${config.kind}:' || g::text`)}, $1::uuid, $2::uuid, 'active', 'Benchmark claim ' || g, 'Benchmark note' FROM generate_series(1, $3::int) g`
        : stream === "synthesis"
          ? `INSERT INTO synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text, researcher_note) SELECT ${uuidSql(`$2::text || ':${config.kind}:' || g::text`)}, $1::uuid, $2::uuid, 'active', 'Benchmark title ' || g, CASE WHEN g=$3::int AND $4::boolean THEN repeat('Large exact synthesis artifact. ', 300) ELSE 'Benchmark synthesis statement ' || g END, 'Benchmark note' FROM generate_series(1, $3::int) g`
          : `INSERT INTO synthesis_interpretations (id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary, researcher_note) SELECT ${uuidSql(`$2::text || ':${config.kind}:' || g::text`)}, $1::uuid, $4::uuid, $2::uuid, 'inconclusive', 'Benchmark interpretation ' || g, 'Benchmark note' FROM generate_series(1, $3::int) g`;
      await tx.unsafe(sqlText, stream === "interpretation" ? [projectId, parentId, ordinary, parentRevisionId] : stream === "synthesis" ? [projectId, parentId, ordinary, size === 50_000] : [projectId, parentId, ordinary]);
    }
    if (stream === "synthesis" && fixture?.extractionRevisionId) {
      const currentSupportCount = size === 50_000 ? 1_000 : size === 10_000 ? 40 : 1;
      await tx.unsafe(
        `INSERT INTO synthesis_revision_supports (project_id,synthesis_revision_id,extraction_revision_id)
         SELECT $1::uuid, ${uuidSql(`$2::text || ':${config.kind}:' || g::text`)}, ${uuidSql(`$3::text || ':extraction-revision:' || support_n::text`)}
         FROM generate_series(1,$4::int) g
         CROSS JOIN LATERAL generate_series(1, CASE
           WHEN g=$4::int THEN $5::int
           WHEN g=1 THEN 1 WHEN g=2 THEN 10 WHEN g=3 THEN 50 ELSE 0 END) support_n`,
        [projectId, parentId, projectId, ordinary, currentSupportCount],
      );
    }
    if (stream === "claim" && fixture?.evidenceId && fixture.extractionRevisionId && fixture.synthesisRevisionId) {
      const currentId = stableUuid(`${parentId}:${config.kind}:${ordinary}`);
      await tx.unsafe("INSERT INTO claim_revision_evidence_supports(project_id,claim_revision_id,evidence_id) VALUES($1::uuid,$2::uuid,$3::uuid)", [projectId, currentId, fixture.evidenceId]);
      await tx.unsafe("INSERT INTO claim_revision_extraction_supports(project_id,claim_revision_id,extraction_revision_id) VALUES($1::uuid,$2::uuid,$3::uuid)", [projectId, currentId, fixture.extractionRevisionId]);
      await tx.unsafe("INSERT INTO claim_revision_synthesis_supports(project_id,claim_revision_id,synthesis_revision_id) VALUES($1::uuid,$2::uuid,$3::uuid)", [projectId, currentId, fixture.synthesisRevisionId]);
    }
    if (stream === "interpretation" && fixture?.maxInterpretationChildren && fixture.extractionRevisionId) {
      const currentId = stableUuid(`${parentId}:${config.kind}:${ordinary}`);
      await tx.unsafe(
        `INSERT INTO synthesis_interpretation_limitations(project_id,interpretation_id,sort_order,category,body)
         SELECT $1::uuid,$2::uuid,g-1,'other','Benchmark limitation '||g FROM generate_series(1,100) g`, [projectId,currentId]);
      await tx.unsafe(
        `INSERT INTO synthesis_interpretation_questions(project_id,interpretation_id,sort_order,body)
         SELECT $1::uuid,$2::uuid,g-1,'Benchmark question '||g FROM generate_series(1,100) g`, [projectId,currentId]);
      await tx.unsafe(
        `WITH support_ids AS (
           SELECT g, ${uuidSql(`$3::text || ':extraction-revision:' || g::text`)} AS id FROM generate_series(1,40) g
         ), pairs AS (
           SELECT least(a.id,b.id) AS left_id, greatest(a.id,b.id) AS right_id
           FROM support_ids a JOIN support_ids b ON a.g<b.g ORDER BY a.g,b.g LIMIT 500
         )
         INSERT INTO synthesis_interpretation_contradictions(project_id,interpretation_id,synthesis_revision_id,sort_order,left_extraction_revision_id,right_extraction_revision_id,note)
         SELECT $1::uuid,$2::uuid,$4::uuid,row_number() OVER (ORDER BY left_id,right_id)-1,left_id,right_id,'Benchmark contradiction'
         FROM pairs`, [projectId,currentId,projectId,parentId]);
    }
    if (tieCount > 0) {
      const tieSequence = Math.floor(size / 2);
      const sqlText = stream === "claim"
        ? `INSERT INTO claim_revisions (sequence, id, project_id, claim_id, state, claim_text, researcher_note) OVERRIDING SYSTEM VALUE SELECT $4::bigint, ${uuidSql(`$2::text || ':${config.kind}:' || ($3::int + g)::text`)}, $1::uuid, $2::uuid, 'active', 'Benchmark claim tie ' || g, 'Benchmark note' FROM generate_series(1, $5::int) g`
        : stream === "synthesis"
          ? `INSERT INTO synthesis_revisions (sequence, id, project_id, synthesis_statement_id, state, title, statement_text, researcher_note) OVERRIDING SYSTEM VALUE SELECT $4::bigint, ${uuidSql(`$2::text || ':${config.kind}:' || ($3::int + g)::text`)}, $1::uuid, $2::uuid, 'active', 'Benchmark title tie ' || g, 'Benchmark synthesis statement tie ' || g, 'Benchmark note' FROM generate_series(1, $5::int) g`
          : `INSERT INTO synthesis_interpretations (sequence, id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary, researcher_note) OVERRIDING SYSTEM VALUE SELECT $4::bigint, ${uuidSql(`$2::text || ':${config.kind}:' || ($3::int + g)::text`)}, $1::uuid, $5::uuid, $2::uuid, 'inconclusive', 'Benchmark interpretation tie ' || g, 'Benchmark note' FROM generate_series(1, $6::int) g`;
      await tx.unsafe(sqlText, stream === "interpretation" ? [projectId, parentId, ordinary, tieSequence, parentRevisionId, tieCount] : [projectId, parentId, ordinary, tieSequence, tieCount]);
    }
    const parentValue = stream === "interpretation" ? parentId : parentId;
    await tx.unsafe(`UPDATE ${config.table} SET finalized_at = now() WHERE project_id = $1::uuid AND ${config.parent} = $2::uuid`, [projectId, parentValue]);
  });
  return { ordinary, tieCount, currentEventId: stableUuid(`${parentId}:${config.kind}:${ordinary}`) };
}
async function anchor(client: postgres.Sql, stream: "claim" | "synthesis" | "interpretation", projectId: string, parentId: string, offset: number) {
  const relation = stream === "claim" ? "claim_revisions" : stream === "synthesis" ? "synthesis_revisions" : "synthesis_interpretations";
  const parentColumn = stream === "claim" ? "claim_id" : stream === "synthesis" ? "synthesis_statement_id" : "synthesis_revision_id";
  const direction = stream === "synthesis" ? "ASC" : "DESC";
  const rows = await client.unsafe(`SELECT id, sequence::text AS sequence FROM ${relation} WHERE project_id=$1::uuid AND ${parentColumn}=$2::uuid ORDER BY sequence ${direction}, id ${direction} OFFSET $3 LIMIT 1`, [projectId, parentId, offset]);
  return rows[0] as { id: string; sequence: string };
}
async function anchorInsideSequenceTie(client: postgres.Sql, stream: "claim" | "synthesis" | "interpretation", projectId: string, parentId: string) {
  const relation = stream === "claim" ? "claim_revisions" : stream === "synthesis" ? "synthesis_revisions" : "synthesis_interpretations";
  const parentColumn = stream === "claim" ? "claim_id" : stream === "synthesis" ? "synthesis_statement_id" : "synthesis_revision_id";
  const direction = stream === "synthesis" ? "ASC" : "DESC";
  const countRows = await client.unsafe(
    `SELECT count(*)::int AS tie_group_rows FROM ${relation} WHERE project_id=$1::uuid AND ${parentColumn}=$2::uuid AND sequence=$3::bigint`,
    [projectId, parentId, Math.floor(50_000 / 2)],
  );
  const rows = await client.unsafe(
    `SELECT id,sequence::text AS sequence FROM ${relation}
     WHERE project_id=$1::uuid AND ${parentColumn}=$2::uuid AND sequence=$3::bigint
     ORDER BY id ${direction} OFFSET $4::int LIMIT 1`,
    [projectId, parentId, Math.floor(50_000 / 2), Math.floor(TIE_COUNT / 2) - 1],
  );
  if (!rows[0]) throw new Error(`No tie-group anchor found for ${stream}.`);
  return { row: rows[0] as { id: string; sequence: string }, tieGroupRows: Number((countRows[0] as { tie_group_rows: number }).tie_group_rows), positionWithinTieGroup: Math.floor(TIE_COUNT / 2) };
}
function cursorFor(stream: "claim" | "synthesis" | "interpretation", projectId: string, parentId: string, statementId: string, row: { id: string; sequence: string }) {
  const cursor = stream === "claim"
    ? { v: 1 as const, projectId, claimId: parentId, historyType: "claim-revision" as const, pageSize: PAGE_SIZE, lastSequence: row.sequence, lastEventId: row.id }
    : stream === "synthesis"
      ? { v: 1 as const, projectId, statementId: parentId, historyType: "synthesis-revision" as const, pageSize: PAGE_SIZE, lastSequence: row.sequence, lastEventId: row.id }
      : { v: 1 as const, projectId, statementId, revisionId: parentId, historyType: "synthesis-interpretation" as const, pageSize: PAGE_SIZE, lastSequence: row.sequence, lastEventId: row.id };
  return encodeClaimSynthesisHistoryCursor(cursor as never);
}

async function seedExtractionCorpus(client: postgres.Sql, projectId: string) {
  const fieldId = stableUuid(`${projectId}:field`);
  const evidenceId = stableUuid(`${projectId}:evidence:1`);
  await client.unsafe("INSERT INTO extraction_fields(id,project_id,name,field_type) VALUES($1::uuid,$2::uuid,'Benchmark field','short_text')", [fieldId, projectId]);
  await client.unsafe(
    `INSERT INTO papers(id,project_id,title)
     SELECT ${uuidSql("$1::text || ':paper:' || g::text")},$2::uuid,'Benchmark paper '||g FROM generate_series(1,1000) g`,
    [projectId, projectId],
  );
  await client.unsafe(
    `INSERT INTO screening_decisions(project_id,paper_id,decision)
     SELECT $1::uuid,${uuidSql("$1::text || ':paper:' || g::text")},'include' FROM generate_series(1,1000) g`, [projectId]);
  await client.unsafe(
    `INSERT INTO evidence(id,project_id,paper_id,source_text,page_number)
     VALUES($1::uuid,$2::uuid,$3::uuid,repeat('Large benchmark evidence passage. ',2500),1)`,
    [evidenceId, projectId, stableUuid(`${projectId}:paper:1`)],
  );
  await client.unsafe(
    `INSERT INTO extraction_values(id,project_id,paper_id,field_id)
     SELECT ${uuidSql("$1::text || ':extraction-value:' || g::text")},$1::uuid,
       ${uuidSql("$1::text || ':paper:' || g::text")},$2::uuid FROM generate_series(1,1000) g`, [projectId, fieldId]);
  await client.unsafe(
    `INSERT INTO extraction_value_revisions(id,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,researcher_note)
     SELECT ${uuidSql("$1::text || ':extraction-revision:' || g::text")},$1::uuid,
       ${uuidSql("$1::text || ':paper:' || g::text")},$2::uuid,
       ${uuidSql("$1::text || ':extraction-value:' || g::text")},'short_text','present','Benchmark extracted value '||g,'Synthetic benchmark fixture'
     FROM generate_series(1,1000) g`, [projectId, fieldId]);
  await client.unsafe(
    `INSERT INTO extraction_revision_evidence(project_id,paper_id,revision_id,evidence_id)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
    [projectId, stableUuid(`${projectId}:paper:1`), stableUuid(`${projectId}:extraction-revision:1`), evidenceId],
  );
  await client.unsafe("UPDATE extraction_value_revisions SET finalized_at=now() WHERE project_id=$1::uuid AND finalized_at IS NULL", [projectId]);
  return {
    fieldId,
    evidenceId,
    extractionRevisionIds: Array.from({ length: 1000 }, (_, index) => stableUuid(`${projectId}:extraction-revision:${index + 1}`)),
  };
}

async function main() {
  activeStage = "validate-node-and-url";
  if (process.versions.node !== "22.13.0") throw new Error(`Expected Node 22.13.0, found ${process.versions.node}.`);
  const configuredUrl = process.env.DATABASE_URL?.trim();
  if (!configuredUrl) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role with permission to create and drop a uniquely named disposable database.");
  const historicalStages = await loadHistoricalStageEvidence();
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `slice52_history_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  const measurements: Array<{ label: string; measurement: Measurement }> = [];
  const plans: unknown[] = [];
  const stageCDeepPagePlans: Array<Record<string, unknown>> = [];
  let stageCCompletedPlanCount = 0;
  const legacy: unknown[] = [];
  const fixtureSummary: Record<string, unknown> = {};
  let evidence: Record<string, unknown> | undefined;
  let cleanup: Record<string, unknown> = { status: "not_started" };
  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version_num, current_setting('server_version') as version_text");
    const version = Number((versionRows[0] as { version_num: string }).version_num);
    const postgresVersion = String((versionRows[0] as { version_text: string }).version_text);
    if (Math.floor(version / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; server version number was ${version}.`);
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    activeStage = "migrate-disposable-database";
    const migrationClient = postgres(databaseUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try { await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") }); }
    finally { await migrationClient.end({ timeout: 1 }); }

    client = postgres(databaseUrl.toString(), { max: 2, prepare: false, onnotice: () => {} });
    await client.unsafe(`SET statement_timeout = '${SEED_TIMEOUT_MS}ms'`);
    const historyIndexInventory = await get0038IndexInventory(client);
    const installedHistoryIndexNames = historyIndexInventory.map((index) => index.indexname).sort();
    const expectedHistoryIndexNames = [...HISTORY_INDEX_NAMES_0038].sort();
    if (JSON.stringify(installedHistoryIndexNames) !== JSON.stringify(expectedHistoryIndexNames)) {
      throw new Error(`Disposable schema does not contain exactly the approved 0038 history indexes: ${installedHistoryIndexNames.join(", ")}.`);
    }
    const interpretationChildIndexInventory = await getInterpretationChildIndexInventory(client);
    const plannerSettingsRows = await client.unsafe(
      `SELECT current_setting('enable_bitmapscan') AS enable_bitmapscan,
              current_setting('enable_indexscan') AS enable_indexscan,
              current_setting('enable_seqscan') AS enable_seqscan,
              current_setting('enable_sort') AS enable_sort`,
    );
    const historyPlannerSettings = plannerSettingsRows[0] as Record<string, string>;
    const projectId = stableUuid(`slice52:${databaseName}:project`);
    const db = makeDatabase(client);
    const services = createClaimSynthesisHistoryReadServices(db);
    const review = createReviewServices(db);
    const claimRead = createClaimReadServices(db);
    const claimExactRead = createClaimRevisionExactAuditReadServices(db, review.getClaimRevision);
    const claimSupport = createClaimSupportReadServices(db);
    const synthesisRead = createSynthesisReadServices(db);
    const synthesisRevisionExactRoute = createSynthesisRevisionExactRouteReadServices(db);
    const interpretationExact = createSynthesisInterpretationExactReadServices(db);
    const interpretationCurrent = createSynthesisInterpretationCurrentReadServices(db, { getSynthesisProvenance: review.getSynthesisProvenance });
    await client.unsafe("INSERT INTO projects (id,title) VALUES ($1::uuid,'Slice 52 history benchmark')", [projectId]);
    activeStage = "seed-identities-and-extraction-corpus";
    const claimIds = POPULATIONS.map((size) => stableUuid(`${projectId}:claim:${size}`));
    await client.unsafe("INSERT INTO claims (id,project_id) VALUES ($1::uuid,$4::uuid),($2::uuid,$4::uuid),($3::uuid,$4::uuid)", [...claimIds, projectId]);
    const statementIds = new Map<number, string>();
    for (const size of POPULATIONS) {
      const statementId = stableUuid(`${projectId}:statement:${size}`);
      statementIds.set(size, statementId);
      await client.unsafe("INSERT INTO synthesis_statements (id,project_id) VALUES ($1::uuid,$2::uuid)", [statementId, projectId]);
    }
    const extractionCorpus = await seedExtractionCorpus(client, projectId);
    fixtureSummary.extractionCorpus = { papers: 1_000, fields: 1, evidenceRows: 1, extractionRevisions: 1_000, largeEvidenceUtf8Bytes: 85_000 };
    activeStage = "seed-evidence-set-context";
    const evidenceSetCreated = await review.createEvidenceSet(projectId, { name: "Slice 52 history benchmark context" });
    const evidenceSetAdded = await review.addEvidenceToSet(projectId, evidenceSetCreated.set.id, { evidenceId: extractionCorpus.evidenceId, expectedRevisionId: evidenceSetCreated.revision.id });
    const evidenceSet = { ...evidenceSetCreated, revision: evidenceSetAdded.revision };
    const benchmarkContexts = new Map<number, { claimId: string; claimRevisionId: string; statementId: string; revisionId: string; interpretationId: string; synthesisRevisionId: string; synthesisSupportCount: number; sizes: Record<string, number> }>();
    for (const size of POPULATIONS) {
      activeStage = `seed-and-measure-${size}`;
      const claimId = stableUuid(`${projectId}:claim:${size}`);
      const statementId = statementIds.get(size)!;
      const synthesis = await seedEvent(client, "synthesis", projectId, statementId, size, undefined, { extractionRevisionId: extractionCorpus.extractionRevisionIds[0] });
      const interpretationParentId = synthesis.currentEventId;
      const currentRevisionRows = await client.unsafe("SELECT count(*)::int AS count FROM synthesis_revisions WHERE project_id=$1::uuid AND synthesis_statement_id=$2::uuid AND id=$3::uuid AND finalized_at IS NOT NULL", [projectId, statementId, interpretationParentId]);
      if (Number((currentRevisionRows[0] as { count: number }).count) !== 1) throw new Error("Seeded current SynthesisRevision id did not match the deterministic fixture id.");
      const interpretation = await seedEvent(client, "interpretation", projectId, interpretationParentId, size, statementId, { extractionRevisionId: extractionCorpus.extractionRevisionIds[0], maxInterpretationChildren: size === 10_000 });
      const claim = await seedEvent(client, "claim", projectId, claimId, size, undefined, size === 50_000 ? {
        evidenceId: extractionCorpus.evidenceId,
        extractionRevisionId: extractionCorpus.extractionRevisionIds[0],
        synthesisRevisionId: synthesis.currentEventId,
      } : undefined);
      if (size === 1_000) {
        const preparationId = stableUuid(`${projectId}:preparation:${size}`);
        await client.unsafe(
          `INSERT INTO synthesis_preparations(id,project_id,evidence_set_id,evidence_set_composition_revision_id,extraction_field_id,working_title,status)
           VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'Benchmark preparation','active')`,
          [preparationId, projectId, evidenceSet.set.id, evidenceSet.revision.id, extractionCorpus.fieldId],
        );
        await client.unsafe(
          "INSERT INTO synthesis_preparation_selections(project_id,preparation_id,extraction_revision_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
          [projectId, preparationId, extractionCorpus.extractionRevisionIds[0]],
        );
        await client.unsafe(
          `UPDATE synthesis_preparations SET status='finalized',target_synthesis_statement_id=$2::uuid,
            finalized_synthesis_revision_id=$3::uuid,finalized_at=now(),updated_at=now()
           WHERE project_id=$1::uuid AND id=$4::uuid`, [projectId, statementId, synthesis.currentEventId, preparationId]);
      }
      benchmarkContexts.set(size, {
        claimId, claimRevisionId: claim.currentEventId, statementId, revisionId: interpretationParentId,
        interpretationId: interpretation.currentEventId, synthesisRevisionId: synthesis.currentEventId,
        synthesisSupportCount: size === 50_000 ? 1_000 : size === 10_000 ? 40 : 1,
        sizes: { claim: size, synthesis: size, interpretation: size },
      });
      fixtureSummary[`history_${size}`] = {
        claimRevisions: size, synthesisRevisions: size, interpretations: size,
        synthesisSupportCardinalities: { one: 1, ten: 1, fifty: 1, current: size === 50_000 ? 1_000 : size === 10_000 ? 40 : 1 },
        claimCurrentSupports: size === 50_000 ? { evidence: 1, extraction: 1, synthesis: 1 } : { evidence: 0, extraction: 0, synthesis: 0 },
        interpretationChildren: size === 10_000 ? { limitations: 100, questions: 100, contradictions: 500 } : { limitations: 0, questions: 0, contradictions: 0 },
        preparationContext: size === 1_000 ? 1 : 0,
      };
      await client.unsafe("ANALYZE");
      const pageMethods = {
        claim: (options: { pageSize: number; cursor?: string | null }) => services.getClaimRevisionHistoryPage(projectId, claimId, options),
        synthesis: (options: { pageSize: number; cursor?: string | null }) => services.getSynthesisRevisionHistoryPage(projectId, statementId, options),
        interpretation: (options: { pageSize: number; cursor?: string | null }) => services.getSynthesisInterpretationHistoryPage(projectId, statementId, interpretationParentId, options),
      };
      for (const stream of ["claim", "synthesis", "interpretation"] as const) {
        for (const phase of ["first", "deep", "final"] as const) {
          const offset = phase === "first" ? null : phase === "deep" ? Math.max(0, Math.floor(size / 2) - 1) : Math.max(0, size - PAGE_SIZE - 1);
          const parentId = stream === "claim" ? claimId : stream === "synthesis" ? statementId : interpretationParentId;
          const cursor = offset === null ? null : cursorFor(stream, projectId, parentId, statementId, await anchor(client, stream, projectId, parentId, offset));
          await client.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
          const result = await measured(`${stream}-${phase}-${size}`, () => pageMethods[stream]({ pageSize: PAGE_SIZE, cursor }));
          measurements.push({ label: result.label, measurement: result.measurement });
          if (phase === "deep") {
            const selects = result.measurement.queries.filter((query) => /^(with|select)\b/i.test(query.sql.trim()));
            for (const [index, query] of selects.entries()) plans.push(await explainQuery(client, query, `${stream}-deep-${size}-select-${index + 1}`));
            if (size === 50_000) {
              const sources = STAGE_C_PAGE_QUERIES.filter((entry) => entry.stream === stream);
              for (const source of sources) {
                const matches = matchingHistoryPageQueries(result.measurement, source);
                const label = `stage-c-${source.stream}-${source.queryKind}-deep-50000-final-application-select`;
                const resultPlan = matches.length === 1
                  ? await explainQuery(client, matches[0], label)
                  : {
                    label,
                    status: matches.length === 0 ? "skipped" : "failed",
                    reason: `Expected exactly one captured ${source.table} ${source.queryKind} SELECT; found ${matches.length}.`,
                    queryCandidates: matches,
                  };
                const stagePlan = {
                  ...resultPlan,
                  stage: "C",
                  source: {
                    file: "src/application/claim-synthesis-history-read-services.ts",
                    stream: source.stream,
                    queryKind: source.queryKind,
                    symbol: source.sourceSymbol,
                    table: source.table,
                    cursorOrder: source.cursorOrder,
                    cteMarker: source.cteMarker,
                    requiredSqlMarkers: source.requiredSqlMarkers,
                    queryMatch: `Exact SQL captured from the completed 50k deep-page application read; ${source.cteMarker}, source table, and every required query marker.`,
                  },
                  indexState: "migration 0038 indexes present; no index DDL during stage C",
                  plannerSettings: historyPlannerSettings,
                  matchedQueryCount: matches.length,
                };
                stageCDeepPagePlans.push(stagePlan);
                plans.push(stagePlan);
              }
            }
          }
        }
        if (size === 50_000) {
          const parentId = stream === "claim" ? claimId : stream === "synthesis" ? statementId : interpretationParentId;
          const tie = await anchorInsideSequenceTie(client, stream, projectId, parentId);
          const tieCursor = cursorFor(stream, projectId, parentId, statementId, tie.row);
          const tiePage = await measured(`${stream}-sequence-tie-50000`, () => pageMethods[stream]({ pageSize: PAGE_SIZE, cursor: tieCursor }));
          measurements.push({ label: tiePage.label, measurement: tiePage.measurement });
          const finalPageQuery = tiePage.measurement.queries.find((query) => /^(with|select)\b/i.test(query.sql.trim()) && /page_candidates\s+as\s+materialized|visible_page\s+as\s+materialized/i.test(query.sql));
          const plan = await explainQuery(client, finalPageQuery, `${stream}-sequence-tie-50000-final-select`);
          plans.push({ ...plan, tieGroup: { sequence: tie.row.sequence, rows: tie.tieGroupRows, anchorPosition: tie.positionWithinTieGroup, order: stream === "synthesis" ? "ASC (sequence,id)" : "DESC (sequence,id)" } });
        }
      }

      const context = benchmarkContexts.get(size)!;
      const claimSupportIds = size === 50_000
        ? { evidenceIds: [extractionCorpus.evidenceId], extractionRevisionIds: [extractionCorpus.extractionRevisionIds[0]], synthesisRevisionIds: [context.synthesisRevisionId] }
        : { evidenceIds: [], extractionRevisionIds: [], synthesisRevisionIds: [] };
      const claimDetail = await measured(`claim-main-detail-${size}`, async () => Promise.all([
        pageMethods.claim({ pageSize: PAGE_SIZE }),
        claimExactRead.getClaimRevisionForExactAudit(projectId, context.claimId, context.claimRevisionId, { selectedCurrentRevisionId: context.claimRevisionId }),
        claimSupport.resolveEligibleClaimSupportIds({ projectId, ...claimSupportIds }),
      ]));
      measurements.push({ label: claimDetail.label, measurement: claimDetail.measurement });
      plans.push(await explain(client, claimDetail.measurement, `claim-current-sequence-map-${size}`, /sequence_values\s+as\s*\(/i));
      const claimExact = await measured(`claim-exact-artifact-${size}`, () => claimExactRead.getClaimRevisionForExactAudit(projectId, context.claimId, context.claimRevisionId));
      measurements.push({ label: claimExact.label, measurement: claimExact.measurement });
      plans.push(await explain(client, claimExact.measurement, `claim-exact-artifact-sequence-map-${size}`, /sequence_values\s+as\s*\(/i));
      if (size === 50_000) {
        const withdrawal = await review.withdrawClaim(projectId, context.claimId, {
          expectedCurrentRevisionId: context.claimRevisionId,
          researcherNote: "Synthetic benchmark withdrawal",
        });
        const withdrawnRevisionId = String(withdrawal.revision.id);
        fixtureSummary.claim_withdrawn_detail_50000 = {
          activeHistoryEvents: size,
          withdrawnRevisionAdded: 1,
          totalHistoryEvents: size + 1,
          currentRevisionId: withdrawnRevisionId,
          priorActiveRevisionId: context.claimRevisionId,
        };
        await client.unsafe("ANALYZE claim_revisions");
        const withdrawnDetail = await measured("claim-main-detail-withdrawn-50000", async () => {
          const history = await pageMethods.claim({ pageSize: PAGE_SIZE });
          if (!history.current || history.current.id !== withdrawnRevisionId) throw new Error("Withdrawn Claim fixture did not become the bounded current revision.");
          const current = await claimExactRead.getClaimRevisionForExactAudit(
            projectId, context.claimId, history.current.id, { selectedCurrentRevisionId: history.current.id },
          );
          const latestActiveRevisionId = await claimRead.getLatestActiveClaimRevisionId(projectId, context.claimId);
          if (!latestActiveRevisionId || latestActiveRevisionId !== context.claimRevisionId) throw new Error("Withdrawn Claim fixture did not resolve the expected prior active revision.");
          const priorActive = await claimExactRead.getClaimRevisionForExactAudit(
            projectId, context.claimId, latestActiveRevisionId, { selectedCurrentRevisionId: history.current.id },
          );
          const eligible = await claimSupport.resolveEligibleClaimSupportIds({ projectId, ...claimSupportIds });
          return { history, current, latestActiveRevisionId, priorActive, eligible };
        });
        measurements.push({ label: withdrawnDetail.label, measurement: withdrawnDetail.measurement });
        plans.push(await explain(client, withdrawnDetail.measurement, "claim-withdrawn-latest-active-selector-50000", /select c\.id as claim_id/i));
        const withdrawnSequenceMapQueries = withdrawnDetail.measurement.queries.filter((query) => /sequence_values\s+as\s*\(/i.test(query.sql));
        if (withdrawnSequenceMapQueries.length !== 2) throw new Error(`Expected current and prior-active exact Claim sequence-map queries; captured ${withdrawnSequenceMapQueries.length}.`);
        plans.push(await explainQuery(client, withdrawnSequenceMapQueries[0], "claim-withdrawn-current-sequence-map-50000"));
        plans.push(await explainQuery(client, withdrawnSequenceMapQueries[1], "claim-withdrawn-prior-active-sequence-map-50000"));
      }
      legacy.push({ label: `legacy-getClaimHistory-${size}`, status: "skipped", reason: "Legacy full-history projection is excluded from this controlled run because it hydrates every revision; skipped legacy reads are not counted as passes." });

      const targets = Array.from({ length: context.synthesisSupportCount }, (_, index) => ({
        paperId: stableUuid(`${projectId}:paper:${index + 1}`),
        fieldId: extractionCorpus.fieldId,
        extractionRevisionId: extractionCorpus.extractionRevisionIds[index],
      }));
      const synthesisDetail = await measured(`synthesis-main-detail-${size}`, async () => {
        const [history, legacyCurrent, exactSequences, preparation, currentInterpretation, editContext] = await Promise.all([
          pageMethods.synthesis({ pageSize: PAGE_SIZE }),
          review.getSynthesisProvenance(projectId, context.statementId, context.synthesisRevisionId),
          synthesisRevisionExactRoute.getSynthesisRevisionExactRouteSequences(projectId, context.statementId, context.synthesisRevisionId),
          review.getSynthesisPreparationContextForRevision(projectId, context.synthesisRevisionId),
          interpretationCurrent.getCurrentSynthesisInterpretationSummary(projectId, context.statementId, context.synthesisRevisionId),
          synthesisRead.getSynthesisRevisionEditContext(projectId, targets),
        ]);
        const revision = {
          ...legacyCurrent,
          supports: legacyCurrent.supports.map((support) => {
            const sequence = exactSequences.extractionRevisionSequences[support.extractionRevisionId];
            if (sequence === undefined) throw new Error(`Exact Synthesis support sequence is missing for ${support.extractionRevisionId}.`);
            return { ...support, extractionRevision: { ...support.extractionRevision, sequence } };
          }),
        };
        return { history, revision, preparation, currentInterpretation, editContext };
      });
      measurements.push({ label: synthesisDetail.label, measurement: synthesisDetail.measurement });
      plans.push(await explain(client, synthesisDetail.measurement, `synthesis-detail-exact-sequence-map-${size}`, /extraction_revision_sequences/i));
      plans.push(await explain(client, synthesisDetail.measurement, `synthesis-page-preparation-join-${size}`, /synthesis_preparations/i));
      const synthesisExact = await measured(`synthesis-exact-artifact-${size}`, () => review.getSynthesisProvenance(projectId, context.statementId, context.synthesisRevisionId));
      measurements.push({ label: synthesisExact.label, measurement: synthesisExact.measurement });
      const preparationContext = await measured(`preparation-context-${size}`, () => review.getSynthesisPreparationContextForRevision(projectId, context.synthesisRevisionId));
      measurements.push({ label: preparationContext.label, measurement: preparationContext.measurement });
      plans.push(await explain(client, preparationContext.measurement, `preparation-context-${size}`));

      const interpretationTimeline = await measured(`current-interpretation-and-timeline-${size}`, async () => Promise.all([
        pageMethods.interpretation({ pageSize: PAGE_SIZE }),
        (async () => {
          const revision = synthesisExact.value;
          if (!revision) throw new Error("The exact SynthesisRevision fixture was unavailable for the current interpretation read.");
          const extractionRevisionSequences = Object.fromEntries(revision.supports.map((support) => [support.extractionRevisionId, String(support.extractionRevision.sequence)]));
          return interpretationCurrent.getCurrentSynthesisInterpretationSnapshot(
            projectId, context.statementId, context.synthesisRevisionId, revision, context.interpretationId, extractionRevisionSequences,
          );
        })(),
      ]));
      measurements.push({ label: interpretationTimeline.label, measurement: interpretationTimeline.measurement });
      plans.push(await explain(client, interpretationTimeline.measurement, `current-interpretation-selector-${size}`, /synthesis_interpretations/i));
      const exactInterpretation = await measured(`exact-interpretation-artifact-${size}`, () => interpretationExact.getExactSynthesisInterpretation(projectId, context.statementId, context.synthesisRevisionId, context.interpretationId));
      measurements.push({ label: exactInterpretation.label, measurement: exactInterpretation.measurement });
      plans.push(await explain(client, exactInterpretation.measurement, `exact-interpretation-support-resolution-${size}`, /\b(?:from|join)\s+extraction_value_revisions\b/i));
      if (size === 10_000) {
        const legacyProjection = await measured("legacy-interpretation-projection-10000", () => review.getSynthesisInterpretationProjection(projectId, context.statementId, context.synthesisRevisionId));
        measurements.push({ label: legacyProjection.label, measurement: legacyProjection.measurement });
        legacy.push({ label: legacyProjection.label, status: legacyProjection.measurement.status, wallTimeMs: legacyProjection.measurement.wallTimeMs, selectCount: legacyProjection.measurement.selectCount, driverRows: legacyProjection.measurement.driverRows, error: legacyProjection.measurement.error });
      } else legacy.push({ label: `legacy-interpretation-projection-${size}`, status: "skipped", reason: "The unbounded projection is sampled at 10k only; skipped legacy reads are not counted as passes." });
      legacy.push({ label: `legacy-synthesis-history-${size}`, status: "skipped", reason: "The legacy full-history projection is intentionally not invoked at 10k/50k because it hydrates the full event set; no skipped case is counted as a pass." });
    }
    stageCCompletedPlanCount = stageCDeepPagePlans.filter((plan) => plan.status === "completed").length;
    evidence = {
      benchmark: "Slice 52 Claim, Synthesis, and interpretation history read paths",
      nodeVersion: process.versions.node,
      postgresVersion,
      database: { name: databaseName, disposable: true, createdByRun: true },
      populations: POPULATIONS,
      pageSize: PAGE_SIZE,
      sequenceTieFixture: { stream: "all three streams at 50k", tiedEventsPerStream: TIE_COUNT, ordinaryEventAlsoSharesSequence: true, sequence: 25_000, cursorPositionWithinTieGroup: Math.floor(TIE_COUNT / 2), tiePageSize: PAGE_SIZE },
      fixtureSummary,
      note: "Timings are diagnostics. Driver bytes are UTF-8 JSON bytes of decoded postgres.js result rows, not network protocol bytes. DTO bytes are UTF-8 JSON bytes. Newly generated Stage C sortInputRows count actual tuples from immediate tuple-producing child plans and exclude EXPLAIN InitPlan/SubPlan children. Preserved Stage B sortInputRows fields retain their original legacy child-sum meaning, documented on Stage B. SQL and bound parameters are retained for every measured application read and plan. Stage C runs with the migration 0038 indexes present and normal planner settings; it does not drop or recreate indexes.",
      stages: {
        stageA: historicalStages.stageA,
        stageB: historicalStages.stageB,
        stageC: {
          stage: "C",
          description: "Migration 0038 plus the current page-key and visible-ID application query shapes",
          migration: "drizzle/0038_slice52_finalized_history_keysets.sql",
          indexInventory: historyIndexInventory,
          interpretationChildIndexInventory,
          plannerSettings: historyPlannerSettings,
          applicationQuerySources: STAGE_C_PAGE_QUERIES.map((source) => ({
            file: "src/application/claim-synthesis-history-read-services.ts",
            stream: source.stream,
            queryKind: source.queryKind,
            symbol: source.sourceSymbol,
            table: source.table,
            cursorOrder: source.cursorOrder,
            cteMarker: source.cteMarker,
            requiredSqlMarkers: source.requiredSqlMarkers,
          })),
          deepPagePlanCount: stageCDeepPagePlans.length,
          completedDeepPagePlanCount: stageCCompletedPlanCount,
          allDeepPagePlansCompleted: stageCDeepPagePlans.length === STAGE_C_PAGE_QUERIES.length && stageCCompletedPlanCount === STAGE_C_PAGE_QUERIES.length,
          deepPagePlans: stageCDeepPagePlans,
        },
      },
      measurements,
      plans,
      legacy,
      cleanup,
    };
  } finally {
    if (client) await client.end({ timeout: 1 });
    try {
      if (created) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
        const remaining = await admin.unsafe("SELECT count(*)::int AS count FROM pg_database WHERE datname = $1", [databaseName]);
        const absent = Number((remaining[0] as { count: number }).count) === 0;
        cleanup = { status: absent ? "verified" : "failed", droppedOnlyOwnedDatabase: true, databaseAbsent: absent, persistentVolumeRemoved: false };
        console.log(JSON.stringify({ event: "cleanup-verified", droppedOnlyOwnedDatabase: true, databaseAbsent: absent }));
        if (!absent) throw new Error("Disposable benchmark database remained after cleanup.");
      } else {
        cleanup = { status: "not_created", droppedOnlyOwnedDatabase: false, databaseCreated: false, persistentVolumeRemoved: false };
        console.log(JSON.stringify({ event: "cleanup-verified", droppedOnlyOwnedDatabase: false, databaseCreated: false }));
      }
    } finally {
      await admin.end({ timeout: 1 });
      if (evidence) {
        evidence.cleanup = cleanup;
        const finalPreIndexSha256 = sha256(await readFile(resolve(PREINDEX_ARTIFACT)));
        const stages = evidence.stages as Record<string, Record<string, unknown>>;
        (stages.stageA as Record<string, unknown>).fileIntegrityVerifiedAfterRun = finalPreIndexSha256 === EXPECTED_PREINDEX_SHA256;
        (stages.stageA as Record<string, unknown>).sha256AfterRun = finalPreIndexSha256;
        const output = resolve(FINAL_ARTIFACT);
        await mkdir(resolve("docs/benchmarks"), { recursive: true });
        await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
        console.log(JSON.stringify({ event: "benchmark-evidence-written", file: output, measurementCount: measurements.length, planCount: plans.length, stageCDeepPagePlanCount: stageCDeepPagePlans.length, stageCCompletedDeepPagePlanCount: stageCCompletedPlanCount }));
      }
    }
  }
}

main().catch((error: unknown) => { console.error(JSON.stringify({ stage: activeStage, error: safeError(error) })); process.exitCode = 1; });
