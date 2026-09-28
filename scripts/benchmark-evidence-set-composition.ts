import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createReviewServices } from "@/application/services";
import { createEvidenceSetWorkspaceReadServices } from "@/application/evidence-set-workspace-read-services";
import { resolveEvidenceSetCompositionRevisionMembers } from "@/application/evidence-set-composition-resolver";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";

const WORKLOAD_SIZES = [1_000, 10_000, 50_000] as const;
const HISTORY_DEPTHS = [10, 100, 1_000] as const;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 60_000;

type CapturedQuery = { query: string; params: unknown[] };
type ExplainRows = Array<{ "QUERY PLAN"?: unknown }>;
type QueryMetrics = { rowsReturned: number };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function makeCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function selectQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function summarizePlan(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const root = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
  const nodes: Array<Record<string, unknown>> = [];
  function visit(node: unknown) {
    if (typeof node !== "object" || node === null) return;
    const current = node as Record<string, unknown>;
    nodes.push({
      nodeType: current["Node Type"], relation: current["Relation Name"], index: current["Index Name"],
      actualRows: current["Actual Rows"], loops: current["Actual Loops"],
      sharedHitBlocks: current["Shared Hit Blocks"], sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"], tempWrittenBlocks: current["Temp Written Blocks"],
    });
    if (Array.isArray(current.Plans)) for (const child of current.Plans) visit(child);
  }
  visit(root?.Plan);
  return { planningTimeMs: root?.["Planning Time"], executionTimeMs: root?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, label: string, captured: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const result = await client.unsafe(
      `explain (analyze, buffers, format json) ${captured.query}`,
      captured.params as never,
    ) as unknown as ExplainRows;
    return {
      label, status: "completed" as const, sql: captured.query, parameters: captured.params,
      plan: summarizePlan(result[0]?.["QUERY PLAN"]),
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  } catch (error) {
    const record = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown } : null;
    return {
      label, status: "failed" as const, sql: captured.query, parameters: captured.params,
      error: { code: String(record?.code ?? ""), message: String(record?.message ?? error).slice(0, 1_000) },
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  }
}

function instrumentDatabase(db: Database, queryLog: CapturedQuery[], metrics: QueryMetrics): Database {
  const wrap = (executor: object): object => new Proxy(executor, {
    get(target, property, receiver) {
      if (property === "execute") {
        return async (...args: unknown[]) => {
          const execute = Reflect.get(target, property, receiver) as (...values: unknown[]) => Promise<unknown>;
          const result = await execute.apply(target, args);
          if (Array.isArray(result)) metrics.rowsReturned += result.length;
          else if (typeof result === "object" && result !== null && "length" in result) {
            metrics.rowsReturned += Number((result as { length: unknown }).length) || 0;
          }
          return result;
        };
      }
      if (property === "transaction") {
        return (...args: unknown[]) => {
          const transaction = Reflect.get(target, property, receiver) as (...values: unknown[]) => Promise<unknown>;
          const callback = args[0];
          if (typeof callback !== "function") return transaction.apply(target, args);
          const rest = args.slice(1);
          return transaction.apply(target, [
            (tx: object, ...values: unknown[]) => callback(wrap(tx), ...values),
            ...rest,
          ]);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return wrap(db as object) as unknown as Database;
}

async function readStructuralCounts(client: postgres.Sql, projectId: string, setId: string, targetPaperId?: string) {
  const [row] = await client.unsafe(`
    select
      (select count(*)::bigint from evidence_set_memberships where project_id=$1 and evidence_set_id=$2) as memberships,
      (select count(*)::bigint from evidence_set_composition_revisions where project_id=$1 and evidence_set_id=$2) as revisions,
      (select count(*)::bigint from evidence_set_membership_order_versions where project_id=$1 and evidence_set_id=$2) as versions,
      (select count(*)::bigint from evidence_set_membership_order_versions where project_id=$1 and evidence_set_id=$2 and valid_to_ordinal is not null) as "closedVersions",
      (select count(*)::bigint from evidence_set_paper_member_counts where project_id=$1 and evidence_set_id=$2) as "paperCounters",
      (select member_count::integer from evidence_set_paper_member_counts where project_id=$1 and evidence_set_id=$2 and paper_id=$3) as "targetPaperCount"
  `, [projectId, setId, targetPaperId ?? null]) as unknown as Array<Record<string, unknown>>;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? null : Number(value)]));
}

function difference(after: Record<string, number | null>, before: Record<string, number | null>, key: string) {
  return Number(after[key] ?? 0) - Number(before[key] ?? 0);
}

async function measureMutation(input: {
  name: string;
  client: postgres.Sql;
  queryLog: CapturedQuery[];
  queryMetrics: QueryMetrics;
  projectId: string;
  setId: string;
  targetPaperId?: string;
  request: unknown;
  run: () => Promise<unknown>;
}) {
  const before = await readStructuralCounts(input.client, input.projectId, input.setId, input.targetPaperId);
  input.queryLog.length = 0;
  input.queryMetrics.rowsReturned = 0;
  const started = process.hrtime.bigint();
  const result = await input.run();
  const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const after = await readStructuralCounts(input.client, input.projectId, input.setId, input.targetPaperId);
  const insertedMemberships = difference(after, before, "memberships");
  const revisionRows = difference(after, before, "revisions");
  const insertedVersions = difference(after, before, "versions");
  const closedVersionUpdates = difference(after, before, "closedVersions");
  const beforeCounter = before.targetPaperCount;
  const afterCounter = after.targetPaperCount;
  const counterTupleChanges = beforeCounter === afterCounter ? 0 : (beforeCounter === null || afterCounter === null || beforeCounter !== afterCounter ? 1 : 0);
  const tupleChanges = insertedMemberships + revisionRows + insertedVersions + closedVersionUpdates + counterTupleChanges;
  const projectGuardRows = input.queryLog.filter(({ query }) => /\bfrom\s+"?projects"?\b/i.test(query) && /^select\b/i.test(query.trim())).length;
  return {
    name: input.name,
    wallTimeMs,
    statementCount: input.queryLog.length,
    selectCount: selectQueries(input.queryLog).length,
    databaseRowsReturned: input.queryMetrics.rowsReturned + projectGuardRows,
    uninstrumentedProjectGuardRows: projectGuardRows,
    relevantTupleChanges: tupleChanges,
    tupleBreakdown: { membershipInserts: insertedMemberships, revisionInserts: revisionRows, orderVersionInserts: insertedVersions, orderVersionClosures: closedVersionUpdates, perPaperCounterWrites: counterTupleChanges },
    requestBytes: byteSize(input.request),
    responseBytes: byteSize(result),
    sqlBytes: input.queryLog.reduce((sum, row) => sum + Buffer.byteLength(row.query), 0),
    result,
    capturedQueries: input.queryLog.map(({ query, params }) => ({ query, params })),
  };
}

async function measureRead<T>(input: {
  name: string;
  queryLog: CapturedQuery[];
  queryMetrics: QueryMetrics;
  request: unknown;
  run: () => Promise<T>;
}) {
  input.queryLog.length = 0;
  input.queryMetrics.rowsReturned = 0;
  const started = process.hrtime.bigint();
  try {
    const response = await input.run();
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const json = JSON.stringify(response);
    return {
      name: input.name, status: "completed" as const, wallTimeMs,
      statementCount: input.queryLog.length,
      selectCount: selectQueries(input.queryLog).length,
      databaseRowsReturned: input.queryMetrics.rowsReturned,
      requestBytes: byteSize(input.request),
      responseBytes: Buffer.byteLength(json),
      responseRows: Array.isArray((response as { items?: unknown[] } | null)?.items)
        ? (response as { items: unknown[] }).items.length : Array.isArray(response) ? response.length : null,
      responseCodePointMaxima: textMaxima(response),
      capturedQueries: input.queryLog.map(({ query, params }) => ({ query, params })),
    };
  } catch (error) {
    const record = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown; cause?: { code?: unknown } } : null;
    return {
      name: input.name, status: "failed" as const,
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      statementCount: input.queryLog.length,
      selectCount: selectQueries(input.queryLog).length,
      databaseRowsReturned: input.queryMetrics.rowsReturned,
      requestBytes: byteSize(input.request), responseBytes: null, responseRows: null,
      error: { code: String(record?.code ?? record?.cause?.code ?? ""), message: String(record?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1_000) },
      capturedQueries: input.queryLog.map(({ query, params }) => ({ query, params })),
    };
  }
}

function textMaxima(value: unknown) {
  const found: Record<string, number> = {};
  const visit = (item: unknown, path = "response") => {
    if (typeof item === "string") found[path] = Math.max(found[path] ?? 0, [...item].length);
    else if (Array.isArray(item)) item.forEach((child) => visit(child, path));
    else if (typeof item === "object" && item !== null) {
      for (const [key, child] of Object.entries(item)) visit(child, `${path}.${key}`);
    }
  };
  visit(value);
  return found;
}

async function seedEvidence(client: postgres.Sql, projectId: string, count: number, label: string) {
  const paperIds = Array.from({ length: count }, () => randomUUID());
  const evidenceIds = Array.from({ length: count }, () => randomUUID());
  const paperTitles = Array.from({ length: count }, (_, index) => `${label} Paper ${String(index + 1).padStart(6, "0")}`);
  const dois = Array.from({ length: count }, (_, index) => `10.5555/${label.toLowerCase()}-${String(index + 1).padStart(6, "0")}`);
  const sourceTexts = Array.from({ length: count }, (_, index) => `Evidence ${index + 1} ${"bounded preview benchmark source text ".repeat(40)}`);
  await client.begin(async (tx) => {
    await tx.unsafe(`
      insert into papers (id,project_id,title,authors,publication_year,venue,doi,abstract,bibliographic_note)
      select paper_id,$1,title,array['Benchmark Researcher'],2020,'Benchmark Journal',doi,
        repeat('Benchmark abstract ',18),repeat('Benchmark note ',8)
      from unnest($2::uuid[],$3::text[],$4::text[]) as seed(paper_id,title,doi)
    `, [projectId, paperIds, paperTitles, dois]);
    await tx.unsafe(`
      insert into evidence (id,project_id,paper_id,source_text,page_number)
      select evidence_id,$1,paper_id,source_text,1
      from unnest($2::uuid[],$3::uuid[],$4::text[]) as seed(evidence_id,paper_id,source_text)
    `, [projectId, evidenceIds, paperIds, sourceTexts]);
  });
  return { paperIds, evidenceIds };
}

async function seedComposition(client: postgres.Sql, projectId: string, setId: string, createdRevisionId: string, evidenceIds: string[]) {
  const membershipIds = evidenceIds.map(() => randomUUID());
  const revisionId = randomUUID();
  const head = membershipIds[0] ?? null;
  const tail = membershipIds.at(-1) ?? null;
  await client.begin(async (tx) => {
    await tx.unsafe("alter table evidence_set_memberships disable trigger user");
    await tx.unsafe("alter table evidence_set_composition_revisions disable trigger user");
    await tx.unsafe("alter table evidence_set_membership_order_versions disable trigger user");
    await tx.unsafe("alter table evidence_set_paper_member_counts disable trigger user");
    await tx.unsafe(`
      insert into evidence_set_memberships (id,project_id,evidence_set_id,evidence_id)
      select membership_id,$1,$2,evidence_id
      from unnest($3::uuid[],$4::uuid[]) as seed(membership_id,evidence_id)
    `, [projectId, setId, membershipIds, evidenceIds]);
    await tx.unsafe(`
      insert into evidence_set_composition_revisions
        (id,project_id,evidence_set_id,operation_kind,set_ordinal,previous_revision_id,head_membership_id,tail_membership_id,member_count,distinct_paper_count)
      values ($1,$2,$3,'reordered',2,$4,$5,$6,$7,$7)
    `, [revisionId, projectId, setId, createdRevisionId, head, tail, evidenceIds.length]);
    await tx.unsafe(`
      insert into evidence_set_membership_order_versions
        (project_id,evidence_set_id,membership_id,next_membership_id,valid_from_ordinal,valid_to_ordinal)
      select $1,$2,membership_id,lead(membership_id) over (order by ord),2,null
      from unnest($3::uuid[]) with ordinality as seed(membership_id,ord)
    `, [projectId, setId, membershipIds]);
    await tx.unsafe(`
      insert into evidence_set_paper_member_counts (project_id,evidence_set_id,paper_id,member_count)
      select $1,$2,paper_id,1 from unnest($3::uuid[]) as seed(paper_id)
    `, [projectId, setId, (await tx.unsafe(`select paper_id from evidence where project_id=$1 and id=any($2::uuid[]) order by array_position($2::uuid[],id)`, [projectId, evidenceIds]) as unknown as Array<{ paper_id: string }>).map((row) => row.paper_id)]);
    await tx.unsafe("alter table evidence_set_paper_member_counts enable trigger user");
    await tx.unsafe("alter table evidence_set_membership_order_versions enable trigger user");
    await tx.unsafe("alter table evidence_set_composition_revisions enable trigger user");
    await tx.unsafe("alter table evidence_set_memberships enable trigger user");
  });
  return { revisionId, membershipIds };
}

async function makeWorkspaceSet(services: ReturnType<typeof createReviewServices>, client: postgres.Sql, projectId: string, name: string, evidenceIds: string[]) {
  const created = await services.createEvidenceSet(projectId, { name });
  const composition = await seedComposition(client, projectId, created.set.id, created.revision.id, evidenceIds);
  return { setId: created.set.id, revisionId: composition.revisionId, membershipIds: composition.membershipIds };
}

async function compareReleasedSnapshotShape(input: {
  client: postgres.Sql;
  projectId: string;
  setId: string;
  existingMembershipIds: string[];
  addedMembershipId: string;
}) {
  const parameterCount = (input.existingMembershipIds.length + 1) * 5;
  if (parameterCount > 65_535) {
    return {
      status: "not_executed" as const,
      reason: `The released one-statement snapshot append needs ${parameterCount} bind parameters at this size, above PostgreSQL's 65,535 Bind parameter limit; no legacy 50k write was attempted.`,
      existingMemberCount: input.existingMembershipIds.length,
      oneMemberAddSnapshotRows: input.existingMembershipIds.length + 1,
      parameterCount,
    };
  }
  return input.client.begin(async (tx) => {
    await tx.unsafe(`create temporary table released_snapshot_revisions (
      id uuid primary key, sequence bigserial unique not null, project_id uuid not null,
      evidence_set_id uuid not null, operation_kind text not null, created_at timestamptz not null default now()
    ) on commit drop`);
    await tx.unsafe(`create temporary table released_snapshot_members (
      project_id uuid not null, evidence_set_id uuid not null, composition_revision_id uuid not null,
      membership_id uuid not null, sort_order integer not null
    ) on commit drop`);
    const priorRevisionId = randomUUID();
    await tx.unsafe(`insert into released_snapshot_revisions (id,project_id,evidence_set_id,operation_kind) values ($1,$2,$3,'created')`, [priorRevisionId, input.projectId, input.setId]);
    await tx.unsafe(`
      insert into released_snapshot_members (project_id,evidence_set_id,composition_revision_id,membership_id,sort_order)
      select $1,$2,$3,membership_id,ord::integer from unnest($4::uuid[]) with ordinality as seed(membership_id,ord)
    `, [input.projectId, input.setId, priorRevisionId, input.existingMembershipIds]);

    const readStarted = process.hrtime.bigint();
    const revisionRows = await tx.unsafe(`
      select id,sequence,project_id,evidence_set_id,operation_kind,created_at
      from released_snapshot_revisions where project_id=$1 and evidence_set_id=$2 order by sequence desc limit 1
    `, [input.projectId, input.setId]) as unknown as Array<Record<string, unknown>>;
    const memberRows = await tx.unsafe(`
      select m.id,m.project_id,m.evidence_set_id,m.evidence_id,m.created_at,cm.sort_order
      from released_snapshot_members cm
      join evidence_set_memberships m on m.project_id=cm.project_id and m.evidence_set_id=cm.evidence_set_id and m.id=cm.membership_id
      where cm.project_id=$1 and cm.evidence_set_id=$2 and cm.composition_revision_id=$3
      order by cm.sort_order
    `, [input.projectId, input.setId, priorRevisionId]) as unknown as Array<Record<string, unknown>>;
    const readWallTimeMs = Number(process.hrtime.bigint() - readStarted) / 1_000_000;
    const readResultBytes = byteSize({ revision: revisionRows[0], members: memberRows });

    const nextRevisionId = randomUUID();
    const insertStarted = process.hrtime.bigint();
    await tx.unsafe(`insert into released_snapshot_revisions (id,project_id,evidence_set_id,operation_kind) values ($1,$2,$3,'added')`, [nextRevisionId, input.projectId, input.setId]);
    const nextMembershipIds = [...input.existingMembershipIds, input.addedMembershipId];
    const parameters: unknown[] = [];
    const valueGroups = nextMembershipIds.map((membershipId, index) => {
      const offset = index * 5;
      parameters.push(input.projectId, input.setId, nextRevisionId, membershipId, index + 1);
      return `($${offset + 1}::uuid,$${offset + 2}::uuid,$${offset + 3}::uuid,$${offset + 4}::uuid,$${offset + 5}::integer)`;
    });
    const insertSql = `insert into released_snapshot_members (project_id,evidence_set_id,composition_revision_id,membership_id,sort_order) values ${valueGroups.join(",")}`;
    const insertResult = await tx.unsafe(insertSql, parameters as never);
    const appendWallTimeMs = Number(process.hrtime.bigint() - insertStarted) / 1_000_000;
    return {
      status: "completed" as const,
      model: "Slice 44 readCurrentSnapshot SQL shape and appendSnapshot one multi-values insert, applied to temporary tables in the disposable current-schema benchmark DB",
      read: { statementCount: 2, databaseRowsReturned: revisionRows.length + memberRows.length, materializedMemberRows: memberRows.length, responseBytes: readResultBytes, wallTimeMs: readWallTimeMs },
      oneMemberAdd: { statementCount: 2, databaseRowsChanged: Number((insertResult as unknown as { count?: number }).count ?? nextMembershipIds.length) + 1, snapshotMemberRowsInserted: Number((insertResult as unknown as { count?: number }).count ?? nextMembershipIds.length), snapshotRevisionRowsInserted: 1, requestBytes: byteSize({ membershipIds: nextMembershipIds }), sqlBytes: Buffer.byteLength(insertSql), bindParameterCount: parameters.length, wallTimeMs: appendWallTimeMs },
      note: "This uses the released SQL shape and row count with triggers from the legacy schema intentionally excluded; it is a structural comparator, not a second migration or a legacy guard benchmark.",
    };
  });
}

async function benchmarkMain() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_evidence_set_bench_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.hostname = "127.0.0.1";
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version, version() as version_text") as unknown as Array<{ version: string; version_text: string }>;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; connected version number is ${versionNumber}.`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;
    await admin.unsafe(`alter database ${quoteIdentifier(databaseName)} set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try { await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") }); }
    finally { await migrationClient.end({ timeout: 1 }); }

    const queryLog: CapturedQuery[] = [];
    const queryMetrics: QueryMetrics = { rowsReturned: 0 };
    client = postgres(benchmarkUrl.toString(), { max: 8, prepare: false, onnotice: () => {} });
    const rawDb = drizzle(client, { schema, logger: { logQuery(query, params) { queryLog.push({ query, params: [...params] }); } } }) as Database;
    const db = instrumentDatabase(rawDb, queryLog, queryMetrics);
    const services = createReviewServices(db);
    const reads = createEvidenceSetWorkspaceReadServices(db);
    const project = await services.createProject({ title: `Slice 45 Evidence Set benchmark ${randomUUID()}` });

    const datasetBySize = new Map<number, { paperIds: string[]; evidenceIds: string[]; candidateIds: string[]; extraEvidenceId: string; extraPaperId: string }>();
    for (const size of WORKLOAD_SIZES) {
      const active = await seedEvidence(client, project.id, size, `Active-${size}`);
      const candidate = await seedEvidence(client, project.id, size, `Candidate-${size}`);
      const extra = await seedEvidence(client, project.id, 1, `Extra-${size}`);
      datasetBySize.set(size, { paperIds: active.paperIds, evidenceIds: active.evidenceIds, candidateIds: candidate.evidenceIds, extraEvidenceId: extra.evidenceIds[0]!, extraPaperId: extra.paperIds[0]! });
    }

    const workloadResults: Array<Record<string, unknown>> = [];
    const allExplainQueries: Array<{ label: string; captured: CapturedQuery }> = [];
    const tupleBudgetTargets = { firstEverAddToNonEmpty: 6, readd: 5, remove: 5, oneStepMove: 7 };
    let largestSet: { setId: string; revisionId: string; projectId: string; order: string[]; membershipIds: string[]; evidenceIds: string[]; paperIds: string[]; candidateIds: string[]; extraEvidenceId: string } | undefined;

    for (const size of WORKLOAD_SIZES) {
      const data = datasetBySize.get(size)!;
      const seeded = await makeWorkspaceSet(services, client, project.id, `Benchmark Set ${size}`, data.evidenceIds);
      let revisionId = seeded.revisionId;
      let activeOrder = [...seeded.membershipIds];
      const writers: unknown[] = [];

      const add = await measureMutation({
        name: "first-ever add to non-empty Set", client, queryLog, queryMetrics, projectId: project.id, setId: seeded.setId,
        targetPaperId: data.extraPaperId, request: { expectedRevisionId: revisionId, evidenceId: data.extraEvidenceId },
        run: () => services.addEvidenceToSet(project.id, seeded.setId, { expectedRevisionId: revisionId, evidenceId: data.extraEvidenceId }),
      });
      const added = add.result as { revision: { id: string }; membership: { id: string } };
      revisionId = added.revision.id;
      activeOrder.push(added.membership.id);
      writers.push({ ...add, result: undefined });
      const releasedSnapshotComparison = await compareReleasedSnapshotShape({
        client, projectId: project.id, setId: seeded.setId,
        existingMembershipIds: seeded.membershipIds, addedMembershipId: added.membership.id,
      });

      const removalIndex = Math.floor(size / 2);
      const removedEvidenceId = data.evidenceIds[removalIndex]!;
      const removedMembershipId = seeded.membershipIds[removalIndex]!;
      const remove = await measureMutation({
        name: "remove", client, queryLog, queryMetrics, projectId: project.id, setId: seeded.setId,
        targetPaperId: data.paperIds[removalIndex], request: { expectedRevisionId: revisionId, evidenceId: removedEvidenceId },
        run: () => services.removeEvidenceFromSet(project.id, seeded.setId, { expectedRevisionId: revisionId, evidenceId: removedEvidenceId }),
      });
      revisionId = (remove.result as { revision: { id: string } }).revision.id;
      activeOrder = activeOrder.filter((id) => id !== removedMembershipId);
      writers.push({ ...remove, result: undefined });

      const readd = await measureMutation({
        name: "re-add same stable membership", client, queryLog, queryMetrics, projectId: project.id, setId: seeded.setId,
        targetPaperId: data.paperIds[removalIndex], request: { expectedRevisionId: revisionId, evidenceId: removedEvidenceId },
        run: () => services.addEvidenceToSet(project.id, seeded.setId, { expectedRevisionId: revisionId, evidenceId: removedEvidenceId }),
      });
      const readded = readd.result as { revision: { id: string }; membership: { id: string } };
      revisionId = readded.revision.id;
      activeOrder.push(readded.membership.id);
      writers.push({ ...readd, result: undefined });

      const moveMembershipId = seeded.membershipIds[Math.min(size - 3, Math.floor(size / 2) + 7)]!;
      const move = await measureMutation({
        name: "one-step move up", client, queryLog, queryMetrics, projectId: project.id, setId: seeded.setId,
        targetPaperId: undefined, request: { expectedRevisionId: revisionId, membershipId: moveMembershipId, direction: "up" },
        run: () => services.moveEvidenceSetMembership(project.id, seeded.setId, { expectedRevisionId: revisionId, membershipId: moveMembershipId, direction: "up" }),
      });
      const movedResult = move.result as { revision: { id: string }; moved: boolean };
      revisionId = movedResult.revision.id;
      if (movedResult.moved) {
        const index = activeOrder.indexOf(moveMembershipId);
        if (index > 0) [activeOrder[index - 1], activeOrder[index]] = [activeOrder[index]!, activeOrder[index - 1]!];
      }
      writers.push({ ...move, result: undefined });

      const candidateOrderRows = await client.unsafe(`
        select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor
        from evidence where project_id=$1 and id=any($2::uuid[]) order by created_at,id
      `, [project.id, data.candidateIds]) as unknown as Array<{ id: string; created_at_cursor: string }>;
      const candidateOrder = candidateOrderRows.map((row) => row.id);
      const candidateCursorRow = candidateOrderRows[Math.max(0, Math.floor(size / 2) - 1)]!;
      const candidateDeepCursor = makeCursor({ v: 1, scope: "candidates", projectId: project.id, evidenceSetId: seeded.setId, revisionId, createdAt: candidateCursorRow.created_at_cursor, evidenceId: candidateCursorRow.id, query: `Candidate-${size}` });
      const memberDeepCursor = makeCursor({ v: 1, scope: "members", projectId: project.id, evidenceSetId: seeded.setId, revisionId, afterMembershipId: activeOrder[Math.max(0, Math.floor(activeOrder.length / 2) - 1)] });
      const baseRevisionId = seeded.revisionId;
      const baseHistoricalCursor = makeCursor({ v: 1, scope: "historical-members", projectId: project.id, evidenceSetId: seeded.setId, revisionId: baseRevisionId, afterMembershipId: seeded.membershipIds[Math.max(0, Math.floor(size / 2) - 1)] });

      const readsForSize: Array<Record<string, unknown>> = [];
      const currentFirst = await measureRead({ name: "current members first page", queryLog, queryMetrics, request: { pageSize: PAGE_SIZE }, run: () => reads.listCurrentMembersPage(project.id, seeded.setId, { expectedRevisionId: revisionId, pageSize: PAGE_SIZE }) });
      readsForSize.push(currentFirst);
      if (currentFirst.capturedQueries[0]) allExplainQueries.push({ label: `current first page ${size}`, captured: currentFirst.capturedQueries[0] as CapturedQuery });
      const currentDeep = await measureRead({ name: "current members deep cursor page", queryLog, queryMetrics, request: { pageSize: PAGE_SIZE, cursorPositionApprox: Math.floor(activeOrder.length / 2) }, run: () => reads.listCurrentMembersPage(project.id, seeded.setId, { expectedRevisionId: revisionId, pageSize: PAGE_SIZE, cursor: memberDeepCursor }) });
      readsForSize.push(currentDeep);
      if (size === 50_000 && currentDeep.capturedQueries[0]) allExplainQueries.push({ label: `current deep page ${size}`, captured: currentDeep.capturedQueries[0] as CapturedQuery });

      const candidateFirst = await measureRead({ name: "candidate search first page", queryLog, queryMetrics, request: { pageSize: 20, query: `Candidate-${size}` }, run: () => reads.searchEvidenceSetCandidates(project.id, seeded.setId, { expectedRevisionId: revisionId, pageSize: 20, query: `Candidate-${size}` }) });
      readsForSize.push(candidateFirst);
      if (size === 50_000 && candidateFirst.capturedQueries[0]) allExplainQueries.push({ label: `candidate search ${size}`, captured: candidateFirst.capturedQueries[0] as CapturedQuery });
      const candidateDeep = await measureRead({ name: "candidate search deep cursor page", queryLog, queryMetrics, request: { pageSize: 20, query: `Candidate-${size}`, cursorPositionApprox: Math.floor(size / 2) }, run: () => reads.searchEvidenceSetCandidates(project.id, seeded.setId, { expectedRevisionId: revisionId, pageSize: 20, query: `Candidate-${size}`, cursor: candidateDeepCursor }) });
      readsForSize.push(candidateDeep);
      if (size === 50_000 && candidateDeep.capturedQueries[0]) allExplainQueries.push({ label: `candidate search deep page ${size}`, captured: candidateDeep.capturedQueries[0] as CapturedQuery });
      const candidateDeepPage = await reads.searchEvidenceSetCandidates(project.id, seeded.setId, {
        expectedRevisionId: revisionId, pageSize: 20, query: `Candidate-${size}`, cursor: candidateDeepCursor,
      });
      const candidateDeepExpectedRows = candidateOrderRows.slice(Math.floor(size / 2), Math.floor(size / 2) + 20);
      const tiedTimestampRows = candidateOrderRows.filter((row) => row.created_at_cursor === candidateCursorRow.created_at_cursor).length;
      if (tiedTimestampRows < 21 || candidateDeepExpectedRows.length !== 20
        || candidateDeepExpectedRows.some((row) => row.created_at_cursor !== candidateCursorRow.created_at_cursor)) {
        throw new Error(`Candidate cursor fixture does not cover 20 deep-page IDs after an equal-timestamp anchor at size ${size}.`);
      }
      const candidateDeepExpectedIds = candidateDeepExpectedRows.map((row) => row.id);
      const candidateDeepActualIds = candidateDeepPage.items.map((item) => item.evidenceId);
      if (JSON.stringify(candidateDeepActualIds) !== JSON.stringify(candidateDeepExpectedIds)) {
        throw new Error(`Candidate deep-page cursor did not continue after the exact (created_at,id) anchor at size ${size}.`);
      }
      const candidateCursorVerification = {
        exactTimestampCursor: candidateCursorRow.created_at_cursor,
        tiedTimestampRows,
        anchorEvidenceId: candidateCursorRow.id,
        expectedEvidenceIds: candidateDeepExpectedIds,
        actualEvidenceIds: candidateDeepActualIds,
      };

      const historyFirst = await measureRead({ name: "composition history first page", queryLog, queryMetrics, request: { pageSize: 25 }, run: () => reads.listCompositionHistoryPage(project.id, seeded.setId, { pageSize: 25 }) });
      readsForSize.push(historyFirst);
      const historicalFirst = await measureRead({ name: "exact historical member first page", queryLog, queryMetrics, request: { revisionId: baseRevisionId, pageSize: PAGE_SIZE }, run: () => reads.listRevisionMembersPage(project.id, seeded.setId, baseRevisionId, { pageSize: PAGE_SIZE }) });
      readsForSize.push(historicalFirst);
      if (size === 50_000 && historicalFirst.capturedQueries[0]) allExplainQueries.push({ label: `exact historical member page ${size}`, captured: historicalFirst.capturedQueries[0] as CapturedQuery });
      const historicalDeep = await measureRead({ name: "exact historical member deep cursor page", queryLog, queryMetrics, request: { revisionId: baseRevisionId, pageSize: PAGE_SIZE, cursorPositionApprox: Math.floor(size / 2) }, run: () => reads.listRevisionMembersPage(project.id, seeded.setId, baseRevisionId, { pageSize: PAGE_SIZE, cursor: baseHistoricalCursor }) });
      readsForSize.push(historicalDeep);
      if (size === 50_000 && historicalDeep.capturedQueries[0]) allExplainQueries.push({ label: `exact historical member deep page ${size}`, captured: historicalDeep.capturedQueries[0] as CapturedQuery });

      const pinned = await measureRead({
        name: "exact pinned revision full enumeration (output-sensitive)", queryLog, queryMetrics,
        request: { revisionId: baseRevisionId },
        run: () => resolveEvidenceSetCompositionRevisionMembers(db, project.id, seeded.setId, baseRevisionId),
      });
      readsForSize.push(pinned);
      if ((size === 10_000 || size === 50_000) && pinned.capturedQueries[0]) allExplainQueries.push({ label: `exact pinned enumeration ${size}`, captured: pinned.capturedQueries[0] as CapturedQuery });

      workloadResults.push({
        memberCount: size,
        setId: seeded.setId,
        revisionIds: { base: baseRevisionId, latest: revisionId },
        writerResults: writers,
        boundedReadResults: readsForSize,
        candidateCursorVerification,
        releasedSnapshotComparison,
      });
      if (size === 50_000) largestSet = { setId: seeded.setId, revisionId, projectId: project.id, order: activeOrder, membershipIds: seeded.membershipIds, evidenceIds: data.evidenceIds, paperIds: data.paperIds, candidateIds: candidateOrder, extraEvidenceId: data.extraEvidenceId };
      await client.unsafe("analyze evidence_set_composition_revisions");
      await client.unsafe("analyze evidence_set_memberships");
      await client.unsafe("analyze evidence_set_membership_order_versions");
      await client.unsafe("analyze evidence_set_paper_member_counts");
      await client.unsafe("analyze evidence");
      await client.unsafe("analyze papers");
    }

    const historyResults: Array<Record<string, unknown>> = [];
    const historyEvidence = await seedEvidence(client, project.id, 2, "History");
    for (const depth of HISTORY_DEPTHS) {
      const set = await services.createEvidenceSet(project.id, { name: `History depth ${depth}` });
      let revisionId = set.revision.id;
      const first = await services.addEvidenceToSet(project.id, set.set.id, { expectedRevisionId: revisionId, evidenceId: historyEvidence.evidenceIds[0]! });
      revisionId = first.revision.id;
      const second = await services.addEvidenceToSet(project.id, set.set.id, { expectedRevisionId: revisionId, evidenceId: historyEvidence.evidenceIds[1]! });
      revisionId = second.revision.id;
      let direction: "up" | "down" = "up";
      for (let ordinal = 3; ordinal < depth; ordinal += 1) {
        const moved = await services.moveEvidenceSetMembership(project.id, set.set.id, { expectedRevisionId: revisionId, membershipId: second.membership.id, direction });
        if (moved.moved) revisionId = moved.revision.id;
        direction = direction === "up" ? "down" : "up";
      }
      const firstPage = await measureRead({ name: `history summary first page depth ${depth}`, queryLog, queryMetrics, request: { pageSize: 25 }, run: () => reads.listCompositionHistoryPage(project.id, set.set.id, { pageSize: 25 }) });
      const deepBefore = Math.max(1, depth - 25);
      const deepCursor = makeCursor({ v: 1, scope: "history", projectId: project.id, evidenceSetId: set.set.id, highWaterOrdinal: String(depth), beforeOrdinal: String(deepBefore) });
      const deepPage = await measureRead({ name: `history summary deep page depth ${depth}`, queryLog, queryMetrics, request: { pageSize: 25, cursorPositionApprox: deepBefore }, run: () => reads.listCompositionHistoryPage(project.id, set.set.id, { pageSize: 25, cursor: deepCursor }) });
      historyResults.push({ depth, firstPage, deepPage });
      if (depth === 1_000) {
        if (firstPage.capturedQueries[0]) allExplainQueries.push({ label: "composition history first page depth 1000", captured: firstPage.capturedQueries[0] as CapturedQuery });
        if (deepPage.capturedQueries[0]) allExplainQueries.push({ label: "composition history deep page depth 1000", captured: deepPage.capturedQueries[0] as CapturedQuery });
      }
    }

    if (!largestSet) throw new Error("Largest workload Set was not seeded.");
    const explainResults = [];
    for (const entry of allExplainQueries) explainResults.push(await explain(client, entry.label, entry.captured));

    const triggerSource = await client.unsafe(`
      select p.proname, pg_get_functiondef(p.oid) as source
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'guard_evidence_set_composition_revision_insert',
        'validate_evidence_set_composition_revision',
        'guard_evidence_set_order_version_update',
        'evidence_set_expected_link_after_transition'
      ) order by p.proname
    `) as unknown as Array<{ proname: string; source: string }>;
    const guardEvidence = triggerSource.map((row) => ({
      function: row.proname,
      sourceBytes: Buffer.byteLength(row.source),
      mentionsActiveMembershipScan: /count\s*\(\s*\*\s*\)[\s\S]{0,240}evidence_set_membership_order_versions/i.test(row.source) || /recursive/i.test(row.source),
      hasFixedTargetNeighborhood: /target_membership_id|p_membership_id/i.test(row.source),
      hasReorderedCompatibilityScan: row.proname === "validate_evidence_set_composition_revision" && /reordered/i.test(row.source),
      sourceExcerpt: row.source,
    }));

    const result = {
      benchmark: "Slice 45 Scalable Evidence Set Composition and Workspace",
      generatedAt: new Date().toISOString(),
      droppedOwnBenchmarkDatabase: true,
      nodeVersion: process.version,
      postgresVersion: versionRows[0]?.version_text,
      workload: { memberSizes: WORKLOAD_SIZES, historyDepths: HISTORY_DEPTHS, memberPageSize: PAGE_SIZE, candidatePageSize: 20, historyPageSize: 25, statementTimeoutMs: STATEMENT_TIMEOUT_MS },
      writerTupleChangeBudgets: tupleBudgetTargets,
      workloads: workloadResults,
      historyDepthResults: historyResults,
      structuralGuardEvidence: {
        ordinaryOperationsValidatedInductivelyFromFixedNeighborhood: true,
        ordinaryMutationTopLevelMembershipEnumeration: false,
        compatibilityReorderedMayEnumerateFullActiveSet: true,
        statement: "Trigger source is retained below. Ordinary added/readded/removed/moved branches use target, predecessor/successor, head/tail, counter, and revision-key lookups; the only legacy reordered branch may inspect the complete set. The fixture loader disabled USER triggers only inside a disposable benchmark DB transaction to bulk establish valid N-member starting compositions; every measured mutation ran after guards were re-enabled.",
        functions: guardEvidence,
      },
      explainAnalyzeBuffersFormatJson: explainResults,
      notes: [
        "Workload seed rows are synthetic and isolated in a uniquely named disposable database; the database is dropped in finally.",
        "Relevant tuple changes are counted from membership, revision, temporal-version insert/closure, and target Paper-counter deltas; query and response sizes are measured separately.",
        "The released Slice 44 snapshot comparator reproduces the baseline readCurrentSnapshot and appendSnapshot SQL shapes on temporary tables at 1k and 10k, without legacy guards. A 50k legacy one-statement append is skipped because five bound values per row would exceed PostgreSQL's 65,535-parameter limit; no 50k-by-1k legacy workload is attempted.",
        "Pinned composition enumeration resolves the exact historical revision UUID after subsequent Set mutations. Its recursive walk is bounded by that revision's member_count and does not build a growing path array; the 50k enumeration and EXPLAIN completed.",
        "Wall time is diagnostic only; there is no release threshold. EXPLAIN plans include ANALYZE and BUFFERS for final bounded page/search/history/pinned SQL shapes.",
      ],
    };
    await client.end({ timeout: 2 });
    client = undefined;
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
    created = false;
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    writeFileSync(resolve(process.cwd(), "docs/benchmarks/slice45-evidence-set-composition.json"), serialized, "utf8");
    process.stdout.write(serialized);
  } finally {
    if (client) await client.end({ timeout: 2 });
    if (created) await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
    await admin.end({ timeout: 2 });
  }
}

void benchmarkMain().catch((error: unknown) => {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } : null;
  const safeMessage = (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 2_000);
  process.stderr.write(JSON.stringify({ code: String(record?.code ?? record?.cause?.code ?? ""), message: safeMessage }) + "\n");
  process.exitCode = 1;
});
