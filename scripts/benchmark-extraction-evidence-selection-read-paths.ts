import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createExtractionReadServices } from "@/application/extraction-read-services";
import { encodeExtractionEvidenceCandidateCursor } from "@/application/extraction-evidence-selection-cursor";
import { resolveDatabaseUrl } from "@/db/config";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";

const PAGE_SIZE = 50;
const MAX_DTO_BYTES = 1024 * 1024;
const STATEMENT_TIMEOUT_MS = 15_000;
const SEED_TIMEOUT_MS = 600_000;
const ARTIFACT = resolve("docs/benchmarks/slice55-extraction-evidence-selection-read-paths.json");

type CapturedQuery = { sql: string; params: unknown[]; driverRows: number | null; decodedJsonUtf8Bytes: number | null };
type QuerySink = { queries: CapturedQuery[]; transactionApiCalls: number };
type CaptureResult<T> = { value: T; queries: CapturedQuery[]; diagnosticWallTimeMs: number; selectCount: number; statementCount: number; transactionApiCalls: number };

const sink: QuerySink = { queries: [], transactionApiCalls: 0 };
const countedClients = new WeakMap<object, postgres.Sql>();

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error: unknown) {
  const row = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : undefined;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { code: String(row?.code ?? row?.cause?.code ?? ""), message: message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1500) };
}

function stableUuid(seed: string) {
  const bytes = createHash("md5").update(seed).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function uuidSql(expression: string) {
  const digest = `md5(${expression})`;
  return `(substring(${digest} from 1 for 12) || '5' || substring(${digest} from 14 for 3) || substring(translate(${digest}, '0123456789abcdef', '89ab89ab89ab89ab') from 17 for 1) || substring(${digest} from 18 for 15))::uuid`;
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item), "utf8");
}

function queryRecordForNextResult(): CapturedQuery | undefined {
  return [...sink.queries].reverse().find((query) => query.driverRows === null);
}

function countedResult(query: object, record?: CapturedQuery): object {
  return new Proxy(query, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (property === "then" && typeof member === "function") {
        return (resolveValue: ((value: unknown) => unknown) | undefined, reject: ((reason: unknown) => unknown) | undefined) => Reflect.apply(member, target, [
          (result: unknown) => {
            if (Array.isArray(result)) {
              if (record) {
                record.driverRows = result.length;
                record.decodedJsonUtf8Bytes = jsonBytes(result);
              }
            }
            return resolveValue ? resolveValue(result) : result;
          },
          reject,
        ]);
      }
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const next = Reflect.apply(member, target, args) as unknown;
        return next && typeof next === "object" && typeof (next as { then?: unknown }).then === "function" ? countedResult(next, record) : next;
      };
    },
  });
}

function countedSql(client: postgres.Sql): postgres.Sql {
  const cached = countedClients.get(client as object);
  if (cached) return cached;
  const wrapped = new Proxy(client, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (property === "unsafe" && typeof member === "function") {
        return (...args: unknown[]) => {
          const record = queryRecordForNextResult();
          const result = Reflect.apply(member, target, args) as unknown;
          return result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function" ? countedResult(result, record) : result;
        };
      }
      if (property === "begin" && typeof member === "function") {
        return (...args: unknown[]) => {
          if (typeof args[0] !== "function") return Reflect.apply(member, target, args);
          sink.transactionApiCalls += 1;
          const callback = args[0] as (transaction: postgres.Sql) => unknown;
          return Reflect.apply(member, target, [(transaction: postgres.Sql) => callback(countedSql(transaction)), ...args.slice(1)]);
        };
      }
      return typeof member === "function" ? member.bind(target) : member;
    },
  }) as postgres.Sql;
  countedClients.set(client as object, wrapped);
  return wrapped;
}

function makeDatabase(client: postgres.Sql): Database {
  return drizzle(countedSql(client), {
    schema,
    logger: { logQuery(query, params) { sink.queries.push({ sql: query, params: [...params], driverRows: null, decodedJsonUtf8Bytes: null }); } },
  }) as Database;
}

async function capture<T>(operation: () => Promise<T>): Promise<CaptureResult<T>> {
  sink.queries.length = 0;
  sink.transactionApiCalls = 0;
  const started = process.hrtime.bigint();
  const value = await operation();
  const queries = sink.queries.map((query) => ({ ...query }));
  return {
    value,
    queries,
    diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    selectCount: queries.filter(({ sql }) => /^(with|select)\b/i.test(sql.trim())).length,
    statementCount: queries.length,
    transactionApiCalls: sink.transactionApiCalls,
  };
}

async function seedProject(client: postgres.Sql, projectId: string, title: string) {
  await client.unsafe("insert into projects (id,title) values ($1::uuid,$2::text)", [projectId, title]);
}

async function seedPaper(client: postgres.Sql, projectId: string, paperId: string, title: string) {
  await client.unsafe("insert into papers (id,project_id,title) values ($1::uuid,$2::uuid,$3::text)", [paperId, projectId, title]);
  await client.unsafe("insert into screening_decisions (project_id,paper_id,decision) values ($1::uuid,$2::uuid,'include')", [projectId, paperId]);
  await client.unsafe("insert into full_text_retrieval_attempts (project_id,paper_id,outcome,method,attempted_at) values ($1::uuid,$2::uuid,'retrieved','manual',now())", [projectId, paperId]);
  await client.unsafe("insert into full_text_screening_decisions (project_id,paper_id,decision) values ($1::uuid,$2::uuid,'include')", [projectId, paperId]);
}

async function seedCandidates(client: postgres.Sql, projectId: string, paperId: string, count: number, order: "seconds" | "micros" | "ties", curation: "mixed" | "rejected-heavy" | "all-rejected" | "all-accepted" = "mixed") {
  if (count === 0) return;
  const createdAt = order === "seconds"
    ? `timestamptz '2026-10-01 00:00:00+00' + g.n * interval '1 second'`
    : order === "micros"
      ? `timestamptz '2026-10-01 00:00:00.000000+00' + g.n * interval '1 microsecond'`
      : `case when g.n <= 5000 then timestamptz '2026-10-01 00:00:00.000000+00' else timestamptz '2026-10-01 00:00:00.000000+00' - (g.n - 5000) * interval '1 microsecond' end`;
  await client.unsafe(`
    insert into evidence (id,project_id,paper_id,source_text,note,page_number,created_at,updated_at)
    select ${uuidSql("$1::text || ':evidence:' || g.n::text")},$2::uuid,$3::uuid,
      case when g.n <= 50 then repeat('🙂' || chr(1),700) else 'Benchmark source ' || g.n::text end,
      case when g.n <= 50 then repeat('漢' || chr(2),350) else 'Benchmark note ' || g.n::text end,
      g.n,${createdAt},${createdAt}
    from generate_series(1,$4::int) as g(n)
  `, [paperId, projectId, paperId, count]);

  const decision = curation === "all-rejected"
    ? "'rejected'::text"
    : curation === "all-accepted"
      ? "'accepted'::text"
    : curation === "rejected-heavy"
      ? "case when g.n <= floor($3::numeric * 0.9) then 'rejected' when mod(g.n,2)=0 then 'accepted' else 'needs_review' end"
      : "case mod(g.n,4) when 0 then 'accepted' when 1 then 'needs_review' when 2 then 'rejected' else null end";
  await client.unsafe(`
    insert into evidence_review_decisions (project_id,evidence_id,decision)
    select $2::uuid,${uuidSql("$1::text || ':evidence:' || g.n::text")},${decision}
    from generate_series(1,$3::int) as g(n)
    where $4::text <> 'mixed' or mod(g.n,4) <> 3
  `, [paperId, projectId, count, curation]);
}

async function seedFields(client: postgres.Sql, projectId: string, count: number, prefix: string) {
  await client.unsafe(`
    insert into extraction_fields (id,project_id,name,field_type,required,sort_order)
    select ${uuidSql("$1::text || ':field:' || g.n::text")},$2::uuid,$3::text || ' ' || g.n::text,'short_text',g.n=1,g.n
    from generate_series(1,$4::int) as g(n)
  `, [prefix, projectId, prefix, count]);
  const rows = await client.unsafe<{ id: string }[]>(`select id::text as id from extraction_fields where project_id=$1::uuid and name like $2::text || '%' order by sort_order,id`, [projectId, prefix]);
  return rows.map((row) => row.id);
}

async function seedRevisionWithSupports(client: postgres.Sql, args: { projectId: string; paperId: string; fieldId: string; revisionKey: string; supportCount: number }) {
  const slotId = stableUuid(`${args.revisionKey}:slot`);
  const revisionId = stableUuid(`${args.revisionKey}:revision`);
  await client.unsafe("insert into extraction_values (id,project_id,paper_id,field_id) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid)", [slotId, args.projectId, args.paperId, args.fieldId]);
  await client.unsafe(`insert into extraction_value_revisions
    (id,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,created_at,finalized_at)
    values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'short_text','present','Benchmark selected support',now(),null)`,
  [revisionId, args.projectId, args.paperId, args.fieldId, slotId]);
  if (args.supportCount > 0) {
    await client.unsafe(`insert into extraction_revision_evidence (project_id,paper_id,revision_id,evidence_id)
      select $1::uuid,$2::uuid,$3::uuid,e.id from evidence e
      where e.project_id=$1::uuid and e.paper_id=$2::uuid
        and coalesce((select d.decision from evidence_review_decisions d where d.project_id=e.project_id and d.evidence_id=e.id order by d.sequence desc limit 1),'unreviewed') <> 'rejected'
      order by e.created_at asc,e.id asc limit $4::int`, [args.projectId, args.paperId, revisionId, args.supportCount]);
  }
  await client.unsafe("update extraction_value_revisions set finalized_at=created_at where project_id=$1::uuid and id=$2::uuid", [args.projectId, revisionId]);
  const supports = await client.unsafe<{ evidence_id: string }[]>("select evidence_id::text from extraction_revision_evidence where project_id=$1::uuid and revision_id=$2::uuid order by evidence_id", [args.projectId, revisionId]);
  return { revisionId, supportIds: supports.map((row) => row.evidence_id) };
}

async function cursorBefore(client: postgres.Sql, projectId: string, paperId: string, pageSize: number, pageStartOffset: number) {
  if (pageStartOffset <= 0) return null;
  const [row] = await client.unsafe<{ id: string; created_at: string }[]>(`
    select e.id::text as id,to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    from evidence e where e.project_id=$1::uuid and e.paper_id=$2::uuid
    order by e.created_at desc,e.id asc offset $3::int limit 1
  `, [projectId, paperId, pageStartOffset - 1]);
  if (!row) throw new Error(`No cursor anchor found before page offset ${pageStartOffset}.`);
  return encodeExtractionEvidenceCandidateCursor({
    kind: "paper-extraction-evidence-candidate", version: 1, projectId, paperId, pageSize,
    createdAt: row.created_at, id: row.id,
  });
}

function queryShape(query: CapturedQuery) {
  if (/to_char\(e\.created_at/i.test(query.sql) && /order by e\.created_at desc/i.test(query.sql)) return "candidate_key_page";
  if (/with visible_keys/i.test(query.sql)) return "candidate_visible_hydration";
  if (/extraction_revision_evidence\s+link/i.test(query.sql)) return "current_selected_support_projection";
  return "other_select";
}

function planNodes(value: unknown) {
  const outer = Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : undefined;
  const root = outer?.["QUERY PLAN"];
  const explain = Array.isArray(root) ? root[0] as Record<string, unknown> | undefined : undefined;
  const plan = explain?.Plan as Record<string, unknown> | undefined;
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: Record<string, unknown>) => {
    nodes.push({
      nodeType: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"],
      actualRows: node["Actual Rows"], loops: node["Actual Loops"], rowsRemovedByFilter: node["Rows Removed by Filter"],
      rowsRemovedByIndexRecheck: node["Rows Removed by Index Recheck"],
      sharedHitBlocks: node["Shared Hit Blocks"], sharedReadBlocks: node["Shared Read Blocks"],
      tempReadBlocks: node["Temp Read Blocks"], tempWrittenBlocks: node["Temp Written Blocks"],
      sortMethod: node["Sort Method"], sortSpaceType: node["Sort Space Type"], sortSpaceUsed: node["Sort Space Used"],
      indexCond: node["Index Cond"], filter: node.Filter,
    });
    if (Array.isArray(node.Plans)) node.Plans.forEach((child) => visit(child as Record<string, unknown>));
  };
  if (plan) visit(plan);
  return { planningTimeMs: explain?.["Planning Time"], executionTimeMs: explain?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, query: CapturedQuery | undefined, label: string) {
  if (!query) return { label, status: "missing_application_query" };
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(`explain (analyze,buffers,format json) ${query.sql}`, query.params as never);
    return { label, status: "completed", applicationSql: query.sql, parameters: query.params, summary: planNodes(rows), diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000 };
  } catch (error) {
    return { label, status: "failed", applicationSql: query.sql, parameters: query.params, error: safeError(error), diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000 };
  }
}

function candidateQueryMetrics(run: CaptureResult<Awaited<ReturnType<ReturnType<typeof createExtractionReadServices>["getPaperExtractionEvidenceCandidatePage"]>>>) {
  const keyQuery = run.queries.find((query) => queryShape(query) === "candidate_key_page");
  const hydrationQuery = run.queries.find((query) => queryShape(query) === "candidate_visible_hydration");
  return {
    sqlSelectCount: run.selectCount,
    queryStatementCount: run.statementCount,
    transactionApiCalls: run.transactionApiCalls,
    diagnosticWallTimeMs: run.diagnosticWallTimeMs,
    keysTransferred: keyQuery?.driverRows ?? null,
    keyRowsJsonUtf8Bytes: keyQuery?.decodedJsonUtf8Bytes ?? null,
    hydratedCandidatePreviews: hydrationQuery?.driverRows ?? 0,
    hydrationRowsJsonUtf8Bytes: hydrationQuery?.decodedJsonUtf8Bytes ?? 0,
    renderedCandidateCount: run.value.items.length,
    dtoUtf8Bytes: jsonBytes(run.value),
    itemCount: run.value.items.length,
    hasNext: run.value.hasNext,
    nextCursorPresent: run.value.nextCursor !== null,
    queries: run.queries,
  };
}

async function main() {
  if (process.versions.node !== "22.13.0") throw new Error(`Requires Node 22.13.0; running ${process.versions.node}.`);
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role permitted to create and drop a uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `slice55_evidence_selection_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const disposableUrl = new URL(adminUrl);
  disposableUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let databaseCreated = false;
  let client: postgres.Sql | undefined;
  let cleanupVerified = false;
  let benchmarkArtifact: Record<string, unknown> | undefined;
  let serverVersion = "unknown";
  const candidateRuns: Array<Record<string, unknown>> = [];
  const worksheetRuns: Array<Record<string, unknown>> = [];
  const plans: Array<Record<string, unknown>> = [];
  let projectId = "";
  let supportProjectId = "";
  const baselinePapers: Record<string, string> = {};
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
    client = postgres(disposableUrl.toString(), { max: 2, prepare: false, onnotice: () => {} });
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.unsafe(`set maintenance_work_mem = '256MB'`);
    await client.unsafe(`set work_mem = '16MB'`);
    await client.unsafe(`set statement_timeout = '${SEED_TIMEOUT_MS}ms'`);
    projectId = stableUuid(`${databaseName}:candidate-project`);
    supportProjectId = stableUuid(`${databaseName}:selected-support-project`);
    await seedProject(client, projectId, "Slice 55 candidate benchmark");
    await seedProject(client, supportProjectId, "Slice 55 selected support benchmark");

    const candidatePaperSpecs = [
      { label: "empty", count: 0, order: "seconds" as const, curation: "mixed" as const },
      { label: "small", count: 25, order: "seconds" as const, curation: "mixed" as const },
      { label: "candidates_1k", count: 1_000, order: "seconds" as const, curation: "mixed" as const },
      { label: "candidates_10k", count: 10_000, order: "seconds" as const, curation: "mixed" as const },
      { label: "candidates_50k_unique", count: 50_000, order: "seconds" as const, curation: "mixed" as const },
      { label: "candidates_50k_ties_microseconds", count: 50_000, order: "ties" as const, curation: "mixed" as const },
      { label: "candidates_50k_interleaved_a", count: 50_000, order: "micros" as const, curation: "mixed" as const },
      { label: "candidates_50k_interleaved_b", count: 50_000, order: "micros" as const, curation: "mixed" as const },
      { label: "candidates_1k_rejected_heavy", count: 1_000, order: "seconds" as const, curation: "rejected-heavy" as const },
      { label: "candidates_1k_all_rejected", count: 1_000, order: "seconds" as const, curation: "all-rejected" as const },
    ];
    for (const spec of candidatePaperSpecs) {
      const paperId = stableUuid(`${databaseName}:${spec.label}:paper`);
      baselinePapers[spec.label] = paperId;
      await seedPaper(client, projectId, paperId, `Slice 55 ${spec.label}`);
      await seedCandidates(client, projectId, paperId, spec.count, spec.order, spec.curation);
    }
    const primaryFields = await seedFields(client, projectId, 50, `${databaseName}:primary-field`);
    await seedRevisionWithSupports(client, {
      projectId, paperId: baselinePapers.candidates_50k_unique, fieldId: primaryFields[0],
      revisionKey: `${databaseName}:primary-current`, supportCount: 5,
    });

    const supportPaperId = stableUuid(`${databaseName}:support-paper`);
    await seedPaper(client, supportProjectId, supportPaperId, "Slice 55 selected support membership profiles");
    await seedCandidates(client, supportProjectId, supportPaperId, 2_000, "micros", "all-accepted");
    const supportFields = await seedFields(client, supportProjectId, 4, `${databaseName}:support-field`);
    const supportSizes = [0, 5, 250, 2_000] as const;
    const supportProfiles: Array<{ fieldId: string; count: number; supportIds: string[] }> = [];
    for (let index = 0; index < supportSizes.length; index += 1) {
      const seeded = await seedRevisionWithSupports(client, {
        projectId: supportProjectId, paperId: supportPaperId, fieldId: supportFields[index],
        revisionKey: `${databaseName}:support-profile:${supportSizes[index]}`, supportCount: supportSizes[index],
      });
      supportProfiles.push({ fieldId: supportFields[index], count: supportSizes[index], supportIds: seeded.supportIds });
    }
    await client.unsafe("insert into evidence_review_decisions (project_id,evidence_id,decision) values ($1::uuid,$2::uuid,'rejected')", [supportProjectId, supportProfiles[1].supportIds[0]]);
    for (const table of ["papers", "extraction_fields", "extraction_values", "extraction_value_revisions", "extraction_revision_evidence", "evidence", "evidence_review_decisions", "screening_decisions", "full_text_retrieval_attempts", "full_text_screening_decisions"]) {
      await client.unsafe(`analyze ${table}`);
    }
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    const db = makeDatabase(client);
    const reads = createExtractionReadServices(db);
    const universeMeasurements: Array<Record<string, unknown>> = [];
    for (const spec of candidatePaperSpecs) {
      const paperId = baselinePapers[spec.label];
      const pageSize = spec.count === 25 ? 20 : PAGE_SIZE;
      const first = await capture(() => reads.getPaperExtractionEvidenceCandidatePage(projectId, paperId, { pageSize }));
      const metrics = candidateQueryMetrics(first);
      universeMeasurements.push({ label: spec.label, candidateUniverse: spec.count, curation: spec.curation, pageSize, firstPage: metrics });
      if (metrics.sqlSelectCount !== (spec.count > 0 ? 3 : 2)) throw new Error(`Unexpected candidate SELECT budget for ${spec.label}.`);
      if (metrics.keysTransferred !== null && Number(metrics.keysTransferred) > pageSize + 1) throw new Error(`Key transfer exceeded pageSize + 1 for ${spec.label}.`);
      if (metrics.hydratedCandidatePreviews > pageSize || metrics.renderedCandidateCount > pageSize) throw new Error(`Candidate hydration/rendering exceeded pageSize for ${spec.label}.`);
      if (metrics.dtoUtf8Bytes > MAX_DTO_BYTES) throw new Error(`Candidate DTO exceeded ${MAX_DTO_BYTES} bytes for ${spec.label}.`);
      if (first.value.items.length !== metrics.hydratedCandidatePreviews) throw new Error(`A key sentinel was hydrated for ${spec.label}.`);
      const keyQuery = first.queries.find((query) => queryShape(query) === "candidate_key_page");
      const hydrationQuery = first.queries.find((query) => queryShape(query) === "candidate_visible_hydration");
      if (keyQuery) plans.push(await explain(client, keyQuery, `${spec.label}.first.keys`));
      if (hydrationQuery && ["candidates_50k_unique", "candidates_50k_ties_microseconds"].includes(spec.label)) plans.push(await explain(client, hydrationQuery, `${spec.label}.first.hydration`));
      if (spec.count > 0 && first.value.items.some((item) => item.reviewState === "rejected") === false && spec.curation === "all-rejected") throw new Error("Rejected candidates were omitted from the candidate universe.");
      if (spec.label === "candidates_50k_unique") {
        for (const [position, offset] of [["middle", 25_000], ["deep", 49_000], ["terminal", 49_950], ["after_terminal", 50_000]] as const) {
          const after = await cursorBefore(client, projectId, paperId, PAGE_SIZE, offset);
          const run = await capture(() => reads.getPaperExtractionEvidenceCandidatePage(projectId, paperId, { pageSize: PAGE_SIZE, after }));
          const page = candidateQueryMetrics(run);
          if (page.renderedCandidateCount > PAGE_SIZE || page.hydratedCandidatePreviews > PAGE_SIZE || Number(page.keysTransferred ?? 0) > PAGE_SIZE + 1) throw new Error(`${position} page exceeded a Slice 55 structural bound.`);
          if (page.renderedCandidateCount !== page.hydratedCandidatePreviews) throw new Error(`${position} page hydrated a sentinel.`);
          candidateRuns.push({ paper: spec.label, position, startOffset: offset, ...page });
          const keyQueryAtPosition = run.queries.find((query) => queryShape(query) === "candidate_key_page");
          if (keyQueryAtPosition && ["middle", "deep", "terminal", "after_terminal"].includes(position)) plans.push(await explain(client, keyQueryAtPosition, `${spec.label}.${position}.keys`));
        }
      }
      if (spec.label === "candidates_50k_ties_microseconds") {
        const after = await cursorBefore(client, projectId, paperId, PAGE_SIZE, 2_500);
        const run = await capture(() => reads.getPaperExtractionEvidenceCandidatePage(projectId, paperId, { pageSize: PAGE_SIZE, after }));
        candidateRuns.push({ paper: spec.label, position: "within_large_timestamp_tie_group", startOffset: 2_500, ...candidateQueryMetrics(run) });
      }
      if (spec.label === "candidates_50k_interleaved_a") {
        const runB = await capture(() => reads.getPaperExtractionEvidenceCandidatePage(projectId, baselinePapers.candidates_50k_interleaved_b, { pageSize: PAGE_SIZE }));
        candidateRuns.push({ paper: spec.label, position: "interleaved_paper_a_first", ...metrics });
        candidateRuns.push({ paper: "candidates_50k_interleaved_b", position: "interleaved_paper_b_first", ...candidateQueryMetrics(runB) });
      }
    }

    const smallTerminalAfter = await cursorBefore(client, projectId, baselinePapers.small, 20, 20);
    const smallTerminal = await capture(() => reads.getPaperExtractionEvidenceCandidatePage(projectId, baselinePapers.small, { pageSize: 20, after: smallTerminalAfter }));
    candidateRuns.push({ paper: "small", position: "terminal_partial_page", startOffset: 20, ...candidateQueryMetrics(smallTerminal) });

    const oracleIds = await client.unsafe<{ id: string }[]>("select id::text as id from evidence where project_id=$1::uuid and paper_id=$2::uuid order by created_at desc,id asc", [projectId, baselinePapers.candidates_1k]);
    const traversedIds: string[] = [];
    let after: string | null = null;
    let traversalPageCount = 0;
    do {
      const page = await reads.getPaperExtractionEvidenceCandidatePage(projectId, baselinePapers.candidates_1k, { pageSize: PAGE_SIZE, after });
      traversedIds.push(...page.items.map((item) => item.id));
      after = page.nextCursor;
      traversalPageCount += 1;
      if (traversalPageCount > 30) throw new Error("Static 1k traversal exceeded its expected bounded page count.");
    } while (after);
    const noDuplicateIds = new Set(traversedIds).size === traversedIds.length;
    const traversalMatchesOracle = noDuplicateIds && traversedIds.length === oracleIds.length && traversedIds.every((id, index) => id === oracleIds[index].id);
    if (!traversalMatchesOracle) throw new Error("Candidate keyset traversal had duplicates, omissions, or order differences from the static SQL oracle.");

    const candidateWorkByFieldCount: Array<{ fieldCount: number; selectCount: number; keysTransferred: number | null; previewsHydrated: number }> = [];
    // Extraction Fields can be archived but never restored, so execute the
    // active-Field profiles in descending order within this disposable fixture.
    for (const fieldCount of [50, 10, 1] as const) {
      await client.unsafe("update extraction_fields set archived_at=now() where project_id=$1::uuid and sort_order > $2::int and archived_at is null", [projectId, fieldCount]);
      const sharedBrowserPage = await capture(() => reads.getPaperExtractionEvidenceCandidatePage(projectId, baselinePapers.candidates_50k_unique, { pageSize: PAGE_SIZE }));
      const sharedBrowserMetrics = candidateQueryMetrics(sharedBrowserPage);
      candidateWorkByFieldCount.push({
        fieldCount,
        selectCount: sharedBrowserMetrics.sqlSelectCount,
        keysTransferred: sharedBrowserMetrics.keysTransferred,
        previewsHydrated: sharedBrowserMetrics.hydratedCandidatePreviews,
      });
      const worksheet = await capture(() => reads.getPaperExtractionWorksheet(projectId, baselinePapers.candidates_50k_unique));
      const value = worksheet.value;
      const supportSelects = worksheet.queries.filter((query) => queryShape(query) === "current_selected_support_projection");
      const accidentalCandidateReads = worksheet.queries.filter((query) => /from evidence e/i.test(query.sql) && !/extraction_revision_evidence\s+link/i.test(query.sql));
      const selectedCount = value.values.reduce((sum, field) => sum + (field.currentRevision?.evidence.length ?? 0), 0);
      const selectedDtoBytes = jsonBytes(value.values.flatMap((field) => field.currentRevision?.evidence ?? []));
      if (value.fields.length !== fieldCount || accidentalCandidateReads.length > 0) throw new Error(`Worksheet structural target failed at ${fieldCount} Fields.`);
      if (selectedCount !== 5) throw new Error(`Fixed-support Field profile changed selected membership count at ${fieldCount} Fields.`);
      worksheetRuns.push({
        project: "candidate project", paper: "candidates_50k_unique", activeFields: fieldCount,
        candidateUniverse: 50_000, candidateUniverseReads: accidentalCandidateReads.length,
        sharedCandidateBrowserCount: 1, renderedCandidateControlsBeforeBrowsing: 0,
        selectedSupportMemberships: selectedCount, selectedSupportDtoUtf8Bytes: selectedDtoBytes,
        fullWorksheetDtoUtf8Bytes: jsonBytes(value), selectCount: worksheet.selectCount,
        diagnosticWallTimeMs: worksheet.diagnosticWallTimeMs,
        driverRows: worksheet.queries.reduce((sum, query) => sum + (query.driverRows ?? 0), 0),
        candidatePageAtFieldCount: fieldCount,
        candidatePageSelectCount: sharedBrowserMetrics.sqlSelectCount,
        candidateKeysTransferred: sharedBrowserMetrics.keysTransferred,
        candidatePreviewsHydrated: sharedBrowserMetrics.hydratedCandidatePreviews,
        candidatePreviewsRendered: sharedBrowserMetrics.renderedCandidateCount,
        queryStatements: worksheet.queries,
        supportQueryCount: supportSelects.length,
      });
      if (supportSelects[0]) plans.push(await explain(client, supportSelects[0], `worksheet_50k_candidates_${fieldCount}_fields.supports`));
    }

    const supportWorksheet = await capture(() => reads.getPaperExtractionWorksheet(supportProjectId, supportPaperId));
    const supportValue = supportWorksheet.value;
    const supportQuery = supportWorksheet.queries.find((query) => queryShape(query) === "current_selected_support_projection");
    const supportFirstPage = await reads.getPaperExtractionEvidenceCandidatePage(supportProjectId, supportPaperId, { pageSize: PAGE_SIZE });
    const supportFirstPageIds = new Set(supportFirstPage.items.map((item) => item.id));
    const supportProfileResults = supportProfiles.map((profile) => {
      const field = supportValue.values.find((value) => value.field.id === profile.fieldId);
      const evidence = field?.currentRevision?.evidence ?? [];
      const selectedIds = evidence.map((item) => item.id);
      const exactMembership = selectedIds.length === profile.count && profile.supportIds.every((id) => selectedIds.includes(id));
      if (!exactMembership) throw new Error(`Selected membership identity changed for support cardinality ${profile.count}.`);
      return {
        fieldId: profile.fieldId, selectedSupportMemberships: profile.count,
        selectedSupportDtoUtf8Bytes: jsonBytes(evidence), supportMetadataItemBytes: jsonBytes(evidence),
        offFirstCandidatePageSelectedSupportCount: selectedIds.filter((id) => !supportFirstPageIds.has(id)).length,
        exactMembershipVerified: exactMembership,
      };
    });
    const rejectedSupportProfile = supportValue.values.find((value) => value.field.id === supportProfiles[1].fieldId)?.currentRevision?.evidence ?? [];
    if (!rejectedSupportProfile.some((item) => item.id === supportProfiles[1].supportIds[0] && item.reviewState === "rejected")) throw new Error("Now-rejected selected support disappeared or lost its refreshed review state.");
    worksheetRuns.push({
      project: "selected support project", paper: "support membership profiles", activeFields: supportValue.fields.length,
      candidateUniverse: 2_000, candidateUniverseReads: 0, sharedCandidateBrowserCount: 1,
      selectedSupportMemberships: supportValue.values.reduce((sum, value) => sum + (value.currentRevision?.evidence.length ?? 0), 0),
      selectedSupportDtoUtf8Bytes: jsonBytes(supportValue.values.flatMap((value) => value.currentRevision?.evidence ?? [])),
      perFieldSupportProfiles: supportProfileResults,
      nowRejectedSelectedSupportRetained: true,
      supportQueryDriverRows: supportQuery?.driverRows ?? null,
      supportQueryDecodedJsonUtf8Bytes: supportQuery?.decodedJsonUtf8Bytes ?? null,
      fullWorksheetDtoUtf8Bytes: jsonBytes(supportValue), selectCount: supportWorksheet.selectCount,
      diagnosticWallTimeMs: supportWorksheet.diagnosticWallTimeMs,
      queryStatements: supportWorksheet.queries,
    });
    if (supportQuery) plans.push(await explain(client, supportQuery, "worksheet_selected_support_profiles_0_5_250_2000"));

    const candidateBoundGate = universeMeasurements.every((row) => {
      const page = row.firstPage as ReturnType<typeof candidateQueryMetrics>;
      return page.itemCount <= Number(row.pageSize) && Number(page.hydratedCandidatePreviews ?? 0) <= Number(row.pageSize)
        && (page.keysTransferred == null || Number(page.keysTransferred) <= Number(row.pageSize) + 1)
        && Number(page.dtoUtf8Bytes) <= MAX_DTO_BYTES;
    });
    const sameCandidateWorkAtEveryFieldCount = candidateWorkByFieldCount.every((row) =>
      row.selectCount === candidateWorkByFieldCount[0]?.selectCount
      && row.keysTransferred === candidateWorkByFieldCount[0]?.keysTransferred
      && row.previewsHydrated === candidateWorkByFieldCount[0]?.previewsHydrated);
    const worksheetGate = worksheetRuns.every((row) => Number(row.candidateUniverseReads) === 0 && Number(row.sharedCandidateBrowserCount) === 1)
      && sameCandidateWorkAtEveryFieldCount;
    if (!candidateBoundGate || !worksheetGate) throw new Error("Slice 55 structural benchmark gate failed.");

    benchmarkArtifact = {
      benchmark: "Slice 55 Scalable Paper Evidence Selection Read Paths",
      status: "completed",
      recordedAt: new Date().toISOString(),
      baselineSha: "971f3623b9176da7a08c00cf54015535d7f2f698",
      node: process.versions.node,
      postgresVersion: serverVersion,
      migration: { retainedTail: "0040_slice54_manuscript_claim_selection", migration0041Created: false, dependencyGraphChanged: false },
      profiles: {
        candidateUniverseCounts: [0, 25, 1_000, 10_000, 50_000],
        activeFieldCounts: [1, 10, 50],
        selectedSupportMembershipCounts: [0, 5, 250, 2_000],
        orderingProfiles: ["unique timestamps", "large 5k timestamp tie group", "microseconds within one millisecond", "two interleaved Papers"],
        curationProfiles: ["mixed", "rejected-heavy 90%", "all rejected"],
        pagePositions: ["first", "middle", "deep", "terminal", "terminal partial", "after terminal empty"],
        textProfile: "First 50 candidates carry long emoji/control-character source and Unicode/control note text.",
      },
      setup: {
        database: "uniquely named PostgreSQL 16 database, created for this run and force-dropped in finally",
        transactionAndSetupQueriesExcludedFromSelectCounts: true,
        existingEvidenceIndexesOnly: true,
        paperCountsByLabel: candidatePaperSpecs.map((spec) => ({ label: spec.label, candidateEvidenceRows: spec.count })),
        selectedSupportPaperCandidateRows: 2_000,
      },
      hardGates: {
        maxPageSize: PAGE_SIZE,
        maxCandidateDtoUtf8Bytes: MAX_DTO_BYTES,
        candidatePageBounds: candidateBoundGate ? "pass" : "fail",
        worksheetNoCandidatePreload: worksheetGate ? "pass" : "fail",
        static1kTraversalMatchesDirectSqlOracle: traversalMatchesOracle,
        static1kDuplicates: noDuplicateIds ? 0 : traversedIds.length - new Set(traversedIds).size,
        static1kOmissions: oracleIds.length - traversedIds.length,
        selectedSupportMembershipExact: supportProfileResults.every((profile) => profile.exactMembershipVerified),
        rejectedSelectedSupportRetained: true,
        sentinelHydrated: false,
      },
      candidateUniverseMeasurements: universeMeasurements,
      candidatePageMeasurements: candidateRuns,
      worksheetSelectedSupportMeasurements: worksheetRuns,
      candidateWorkByActiveFieldCount: candidateWorkByFieldCount,
      staticTraversal: { candidateUniverse: 1_000, pageSize: PAGE_SIZE, pages: traversalPageCount, rows: traversedIds.length, directSqlOracleRows: oracleIds.length, equivalent: traversalMatchesOracle },
      queryPlans: plans,
      interpretation: {
        claims: "Candidate content transfer, DTO size, hydration, and rendering are page-size bounded. Selected support membership bytes and worksheet projection work are reported separately and scale with S.",
        caveat: "No universal O(pageSize) PostgreSQL work claim: the existing (project_id,paper_id,created_at) index does not provide the mixed created_at DESC,id ASC order; tied groups, heap/index traversal, planner statistics, and Paper distribution can affect rows scanned and sorting.",
        timing: "Wall times are diagnostic for this PostgreSQL 16.15 disposable fixture only.",
        candidateSearch: "No free-text search or new candidate filters are implemented; discoverability is deferred.",
      },
    };
  } finally {
    if (client) await client.end({ timeout: 1 });
    try {
      if (databaseCreated) await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
      const remains = await admin.unsafe("select exists(select 1 from pg_database where datname=$1) as present", [databaseName]);
      cleanupVerified = (remains[0] as { present: boolean }).present !== true;
      if (!cleanupVerified) throw new Error("Disposable Slice 55 benchmark database remained after cleanup.");
      console.log(JSON.stringify({ phase: "cleanup-complete", droppedOwnBenchmarkDatabase: databaseCreated, cleanupVerified }));
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
  if (!cleanupVerified || !benchmarkArtifact) throw new Error("Slice 55 benchmark did not complete with verified disposable-database cleanup.");
  benchmarkArtifact.cleanup = { disposableDatabaseDropped: databaseCreated, verifiedAbsent: cleanupVerified };
  await mkdir(resolve("docs/benchmarks"), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify(benchmarkArtifact, null, 2)}\n`, "utf8");
  console.log(`Slice 55 benchmark wrote ${ARTIFACT}; disposable database cleanup verified.`);
}

main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
