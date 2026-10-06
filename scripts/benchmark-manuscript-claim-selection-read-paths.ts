import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createManuscriptClaimSelectionReadServices } from "@/application/manuscript-claim-selection-read-services";
import { encodePlacementSelectionCursor, encodeReplacementSelectionCursor } from "@/application/manuscript-claim-selection-cursor";
import { createReviewServices } from "@/application/services";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";
import type { Database } from "@/db/client";

const PROJECT_SIZES = [1_000, 10_000, 50_000] as const;
const REPLACEMENT_SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const DIAGNOSTIC_TIMEOUT_MS = 120_000;
const LEGACY_MAX_SIZE = 10_000;
const TEXT_STRESS_CODE_POINTS = 10_000;
const SCOPE_TITLE_STRESS_CODE_POINTS = 40_000;
const MAX_DTO_BYTES = 256 * 1024;
const PROJECT_INDEX = "claim_revisions_project_active_sequence_order_idx";
const REPLACEMENT_INDEX = "claim_revisions_project_claim_active_sequence_order_idx";

let diagnosticContext: { stage: string; scenario?: string } = { stage: "startup" };

function setDiagnosticContext(stage: string, scenario?: string) {
  diagnosticContext = scenario
    ? { stage, scenario }
    : diagnosticContext.scenario ? { stage, scenario: diagnosticContext.scenario } : { stage };
}

type Profile = "active-heavy" | "withdrawn-heavy" | "clustered-withdrawn-tail" | "deep-histories" | "ties" | "text-10000-codepoints" | "zero-eligible";
type CapturedQuery = { query: string; params: unknown[] };
type CaptureSink = { queries: CapturedQuery[] };
type DirectDriverMetric = { rows: number; utf8Bytes: number };
type Scope = { projectId: string; manuscriptId: string; sectionId: string };
type LegacyRow = { id: string; claimId: string; sequence: number; claimText: string; isCurrent: boolean };
type OracleRow = { id: string; claim_id: string; sequence: string; current_revision_id: string };
type PageRun = {
  label: string;
  startOffset: number;
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  driverRows: number;
  driverUtf8Bytes: number;
  dtoUtf8Bytes: number;
  visibleRows: number;
  hasMore: boolean;
  sentinelHydrated: false;
  equivalentToOracle: boolean | null;
  currentnessCompared: boolean;
  currentnessComparedRows: number;
  currentnessSkippedAmbiguousTieRows: number;
  visibleItems: Array<{ id: string; claimId: string; sequence: string; isCurrent: boolean }>;
  query: CapturedQuery | null;
  explain: Record<string, unknown> | null;
};

const sink: CaptureSink = { queries: [] };
const directDriver: DirectDriverMetric = { rows: 0, utf8Bytes: 0 };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error: unknown) {
  const value = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const safeField = (...keys: string[]) => {
    for (const key of keys) {
      const field = value[key];
      if (typeof field === "string" || typeof field === "number") return field;
    }
    return undefined;
  };
  return JSON.stringify({
    failure: true,
    context: diagnosticContext,
    errorType: safeField("name") ?? "Error",
    code: safeField("code"),
    schema: safeField("schema", "schema_name"),
    table: safeField("table", "table_name"),
    column: safeField("column", "column_name"),
    constraint: safeField("constraint", "constraint_name"),
    routine: safeField("routine"),
    position: safeField("position"),
    sourceFile: safeField("file"),
    sourceLine: safeField("line"),
  });
}

function selectQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function utf8Bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function omitVisibleItems(page: PageRun) {
  const output = { ...page };
  Reflect.deleteProperty(output, "visibleItems");
  return output as Omit<PageRun, "visibleItems">;
}

function captureDatabase(client: postgres.Sql): Database {
  const base = drizzle(client, {
    schema,
    logger: {
      logQuery(query, params) {
        sink.queries.push({ query, params: [...params] });
      },
    },
  }) as Database;
  return new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "execute" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args) as unknown;
          const rows = Array.isArray(result) ? result : [];
          directDriver.rows += rows.length;
          directDriver.utf8Bytes += utf8Bytes(rows);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

function summarisePlan(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const root = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
  const planRoot = root?.Plan as Record<string, unknown> | undefined;
  const nodes: Array<Record<string, unknown>> = [];
  let indexEntriesReadEstimate = 0;
  let heapTupleRowsVisitedEstimate = 0;
  let heapFetches = 0;
  let rowsRemovedByFilter = 0;
  let rowsRemovedByJoinFilter = 0;
  let tempReadBlocks = 0;
  let tempWrittenBlocks = 0;
  let largestSortEstimate = 0;
  let largestSortInputActualRows = 0;
  let nextNodeId = 0;

  function visit(valueNode: unknown, parentNodeId: number | null = null): number | null {
    if (typeof valueNode !== "object" || valueNode === null) return null;
    const node = valueNode as Record<string, unknown>;
    const nodeId = nextNodeId++;
    const type = String(node["Node Type"] ?? "unknown");
    const rows = Number(node["Actual Rows"] ?? 0);
    const loops = Number(node["Actual Loops"] ?? 0);
    const removed = Number(node["Rows Removed by Filter"] ?? 0);
    const joinRemoved = Number(node["Rows Removed by Join Filter"] ?? 0);
    const recheckRemoved = Number(node["Rows Removed by Index Recheck"] ?? 0);
    const actualRowWork = (rows + removed + recheckRemoved) * loops;
    if (type === "Index Scan" || type === "Index Only Scan" || type === "Bitmap Index Scan") indexEntriesReadEstimate += actualRowWork;
    if (["Index Scan", "Bitmap Heap Scan", "Seq Scan", "Tid Scan"].includes(type)) heapTupleRowsVisitedEstimate += actualRowWork;
    heapFetches += Number(node["Heap Fetches"] ?? 0) * loops;
    rowsRemovedByFilter += removed * loops;
    rowsRemovedByJoinFilter += joinRemoved * loops;
    tempReadBlocks += Number(node["Temp Read Blocks"] ?? 0);
    tempWrittenBlocks += Number(node["Temp Written Blocks"] ?? 0);
    const childPlans = Array.isArray(node.Plans) ? node.Plans : [];
    const childNodeIds = childPlans
      .map((child) => visit(child, nodeId))
      .filter((childId): childId is number => childId !== null);
    const tupleProducingChildren = childPlans.filter((child) => {
      if (typeof child !== "object" || child === null) return false;
      const relationship = String((child as Record<string, unknown>)["Parent Relationship"] ?? "");
      return relationship !== "InitPlan" && relationship !== "SubPlan";
    });
    const sortInputActualRows = tupleProducingChildren.reduce((total, child) => {
      if (typeof child !== "object" || child === null) return total;
      const childNode = child as Record<string, unknown>;
      if (childNode["Actual Rows"] === undefined) return total;
      return total + Number(childNode["Actual Rows"] ?? 0) * Number(childNode["Actual Loops"] ?? 0);
    }, 0);
    if (type.includes("Sort")) {
      largestSortEstimate = Math.max(largestSortEstimate, Number(node["Plan Rows"] ?? 0));
      largestSortInputActualRows = Math.max(largestSortInputActualRows, sortInputActualRows);
    }
    nodes.push({
      nodeId,
      parentNodeId,
      childNodeIds,
      nodeType: type,
      parentRelationship: node["Parent Relationship"] ?? null,
      relation: node["Relation Name"] ?? null,
      index: node["Index Name"] ?? null,
      estimatedRows: node["Plan Rows"] ?? null,
      actualRows: node["Actual Rows"] ?? null,
      loops: node["Actual Loops"] ?? null,
      rowsRemovedByFilter: node["Rows Removed by Filter"] ?? null,
      rowsRemovedByJoinFilter: node["Rows Removed by Join Filter"] ?? null,
      rowsRemovedByIndexRecheck: node["Rows Removed by Index Recheck"] ?? null,
      heapFetches: node["Heap Fetches"] ?? null,
      sharedHitBlocks: node["Shared Hit Blocks"] ?? 0,
      sharedReadBlocks: node["Shared Read Blocks"] ?? 0,
      tempReadBlocks: node["Temp Read Blocks"] ?? 0,
      tempWrittenBlocks: node["Temp Written Blocks"] ?? 0,
      sortMethod: node["Sort Method"] ?? null,
      sortSpaceType: node["Sort Space Type"] ?? null,
      sortSpaceUsedKb: node["Sort Space Used"] ?? null,
      sortInputEstimatedRows: type.includes("Sort")
        ? tupleProducingChildren.reduce((total, child) => total + Number((child as Record<string, unknown>)["Plan Rows"] ?? 0), 0)
        : null,
      sortInputActualRows: type.includes("Sort") ? sortInputActualRows : null,
    });
    return nodeId;
  }
  visit(planRoot);
  return {
    planningTimeMs: root?.["Planning Time"] ?? null,
    executionTimeMs: root?.["Execution Time"] ?? null,
    rootSharedHitBlocks: planRoot?.["Shared Hit Blocks"] ?? 0,
    rootSharedReadBlocks: planRoot?.["Shared Read Blocks"] ?? 0,
    indexEntriesReadEstimate,
    heapTupleRowsVisitedEstimate,
    heapFetches,
    rowsRemovedByFilter,
    rowsRemovedByJoinFilter,
    tempReadBlocks,
    tempWrittenBlocks,
    largestSortEstimate,
    largestSortInputActualRows,
    nodes,
  };
}

async function explain(client: postgres.Sql, query: CapturedQuery) {
  const started = process.hrtime.bigint();
  const rows = await client.unsafe(`explain (analyze, buffers, format json) ${query.query}`, query.params as never) as unknown as Array<Record<string, unknown>>;
  return { diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, sqlUtf8Bytes: Buffer.byteLength(query.query, "utf8"), plan: summarisePlan(rows[0]?.["QUERY PLAN"]) };
}

function pageAnchorQuery(projectId: string, offset: number): CapturedQuery {
  const query = `select r.sequence::text as sequence, r.id::text as revision_id
    from claim_revisions r
    join lateral (
      select current_r.id, current_r.state
      from claim_revisions current_r
      where current_r.project_id=r.project_id and current_r.claim_id=r.claim_id
        and current_r.finalized_at is not null
      order by current_r.sequence desc limit 1
    ) current_claim on true
    where r.project_id=$1::uuid and r.finalized_at is not null and r.state='active'
      and current_claim.state='active'
    order by r.sequence desc, r.id asc offset $2::integer limit 1`;
  return { query, params: [projectId, offset] };
}

function replacementAnchorQuery(projectId: string, claimId: string, placedSequence: string, offset: number): CapturedQuery {
  return {
    query: `select sequence::text as sequence, id::text as revision_id
      from claim_revisions
      where project_id=$1::uuid and claim_id=$2::uuid and finalized_at is not null
        and state='active' and sequence>$3::bigint
      order by sequence desc, id asc offset $4::integer limit 1`,
    params: [projectId, claimId, placedSequence, offset],
  };
}

async function cursorAtOffset(client: postgres.Sql, scope: Scope, offset: number, type: "placement" | "replacement", replacement?: { placementId: string; claimId: string; placedRevisionId: string; placedSequence: string }): Promise<string> {
  const query = type === "placement"
    ? pageAnchorQuery(scope.projectId, offset)
    : replacementAnchorQuery(scope.projectId, replacement!.claimId, replacement!.placedSequence, offset);
  const rows = await client.unsafe(query.query, query.params as never) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new Error(`No cursor anchor was found at offset ${offset}.`);
  const lastSequence = String(rows[0].sequence);
  const lastRevisionId = String(rows[0].revision_id);
  if (type === "placement") return encodePlacementSelectionCursor({ v: 1, selectorType: "placement", projectId: scope.projectId, manuscriptId: scope.manuscriptId, sectionId: scope.sectionId, pageSize: PAGE_SIZE, lastSequence, lastRevisionId });
  return encodeReplacementSelectionCursor({ v: 1, selectorType: "replacement", projectId: scope.projectId, manuscriptId: scope.manuscriptId, placementId: replacement!.placementId, claimId: replacement!.claimId, placedRevisionId: replacement!.placedRevisionId, placedSequence: replacement!.placedSequence, pageSize: PAGE_SIZE, lastSequence, lastRevisionId });
}

async function expectedProjectWindow(client: postgres.Sql, projectId: string, start: number, pageSize = PAGE_SIZE): Promise<OracleRow[]> {
  const query = `select r.id::text as id, r.claim_id::text as claim_id, r.sequence::text as sequence,
      current_claim.id::text as current_revision_id
    from claim_revisions r
    join lateral (
      select current_r.id, current_r.state
      from claim_revisions current_r
      where current_r.project_id=r.project_id and current_r.claim_id=r.claim_id
        and current_r.finalized_at is not null
      order by current_r.sequence desc limit 1
    ) current_claim on true
    where r.project_id=$1::uuid and r.finalized_at is not null and r.state='active'
      and current_claim.state='active'
    order by r.sequence desc, r.id asc offset $2::integer limit $3::integer`;
  return await client.unsafe(query, [projectId, start, pageSize]) as unknown as OracleRow[];
}

async function expectedReplacementWindow(client: postgres.Sql, projectId: string, claimId: string, placedSequence: string, currentRevisionId: string, start: number, pageSize = PAGE_SIZE): Promise<OracleRow[]> {
  const query = `select id::text as id, claim_id::text as claim_id, sequence::text as sequence,
      $5::uuid as current_revision_id
    from claim_revisions
    where project_id=$1::uuid and claim_id=$2::uuid and finalized_at is not null
      and state='active' and sequence>$3::bigint
    order by sequence desc, id asc offset $4::integer limit $6::integer`;
  return await client.unsafe(query, [projectId, claimId, placedSequence, start, currentRevisionId, pageSize]) as unknown as OracleRow[];
}

async function measurePage<T>(db: Database, read: (executor: Pick<Database, "execute">) => Promise<T>): Promise<{ value: T; wallTimeMs: number; statementCount: number; selectCount: number; driverRows: number; driverUtf8Bytes: number; dtoUtf8Bytes: number; queries: CapturedQuery[] }> {
  sink.queries.length = 0;
  let driverRows = 0;
  let driverUtf8Bytes = 0;
  const started = process.hrtime.bigint();
  const value = await db.transaction(async (tx) => read({
    execute: async (query: Parameters<Database["execute"]>[0]) => {
      const result = await tx.execute(query);
      const rows = Array.isArray(result) ? result : [];
      driverRows += rows.length;
      driverUtf8Bytes += utf8Bytes(rows);
      return result;
    },
  }), { isolationLevel: "repeatable read", accessMode: "read only" });
  const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const queries = [...sink.queries];
  return { value, wallTimeMs, statementCount: queries.length, selectCount: selectQueries(queries).length, driverRows, driverUtf8Bytes, dtoUtf8Bytes: utf8Bytes(value), queries };
}

async function createBrowseScope(services: ReturnType<typeof createReviewServices>, title: string): Promise<Scope> {
  const project = await services.createProject({ title: `Slice 54 benchmark ${title}` });
  const manuscript = await services.getOrCreateDefaultManuscript(project.id);
  const section = await services.createSection(project.id, manuscript.id, { title: "Candidate benchmark" });
  return { projectId: project.id, manuscriptId: manuscript.id, sectionId: section.id };
}

async function finalizeDraftClaimRevisions(client: postgres.Sql, projectId: string) {
  setDiagnosticContext("finalize-draft-claim-revisions");
  await client.unsafe("update claim_revisions set finalized_at=now() where project_id=$1::uuid and finalized_at is null", [projectId]);
}

async function seedProjectProfile(client: postgres.Sql, scope: Scope, size: number, profile: Profile) {
  let withdrawnParents = 0;
  let eligibleRows = size;
  let physicalRevisions = size;
  if (profile === "deep-histories") {
    setDiagnosticContext("seed-deep-history-claim", `${profile}/${size}`);
    const claims = await client.unsafe("insert into claims(project_id) values($1::uuid) returning id::text as id", [scope.projectId]) as unknown as Array<{ id: string }>;
    setDiagnosticContext("seed-deep-history-revision-drafts", `${profile}/${size}`);
    await client.unsafe(`insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
      select $1::uuid,$2::uuid,'active','Deep history revision '||g.n::text,null
      from generate_series(1,$3::integer) g(n)`, [scope.projectId, claims[0].id, size]);
    await finalizeDraftClaimRevisions(client, scope.projectId);
  } else if (profile === "ties") {
    setDiagnosticContext("seed-tied-claims", `${profile}/${size}`);
    await client.unsafe("insert into claims(project_id) select $1::uuid from generate_series(1,$2::integer)", [scope.projectId, size - 2]);
    setDiagnosticContext("seed-tied-revision-drafts", `${profile}/${size}`);
    await client.unsafe(`insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
      select $1::uuid,c.id,'active','Tied sequence benchmark',null
      from (select id from claims where project_id=$1::uuid order by id limit $2::integer) c`, [scope.projectId, size - 2]);
    await finalizeDraftClaimRevisions(client, scope.projectId);
    const selected = await client.unsafe(`select id::text as id, claim_id::text as claim_id,
        ((select max(sequence) from claim_revisions where project_id=$1::uuid)+100)::bigint as tie_sequence
      from claim_revisions where project_id=$1::uuid order by sequence desc,id asc limit 1`, [scope.projectId]) as unknown as Array<{ id: string; claim_id: string; tie_sequence: string }>;
    setDiagnosticContext("seed-tied-revision-drafts", `${profile}/${size}`);
    await client.unsafe(`insert into claim_revisions(sequence,project_id,claim_id,state,claim_text,finalized_at)
      overriding system value values
      ($1::bigint,$2::uuid,$3::uuid,'active','Tied sequence benchmark A',null),
      ($1::bigint,$2::uuid,$3::uuid,'active','Tied sequence benchmark B',null)`, [selected[0].tie_sequence, scope.projectId, selected[0].claim_id]);
    await finalizeDraftClaimRevisions(client, scope.projectId);
  } else {
    if (profile === "active-heavy") withdrawnParents = Math.round(size * 0.05);
    else if (profile === "withdrawn-heavy") withdrawnParents = Math.round(size * 0.45);
    else if (profile === "clustered-withdrawn-tail") withdrawnParents = Math.round(size * 0.2);
    else if (profile === "zero-eligible") withdrawnParents = Math.floor(size / 2);
    const candidateClaims = size - withdrawnParents;
    eligibleRows = profile === "zero-eligible" ? 0 : size - (withdrawnParents * 2);
    setDiagnosticContext("seed-project-claims", `${profile}/${size}`);
    await client.unsafe("insert into claims(project_id) select $1::uuid from generate_series(1,$2::integer)", [scope.projectId, candidateClaims]);
    setDiagnosticContext("seed-project-revision-drafts", `${profile}/${size}`);
    await client.unsafe(`insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
      select $1::uuid,c.id,'active','Candidate benchmark revision',null
      from (select id from claims where project_id=$1::uuid order by id) c`, [scope.projectId]);
    if (profile === "text-10000-codepoints") {
      setDiagnosticContext("seed-text-stress-revisions", `${profile}/${size}`);
      await client.unsafe(`with maximum_candidates as materialized (
          select id from claim_revisions where project_id=$1::uuid order by sequence desc,id asc limit ${PAGE_SIZE}
        ) update claim_revisions revision set claim_text=repeat($2::text,$3::integer)
        from maximum_candidates where revision.project_id=$1::uuid and revision.id=maximum_candidates.id`, [scope.projectId, "😀", TEXT_STRESS_CODE_POINTS]);
    }
    await finalizeDraftClaimRevisions(client, scope.projectId);
    if (withdrawnParents > 0) {
      const rankCondition = profile === "clustered-withdrawn-tail"
        ? "ranked.ordinal > floor(ranked.candidate_count::numeric / 2) and ranked.ordinal <= floor(ranked.candidate_count::numeric / 2) + $2::integer"
        : "ranked.ordinal <= $2::integer";
      setDiagnosticContext("seed-withdrawn-parent-revision-drafts", `${profile}/${size}`);
      const inserted = await client.unsafe(`with ranked as materialized (
          select claim_id,row_number() over(order by sequence desc,id asc) as ordinal,count(*) over()::integer as candidate_count
          from claim_revisions where project_id=$1::uuid and state='active' and finalized_at is not null
        )
        insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
        select $1::uuid,ranked.claim_id,'withdrawn',null,null
        from ranked where ${rankCondition}`, [scope.projectId, withdrawnParents]);
      if (inserted.count !== withdrawnParents) throw new Error(`Expected ${withdrawnParents} withdrawn parents in ${profile}; inserted ${inserted.count}.`);
      await finalizeDraftClaimRevisions(client, scope.projectId);
    }
    if (profile === "text-10000-codepoints") physicalRevisions = size;
  }
  if (profile === "ties") physicalRevisions = size;
  if (profile === "zero-eligible") physicalRevisions = size;
  await client.unsafe("analyze claims");
  await client.unsafe("analyze claim_revisions");
  const tie = profile === "ties"
    ? await client.unsafe("select max(sequence)::text as sequence from claim_revisions where project_id=$1::uuid", [scope.projectId]) as unknown as Array<{ sequence: string }>
    : null;
  return { requestedRevisionPopulation: size, physicalRevisions, activeHistoricalCandidateRows: size - withdrawnParents, withdrawnParents, eligibleRows, profile, ambiguousCurrentSequence: tie?.[0]?.sequence ?? null };
}

async function measureProjectPage(args: {
  client: postgres.Sql;
  db: Database;
  read: ReturnType<typeof createManuscriptClaimSelectionReadServices>;
  scope: Scope;
  profile: Profile;
  startOffset: number;
  label: string;
  eligibleRows: number;
  ambiguousCurrentSequence: string | null;
}) {
  const { client, db, read, scope, profile, startOffset, label, eligibleRows, ambiguousCurrentSequence } = args;
  setDiagnosticContext(`project-page:${label}`, `${profile}/${eligibleRows}`);
  const cursor = startOffset > 0 ? await cursorAtOffset(client, scope, startOffset - 1, "placement") : null;
  const measured = await measurePage(db, (executor) => read.getPlacementClaimRevisionPage(scope.projectId, scope.sectionId, { pageSize: PAGE_SIZE, cursor }, executor as never));
  const page = (measured.value as Awaited<ReturnType<typeof read.getPlacementClaimRevisionPage>>).page;
  const query = selectQueries(measured.queries).at(-1) ?? null;
  if (measured.selectCount !== 2) throw new Error(`${profile}.${label} must execute two SELECTs; saw ${measured.selectCount}.`);
  const plan = query ? await explain(client, query) : null;
  const oracle = await expectedProjectWindow(client, scope.projectId, startOffset);
  const equivalent = page.items.length === oracle.length && page.items.every((item, index) => {
    const row = oracle[index];
    const exactIdentity = item.claimRevisionId === row.id && item.claimId === row.claim_id && item.sequence === row.sequence;
    const currentMatches = item.sequence === ambiguousCurrentSequence || item.isCurrent === (row.current_revision_id === row.id);
    return exactIdentity && currentMatches;
  });
  if (!equivalent) throw new Error(`${profile}.${label} differs from direct SQL key oracle.`);
  const currentnessSkippedAmbiguousTieRows = page.items.filter((item) => item.sequence === args.ambiguousCurrentSequence).length;
  if (measured.driverRows !== page.items.length + 1) throw new Error(`${profile}.${label} hydrated unexpected driver rows.`);
  if (page.hasMore !== (eligibleRows > startOffset + PAGE_SIZE)) throw new Error(`${profile}.${label} sentinel state differs from the eligible population.`);
  if (profile === "text-10000-codepoints" && label === "first") {
    if (measured.dtoUtf8Bytes > MAX_DTO_BYTES) throw new Error(`Maximum page payload ${measured.dtoUtf8Bytes} exceeds ${MAX_DTO_BYTES} UTF-8 bytes.`);
    if (page.items.length !== PAGE_SIZE || page.items.some((item) => !item.textTruncated || [...item.textPreview].length !== 600)) throw new Error("Maximum-text candidate page did not apply SQL truncation to every visible summary.");
  }
  return {
    label,
    startOffset,
    wallTimeMs: measured.wallTimeMs,
    statementCount: measured.statementCount,
    selectCount: measured.selectCount,
    driverRows: measured.driverRows,
    driverUtf8Bytes: measured.driverUtf8Bytes,
    dtoUtf8Bytes: measured.dtoUtf8Bytes,
    visibleRows: page.items.length,
    hasMore: page.hasMore,
    sentinelHydrated: false as const,
    equivalentToOracle: true,
    currentnessCompared: currentnessSkippedAmbiguousTieRows === 0,
    currentnessComparedRows: page.items.length - currentnessSkippedAmbiguousTieRows,
    currentnessSkippedAmbiguousTieRows,
    visibleItems: page.items.map((item) => ({ id: item.claimRevisionId, claimId: item.claimId, sequence: item.sequence, isCurrent: item.isCurrent })),
    query,
    explain: plan,
    eligibleRows,
  } satisfies PageRun & { eligibleRows: number };
}

async function measureLegacyFullSelector(services: ReturnType<typeof createReviewServices>, projectId: string, size: number) {
  if (size > LEGACY_MAX_SIZE) return { status: "not_run_safety_bound" as const, maximumMeasuredPopulation: LEGACY_MAX_SIZE, statementCount: 0, selectCount: 0, driverRows: 0, dtoUtf8Bytes: null, wallTimeMs: null };
  sink.queries.length = 0;
  directDriver.rows = 0;
  directDriver.utf8Bytes = 0;
  const started = process.hrtime.bigint();
  const rows = await services.listPlaceableClaimRevisions(projectId) as LegacyRow[];
  const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const queries = [...sink.queries];
  return { status: "completed" as const, statementCount: queries.length, selectCount: selectQueries(queries).length, driverRows: directDriver.rows, driverUtf8Bytes: directDriver.utf8Bytes, materializedDtoRows: rows.length, dtoUtf8Bytes: utf8Bytes(rows), wallTimeMs, rows };
}

async function benchmarkProjectProfile(args: {
  client: postgres.Sql;
  db: Database;
  services: ReturnType<typeof createReviewServices>;
  read: ReturnType<typeof createManuscriptClaimSelectionReadServices>;
  scope: Scope;
  size: number;
  profile: Profile;
}) {
  const { client, db, services, read, scope, size, profile } = args;
  setDiagnosticContext("project-fixture-seed", `${profile}/${size}`);
  const distribution = await seedProjectProfile(client, scope, size, profile);
  const starts = [
    { label: "first", start: 0 },
    { label: "deep", start: distribution.eligibleRows > PAGE_SIZE ? Math.floor(distribution.eligibleRows / 2) : 0 },
    { label: "final", start: Math.max(0, distribution.eligibleRows - PAGE_SIZE) },
  ];
  const pages: Array<PageRun & { eligibleRows: number }> = [];
  for (const target of starts) pages.push(await measureProjectPage({ client, db, read, scope, profile, label: target.label, startOffset: target.start, eligibleRows: distribution.eligibleRows, ambiguousCurrentSequence: distribution.ambiguousCurrentSequence }));
  const legacy = await measureLegacyFullSelector(services, scope.projectId, size);
  let legacyEquivalence: boolean | null = null;
  if (legacy.status === "completed") {
    legacyEquivalence = pages.every((page) => {
      const expected = legacy.rows.slice(page.startOffset, page.startOffset + PAGE_SIZE);
      return expected.length === page.visibleItems.length && expected.every((row, index) => {
        const actual = page.visibleItems[index];
        return row.id === actual.id && row.claimId === actual.claimId && String(row.sequence) === actual.sequence
          && (distribution.ambiguousCurrentSequence === String(row.sequence) || row.isCurrent === actual.isCurrent);
      });
    });
    if (!legacyEquivalence) throw new Error(`${profile}.${size} bounded pages differ from the compatibility selector.`);
  }
  const publicPages = pages.map(omitVisibleItems);
  return {
    projectId: scope.projectId,
    ...distribution,
    pages: publicPages,
    legacyFullSelector: legacy.status === "completed" ? { status: legacy.status, statementCount: legacy.statementCount, selectCount: legacy.selectCount, driverRows: legacy.driverRows, driverUtf8Bytes: legacy.driverUtf8Bytes, materializedDtoRows: legacy.materializedDtoRows, dtoUtf8Bytes: legacy.dtoUtf8Bytes, wallTimeMs: legacy.wallTimeMs } : legacy,
    legacyEquivalence,
  };
}

async function seedReplacementProject(client: postgres.Sql, services: ReturnType<typeof createReviewServices>, size: number) {
  const scope = await createBrowseScope(services, `replacement-${size}`);
  const original = await services.createClaim(scope.projectId, { claimText: "Replacement original" });
  const claimId = original.id;
  const firstRevisionId = original.revision.id;
  const firstSequence = String(original.revision.sequence);
  setDiagnosticContext("seed-replacement-revision-drafts", `replacement/${size}`);
  await client.unsafe(`insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
    select $1::uuid,$2::uuid,'active','Replacement history revision '||g.n::text,null
    from generate_series(2,$3::integer) g(n)`, [scope.projectId, claimId, size]);
  await finalizeDraftClaimRevisions(client, scope.projectId);
  const current = await client.unsafe("select id::text as id from claim_revisions where project_id=$1::uuid and claim_id=$2::uuid order by sequence desc limit 1", [scope.projectId, claimId]) as unknown as Array<{ id: string }>;
  const placement = await services.placeClaimRevision(scope.projectId, scope.manuscriptId, scope.sectionId, firstRevisionId);
  await client.unsafe("analyze claims");
  await client.unsafe("analyze claim_revisions");
  return { scope, claimId, placementId: placement.id, placedRevisionId: firstRevisionId, placedSequence: firstSequence, currentRevisionId: current[0].id, candidateRows: size - 1, requestedRevisionPopulation: size };
}

async function measureReplacementPage(args: {
  client: postgres.Sql;
  db: Database;
  read: ReturnType<typeof createManuscriptClaimSelectionReadServices>;
  fixture: Awaited<ReturnType<typeof seedReplacementProject>>;
  startOffset: number;
  label: string;
}) {
  const { client, db, read, fixture, startOffset, label } = args;
  setDiagnosticContext(`replacement-page:${label}`, `replacement/${fixture.requestedRevisionPopulation}`);
  const cursor = startOffset > 0 ? await cursorAtOffset(client, fixture.scope, startOffset - 1, "replacement", fixture) : null;
  const measured = await measurePage(db, (executor) => read.getPlacementReplacementClaimRevisionPage(fixture.scope.projectId, fixture.placementId, { pageSize: PAGE_SIZE, cursor }, executor as never));
  const value = measured.value as Awaited<ReturnType<typeof read.getPlacementReplacementClaimRevisionPage>>;
  const query = selectQueries(measured.queries).at(-1) ?? null;
  if (measured.selectCount !== 2) throw new Error(`replacement.${label} must execute two SELECTs; saw ${measured.selectCount}.`);
  const plan = query ? await explain(client, query) : null;
  const oracle = await expectedReplacementWindow(client, fixture.scope.projectId, fixture.claimId, fixture.placedSequence, fixture.currentRevisionId, startOffset);
  const equivalent = value.page.items.length === oracle.length && value.page.items.every((item, index) => item.claimRevisionId === oracle[index].id && item.claimId === oracle[index].claim_id && item.sequence === oracle[index].sequence && item.isCurrent === (oracle[index].current_revision_id === oracle[index].id));
  if (!equivalent) throw new Error(`replacement.${label} differs from direct SQL key oracle.`);
  if (measured.driverRows !== value.page.items.length + 1) throw new Error(`replacement.${label} hydrated unexpected driver rows.`);
  if (value.page.hasMore !== (fixture.candidateRows > startOffset + PAGE_SIZE)) throw new Error(`replacement.${label} sentinel state differs from the eligible population.`);
  return {
    label,
    startOffset,
    wallTimeMs: measured.wallTimeMs,
    statementCount: measured.statementCount,
    selectCount: measured.selectCount,
    driverRows: measured.driverRows,
    driverUtf8Bytes: measured.driverUtf8Bytes,
    dtoUtf8Bytes: measured.dtoUtf8Bytes,
    visibleRows: value.page.items.length,
    hasMore: value.page.hasMore,
    sentinelHydrated: false as const,
    equivalentToOracle: true,
    currentnessCompared: true,
    currentnessComparedRows: value.page.items.length,
    currentnessSkippedAmbiguousTieRows: 0,
    visibleItems: value.page.items.map((item) => ({ id: item.claimRevisionId, claimId: item.claimId, sequence: item.sequence, isCurrent: item.isCurrent })),
    query,
    explain: plan,
  } satisfies PageRun;
}

async function benchmarkReplacement(args: { client: postgres.Sql; db: Database; services: ReturnType<typeof createReviewServices>; read: ReturnType<typeof createManuscriptClaimSelectionReadServices>; size: number }) {
  const { client, db, services, read, size } = args;
  const fixture = await seedReplacementProject(client, services, size);
  const starts = [0, Math.floor(fixture.candidateRows / 2), Math.max(0, fixture.candidateRows - PAGE_SIZE)];
  const labels = ["first", "deep", "final"];
  const pages: PageRun[] = [];
  for (let index = 0; index < starts.length; index += 1) pages.push(await measureReplacementPage({ client, db, read, fixture, startOffset: starts[index], label: labels[index] }));
  const legacy = await measureLegacyFullSelector(services, fixture.scope.projectId, size);
  let legacyEquivalence: boolean | null = null;
  if (legacy.status === "completed") {
    const expected = legacy.rows.filter((row) => row.claimId === fixture.claimId && String(row.sequence) > fixture.placedSequence);
    legacyEquivalence = pages.every((page) => {
      const pageExpected = expected.slice(page.startOffset, page.startOffset + PAGE_SIZE);
      return pageExpected.length === page.visibleItems.length && pageExpected.every((row, index) => {
        const actual = page.visibleItems[index];
        return row.id === actual.id && row.claimId === actual.claimId && String(row.sequence) === actual.sequence && row.isCurrent === actual.isCurrent;
      });
    });
    if (expected.length !== fixture.candidateRows) legacyEquivalence = false;
    if (!legacyEquivalence) throw new Error(`replacement.${size} bounded pages differ from the compatibility selector subset.`);
  }
  const publicPages = pages.map(omitVisibleItems);
  return {
    projectId: fixture.scope.projectId,
    claimId: fixture.claimId,
    placementId: fixture.placementId,
    requestedRevisionPopulation: size,
    physicalRevisions: size,
    candidateRows: fixture.candidateRows,
    pages: publicPages,
    indexEvidenceQuery: pages[0]?.query ?? null,
    legacyFullSelector: legacy.status === "completed" ? { status: legacy.status, statementCount: legacy.statementCount, selectCount: legacy.selectCount, driverRows: legacy.driverRows, driverUtf8Bytes: legacy.driverUtf8Bytes, materializedDtoRows: legacy.materializedDtoRows, dtoUtf8Bytes: legacy.dtoUtf8Bytes, wallTimeMs: legacy.wallTimeMs } : legacy,
    legacyEquivalence,
  };
}

async function benchmarkScopeTitlePayloadStress(args: {
  client: postgres.Sql;
  db: Database;
  services: ReturnType<typeof createReviewServices>;
  read: ReturnType<typeof createManuscriptClaimSelectionReadServices>;
}) {
  const { client, db, services, read } = args;
  const scope = await createBrowseScope(services, "scope-title-payload-stress");
  const longTitle = "😀".repeat(SCOPE_TITLE_STRESS_CODE_POINTS);
  setDiagnosticContext("seed-long-scope-titles", "scope-title-payload-stress/50");
  await client.unsafe("update manuscripts set title=$1 where project_id=$2::uuid and id=$3::uuid", [longTitle, scope.projectId, scope.manuscriptId]);
  await client.unsafe("update manuscript_sections set title=$1 where project_id=$2::uuid and id=$3::uuid", [longTitle, scope.projectId, scope.sectionId]);

  setDiagnosticContext("seed-long-scope-project-candidates", "scope-title-payload-stress/50");
  await client.unsafe("insert into claims(project_id) select $1::uuid from generate_series(1,51)", [scope.projectId]);
  await client.unsafe(`insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
    select $1::uuid,c.id,'active',repeat($2::text,$3::integer),null
    from claims c where c.project_id=$1::uuid`, [scope.projectId, "😀", 700]);
  await finalizeDraftClaimRevisions(client, scope.projectId);
  const projectMeasurement = await measurePage(db, (executor) => read.getPlacementClaimRevisionPage(
    scope.projectId,
    scope.sectionId,
    { pageSize: PAGE_SIZE },
    executor as never,
  ));
  const projectPage = projectMeasurement.value as Awaited<ReturnType<typeof read.getPlacementClaimRevisionPage>>;
  if (projectMeasurement.selectCount !== 2 || projectMeasurement.driverRows !== PAGE_SIZE + 1) throw new Error("Long-title project page exceeded the two-SELECT/visible-summary budget.");
  if (projectMeasurement.dtoUtf8Bytes > MAX_DTO_BYTES || projectPage.page.items.length !== PAGE_SIZE || !projectPage.page.hasMore) throw new Error("Long-title project page violated its maximum-page payload or sentinel contract.");
  if ([...projectPage.manuscript.title].length !== 600 || [...projectPage.section.title].length !== 600) throw new Error("Project selector scope titles were not truncated to 600 code points.");
  if (projectPage.page.items.some((item) => [...item.textPreview].length !== 600 || !item.textTruncated)) throw new Error("Long-title project page failed SQL-truncated maximum text previews.");

  const replacementClaim = await services.createClaim(scope.projectId, { claimText: "Long-title replacement payload base" });
  const placement = await services.placeClaimRevision(scope.projectId, scope.manuscriptId, scope.sectionId, replacementClaim.revision.id);
  setDiagnosticContext("seed-long-scope-replacement-candidates", "scope-title-payload-stress/50");
  await client.unsafe(`insert into claim_revisions(project_id,claim_id,state,claim_text,finalized_at)
    select $1::uuid,$2::uuid,'active',repeat($3::text,$4::integer),null
    from generate_series(1,51)`, [scope.projectId, replacementClaim.id, "😀", 700]);
  await client.unsafe("update claim_revisions set finalized_at=now() where project_id=$1::uuid and claim_id=$2::uuid and finalized_at is null", [scope.projectId, replacementClaim.id]);
  const replacementMeasurement = await measurePage(db, (executor) => read.getPlacementReplacementClaimRevisionPage(
    scope.projectId,
    placement.id,
    { pageSize: PAGE_SIZE },
    executor as never,
  ));
  const replacementPage = replacementMeasurement.value as Awaited<ReturnType<typeof read.getPlacementReplacementClaimRevisionPage>>;
  if (replacementMeasurement.selectCount !== 2 || replacementMeasurement.driverRows !== PAGE_SIZE + 1) throw new Error("Long-title replacement page exceeded the two-SELECT/visible-summary budget.");
  if (replacementMeasurement.dtoUtf8Bytes > MAX_DTO_BYTES || replacementPage.page.items.length !== PAGE_SIZE || !replacementPage.page.hasMore) throw new Error("Long-title replacement page violated its maximum-page payload or sentinel contract.");
  if ([...replacementPage.manuscript.title].length !== 600 || [...replacementPage.placement.sectionTitle].length !== 600) throw new Error("Replacement selector scope titles were not truncated to 600 code points.");
  if (replacementPage.page.items.some((item) => [...item.textPreview].length !== 600 || !item.textTruncated)) throw new Error("Long-title replacement page failed SQL-truncated maximum text previews.");

  return {
    sourceScopeTitleCodePoints: SCOPE_TITLE_STRESS_CODE_POINTS,
    returnedScopeTitleCodePointLimit: 600,
    pageSize: PAGE_SIZE,
    maximumClaimTextPreviewCodePoints: 600,
    claimTextSourceCodePoints: 700,
    candidatePreviewSentinelHydrated: false,
    projectWide: {
      selectCount: projectMeasurement.selectCount,
      driverRows: projectMeasurement.driverRows,
      dtoUtf8Bytes: projectMeasurement.dtoUtf8Bytes,
      visibleRows: projectPage.page.items.length,
      hasMore: projectPage.page.hasMore,
      manuscriptTitleCodePoints: [...projectPage.manuscript.title].length,
      sectionTitleCodePoints: [...projectPage.section.title].length,
    },
    replacement: {
      selectCount: replacementMeasurement.selectCount,
      driverRows: replacementMeasurement.driverRows,
      dtoUtf8Bytes: replacementMeasurement.dtoUtf8Bytes,
      visibleRows: replacementPage.page.items.length,
      hasMore: replacementPage.page.hasMore,
      manuscriptTitleCodePoints: [...replacementPage.manuscript.title].length,
      sectionTitleCodePoints: [...replacementPage.placement.sectionTitle].length,
    },
    maximumDtoUtf8Bytes: Math.max(projectMeasurement.dtoUtf8Bytes, replacementMeasurement.dtoUtf8Bytes),
    dtoLimitUtf8Bytes: MAX_DTO_BYTES,
    allDtosWithinLimit: true,
    allVisiblePreviewsTruncatedInSql: true,
    sentinelNotHydrated: true,
  };
}

async function benchmarkBigintBoundary(client: postgres.Sql, db: Database, services: ReturnType<typeof createReviewServices>, read: ReturnType<typeof createManuscriptClaimSelectionReadServices>) {
  const scope = await createBrowseScope(services, "bigint-boundary");
  const claim = await services.createClaim(scope.projectId, { claimText: "ClaimRevision sequence above JavaScript safe integer" });
  setDiagnosticContext("seed-bigint-revision-drafts", "BIGINT boundary");
  await client.unsafe(`insert into claim_revisions(sequence,project_id,claim_id,state,claim_text,finalized_at)
    overriding system value
    select g.sequence,$1::uuid,$2::uuid,'active','Exact BIGINT selector revision '||g.sequence::text,null
    from generate_series($3::bigint,$4::bigint) as g(sequence)`, [scope.projectId, claim.id, "9007199254740992", "9007199254741015"]);
  await client.unsafe(`update claim_revisions set finalized_at=now()
    where project_id=$1::uuid and claim_id=$2::uuid and sequence between $3::bigint and $4::bigint and finalized_at is null`, [scope.projectId, claim.id, "9007199254740992", "9007199254741015"]);
  const latest = await client.unsafe("select id::text as id from claim_revisions where project_id=$1::uuid and claim_id=$2::uuid order by sequence desc limit 1", [scope.projectId, claim.id]) as unknown as Array<{ id: string }>;
  const placement = await services.placeClaimRevision(scope.projectId, scope.manuscriptId, scope.sectionId, claim.revision.id);
  const pageSize = 10;

  async function walkPlacement() {
    const items: Array<{ id: string; claimId: string; sequence: string; isCurrent: boolean }> = [];
    const pages: Array<{ selectCount: number; driverRows: number; dtoUtf8Bytes: number }> = [];
    let cursor: string | null = null;
    do {
      const measured = await measurePage(db, (executor) => read.getPlacementClaimRevisionPage(scope.projectId, scope.sectionId, { pageSize, cursor }, executor as never));
      const value = measured.value as Awaited<ReturnType<typeof read.getPlacementClaimRevisionPage>>;
      const expected = await expectedProjectWindow(client, scope.projectId, items.length, pageSize);
      if (measured.selectCount !== 2 || measured.driverRows !== value.page.items.length + 1) throw new Error("BIGINT project selection exceeded its two-SELECT/visible-row budget.");
      if (value.page.items.length !== expected.length || value.page.items.some((item, index) => item.claimRevisionId !== expected[index].id || item.claimId !== expected[index].claim_id || item.sequence !== expected[index].sequence || item.isCurrent !== (expected[index].current_revision_id === expected[index].id))) throw new Error("BIGINT project selection differs from exact SQL sequence expectations.");
      items.push(...value.page.items.map((item) => ({ id: item.claimRevisionId, claimId: item.claimId, sequence: item.sequence, isCurrent: item.isCurrent })));
      pages.push({ selectCount: measured.selectCount, driverRows: measured.driverRows, dtoUtf8Bytes: measured.dtoUtf8Bytes });
      cursor = value.page.nextCursor;
    } while (cursor);
    return { items, pages };
  }

  async function walkReplacement() {
    const items: Array<{ id: string; claimId: string; sequence: string; isCurrent: boolean }> = [];
    const pages: Array<{ selectCount: number; driverRows: number; dtoUtf8Bytes: number }> = [];
    let cursor: string | null = null;
    do {
      const measured = await measurePage(db, (executor) => read.getPlacementReplacementClaimRevisionPage(scope.projectId, placement.id, { pageSize, cursor }, executor as never));
      const value = measured.value as Awaited<ReturnType<typeof read.getPlacementReplacementClaimRevisionPage>>;
      const expected = await expectedReplacementWindow(client, scope.projectId, claim.id, String(claim.revision.sequence), latest[0].id, items.length, pageSize);
      if (measured.selectCount !== 2 || measured.driverRows !== value.page.items.length + 1) throw new Error("BIGINT replacement selection exceeded its two-SELECT/visible-row budget.");
      if (value.page.items.length !== expected.length || value.page.items.some((item, index) => item.claimRevisionId !== expected[index].id || item.claimId !== expected[index].claim_id || item.sequence !== expected[index].sequence || item.isCurrent !== (expected[index].current_revision_id === expected[index].id))) throw new Error("BIGINT replacement selection differs from exact SQL sequence expectations.");
      items.push(...value.page.items.map((item) => ({ id: item.claimRevisionId, claimId: item.claimId, sequence: item.sequence, isCurrent: item.isCurrent })));
      pages.push({ selectCount: measured.selectCount, driverRows: measured.driverRows, dtoUtf8Bytes: measured.dtoUtf8Bytes });
      cursor = value.page.nextCursor;
    } while (cursor);
    return { items, pages };
  }

  const project = await walkPlacement();
  const replacement = await walkReplacement();
  if (project.items.some((item) => typeof item.sequence !== "string") || replacement.items.some((item) => typeof item.sequence !== "string")) throw new Error("BIGINT sequence DTO crossed the wire as a non-string.");
  if (!project.items.some((item) => item.sequence === "9007199254740992") || !replacement.items.some((item) => item.sequence === "9007199254740993")) throw new Error("BIGINT boundary values were not preserved exactly.");
  return {
    projectId: scope.projectId,
    placementId: placement.id,
    oldSequence: String(claim.revision.sequence),
    expectedBoundary: "9007199254740992",
    projectWide: { rows: project.items.length, pages: project.pages, sequences: project.items.map((item) => item.sequence) },
    replacement: { rows: replacement.items.length, pages: replacement.pages, sequences: replacement.items.map((item) => item.sequence) },
    exactSqlExpectationsPassed: true,
    legacyNumericOracleUsed: false,
  };
}

async function indexEvidence(client: postgres.Sql, queries: Array<{ label: string; query: CapturedQuery }>, indexName: string, createSql: string) {
  await client.unsafe(`drop index if exists ${quoteIdentifier(indexName)}`);
  await client.unsafe("analyze claim_revisions");
  const before: Array<{ label: string; diagnosticWallTimeMs: number; sqlUtf8Bytes: number; plan: ReturnType<typeof summarisePlan> }> = [];
  for (const item of queries) before.push({ label: item.label, ...await explain(client, item.query) });
  await client.unsafe(createSql);
  await client.unsafe("analyze claim_revisions");
  const after: Array<{ label: string; diagnosticWallTimeMs: number; sqlUtf8Bytes: number; plan: ReturnType<typeof summarisePlan> }> = [];
  for (const item of queries) after.push({ label: item.label, ...await explain(client, item.query) });
  const sizeRows = await client.unsafe("select pg_relation_size($1::regclass)::bigint::text as bytes", [indexName]) as unknown as Array<{ bytes: string }>;
  await client.unsafe(`drop index if exists ${quoteIdentifier(indexName)}`);
  await client.unsafe("analyze claim_revisions");
  return { candidateIndex: indexName, queryLabels: queries.map(({ label }) => label), before, after, temporaryIndexBytes: String(sizeRows[0]?.bytes ?? "0"), droppedAfterComparison: true };
}

async function main() {
  const scenarioArg = process.argv.slice(2).find((argument) => argument.startsWith("--scenario="));
  const scopeTitleStressOnly = process.argv.includes("--scope-title-payload-stress-only");
  if (scopeTitleStressOnly && scenarioArg) throw new Error("Use either --scenario or --scope-title-payload-stress-only, not both.");
  const scenarioMatch = scenarioArg?.match(/^--scenario=(active-heavy|withdrawn-heavy|clustered-withdrawn-tail|deep-histories|ties|text-10000-codepoints|zero-eligible):(1000|10000|50000)$/);
  if (scenarioArg && !scenarioMatch) throw new Error("Diagnostic scenario must use --scenario=<profile>:<1000|10000|50000>.");
  const diagnosticScenario = scenarioMatch
    ? { profile: scenarioMatch[1] as Profile, size: Number(scenarioMatch[2]) }
    : null;
  const scenarioLabel = diagnosticScenario ? `${diagnosticScenario.profile}/${diagnosticScenario.size}` : scopeTitleStressOnly ? "scope-title-payload-stress/50" : undefined;
  setDiagnosticContext("node-version-check", scenarioLabel);
  if (process.versions.node !== "22.13.0") throw new Error(`Requires Node 22.13.0; running ${process.versions.node}.`);
  setDiagnosticContext("database-url-preflight", scenarioLabel);
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role permitted to create and drop a uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_slice54_claim_selection_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  let cleanupVerified = false;
  const experimentalIndexes = [PROJECT_INDEX, REPLACEMENT_INDEX];
  try {
    setDiagnosticContext("postgres-version-preflight", scenarioLabel);
    const server = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const versionNumber = Number(server[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; connected server version number is ${versionNumber}.`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;
    setDiagnosticContext("migrations", scenarioLabel);
    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }
    client = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await client.unsafe(`set statement_timeout = '${DIAGNOSTIC_TIMEOUT_MS}ms'`);
    const db = captureDatabase(client);
    const services = createReviewServices(db);
    const read = createManuscriptClaimSelectionReadServices(db);
    const projectResults: unknown[] = [];
    const projectProfiles: Profile[] = ["active-heavy", "withdrawn-heavy", "clustered-withdrawn-tail", "deep-histories", "ties", "text-10000-codepoints", "zero-eligible"];
    let indexProjectQueries: Array<{ label: string; query: CapturedQuery }> | null = null;
    let indexReplacementQueries: Array<{ label: string; query: CapturedQuery }> | null = null;
    console.log(JSON.stringify({
      benchmark: "Slice 54 manuscript ClaimRevision placement and replacement selection",
      node: process.versions.node,
      postgresMajor: 16,
      database: "uniquely named disposable database; force-dropped and verified in finally",
      projectRevisionPopulations: PROJECT_SIZES,
      projectProfiles,
      replacementRevisionPopulations: REPLACEMENT_SIZES,
      pageSize: PAGE_SIZE,
      textStressCodePointsPerClaim: TEXT_STRESS_CODE_POINTS,
      scopeTitleStressCodePoints: SCOPE_TITLE_STRESS_CODE_POINTS,
      claimTextLengthNote: "claim_text has no database-wide maximum; this is a documented 10,000-codepoint stress fixture, not a maximum-size claim",
      diagnosticScenario: diagnosticScenario ?? null,
      maximumPageDtoUtf8Bytes: MAX_DTO_BYTES,
      projectAndReplacementPageSelectBudget: 2,
      legacyFullSelectorMaxPopulation: LEGACY_MAX_SIZE,
      fiftyThousandLegacyFullSelector: "not run: legacy selector materializes the full candidate collection; bounded 50k pages use direct SQL key-oracle comparison",
      note: "Timings are diagnostic. Scope/setup SELECTs and cursor-anchor setup are recorded separately from page SELECT budgets. Withdrawn-parent rejection work is reported from EXPLAIN; no O(pageSize) database-work claim is made for adverse parent distributions.",
    }));

    const selectedProjectSizes = scopeTitleStressOnly ? [] : diagnosticScenario ? [diagnosticScenario.size] : PROJECT_SIZES;
    const selectedProjectProfiles = diagnosticScenario ? [diagnosticScenario.profile] : projectProfiles;
    const selectedReplacementSizes = diagnosticScenario || scopeTitleStressOnly ? [] : REPLACEMENT_SIZES;

    for (const size of selectedProjectSizes) {
      for (const profile of selectedProjectProfiles) {
        setDiagnosticContext("project-scope-creation", `${profile}/${size}`);
        const scope = await createBrowseScope(services, `${profile}-${size}`);
        const scenario = await benchmarkProjectProfile({ client, db, services, read, scope, size, profile });
        if (size === 50_000 && profile === "active-heavy") {
          indexProjectQueries = (scenario as { pages: Array<PageRun> }).pages.map((page) => ({ label: page.label, query: page.query! }));
        }
        projectResults.push(scenario);
        console.log(JSON.stringify({ projectScenario: scenario }));
      }
    }

    const replacementResults: unknown[] = [];
    for (const size of selectedReplacementSizes) {
      const result = await benchmarkReplacement({ client, db, services, read, size });
      if (size === 50_000) {
        indexReplacementQueries = (result as { pages: Array<PageRun> }).pages.map((page) => ({ label: page.label, query: page.query! }));
      }
      replacementResults.push(result);
      console.log(JSON.stringify({ replacementScenario: result }));
    }

    const scopeTitlePayloadStress = diagnosticScenario ? null : await benchmarkScopeTitlePayloadStress({ client, db, services, read });
    if (scopeTitlePayloadStress) console.log(JSON.stringify({ scopeTitlePayloadStress }));

    if (scopeTitleStressOnly) {
      console.log(JSON.stringify({ scopeTitleStressOnlyComplete: true }));
    } else if (diagnosticScenario) {
      console.log(JSON.stringify({ diagnosticScenarioComplete: { ...diagnosticScenario, projectScenarioCount: projectResults.length, replacementScenarioCount: replacementResults.length } }));
    } else {
      setDiagnosticContext("bigint-boundary-benchmark");
      const bigintBoundary = await benchmarkBigintBoundary(client, db, services, read);
      console.log(JSON.stringify({ bigintBoundary }));

      if (!indexProjectQueries || !indexReplacementQueries || indexProjectQueries.length !== 3 || indexReplacementQueries.length !== 3) throw new Error("First/deep/final 50k project and replacement application SQL was not captured.");
      setDiagnosticContext("project-index-before-after-explain");
      const projectIndexEvidence = await indexEvidence(client, indexProjectQueries, PROJECT_INDEX,
        `create index ${quoteIdentifier(PROJECT_INDEX)} on claim_revisions (project_id, sequence desc, id asc) where finalized_at is not null and state='active'`);
      setDiagnosticContext("replacement-index-before-after-explain");
      const replacementIndexEvidence = await indexEvidence(client, indexReplacementQueries, REPLACEMENT_INDEX,
        `create index ${quoteIdentifier(REPLACEMENT_INDEX)} on claim_revisions (project_id, claim_id, sequence desc, id asc) where finalized_at is not null and state='active'`);
      console.log(JSON.stringify({ indexEvidence: { projectIndexEvidence, replacementIndexEvidence } }));
      console.log(JSON.stringify({ benchmarkSummary: { projectScenarioCount: projectResults.length, replacementScenarioCount: replacementResults.length, bigintBoundary, scopeTitlePayloadStress, projectResults, replacementResults, projectIndexEvidence, replacementIndexEvidence } }));
    }
  } finally {
    if (client) {
      for (const indexName of experimentalIndexes) await client.unsafe(`drop index if exists ${quoteIdentifier(indexName)}`).catch(() => {});
      await client.end({ timeout: 1 });
    }
    try {
      if (created) await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
      const remains = await admin.unsafe("select exists(select 1 from pg_database where datname=$1) as present", [databaseName]) as unknown as Array<{ present: boolean }>;
      cleanupVerified = remains[0]?.present !== true;
      if (!cleanupVerified) throw new Error("Disposable benchmark database remained after cleanup.");
      console.log(JSON.stringify({ phase: "cleanup-complete", droppedOwnBenchmarkDatabase: created, cleanupVerified }));
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
}

main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
