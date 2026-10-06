import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createExtractionReadServices } from "@/application/extraction-read-services";
import { createExtractionHistoryReadServices } from "@/application/extraction-history-read-services";
import { encodeExtractionHistoryCursor } from "@/application/extraction-history-cursor";
import { createReviewServices } from "@/application/services";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";
import type { Database } from "@/db/client";

const POPULATIONS = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const HISTORY_INDEX = "extraction_value_revisions_project_paper_field_sequence_id_idx";
const ARTIFACT = resolve("docs/benchmarks/slice53-extraction-history-read-paths.json");
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_TIMEOUT_MS = 600_000;

type CapturedQuery = { sql: string; params: unknown[] };
type Measurement = {
  label: string;
  status: "completed" | "failed";
  diagnosticWallTimeMs: number;
  selectCount: number;
  queryStatementCount: number;
  nonSelectStatementCount: number;
  transactionSetupStatementCount: number;
  transactionApiCalls: number;
  driverRows: number;
  driverDecodedUtf8Bytes: number;
  dtoUtf8Bytes: number | null;
  queryStatements: CapturedQuery[];
  valueSummary?: unknown;
  error?: string;
};
type QuerySink = { queries: CapturedQuery[]; driverRows: number; decodedBytes: number; transactionApiCalls: number };
type Anchor = { id: string; sequence: string };
type Corpus = { label: string; projectId: string; paperId: string; fieldId: string; slotId: string; population: number; evidencePerCurrentRevision: number };
type WorksheetScenario = { label: string; projectId: string; paperId: string; fieldCount: number; revisionsPerField: number; evidenceCount: number };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error: unknown) {
  const row = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : undefined;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    code: String(row?.code ?? row?.cause?.code ?? ""),
    message: message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 1_500),
  };
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

const SEQUENCE_TRANSFER_SENTINEL = "0".repeat(20);

function sequenceNormalizedDtoMetrics(value: unknown) {
  let sequenceCount = 0;
  let sequenceCharacters = 0;
  const serialized = JSON.stringify(value, (key, item) => {
    if (key === "sequence" && (typeof item === "string" || typeof item === "number" || typeof item === "bigint")) {
      sequenceCount += 1;
      sequenceCharacters += String(item).length;
      return SEQUENCE_TRANSFER_SENTINEL;
    }
    return typeof item === "bigint" ? item.toString() : item;
  });
  return {
    normalizedUtf8Bytes: Buffer.byteLength(serialized, "utf8"),
    sequenceCount,
    sequenceCharacters,
  };
}

function summarizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const evidenceCount = value.reduce((sum, row) => sum + (Array.isArray((row as { evidence?: unknown[] }).evidence) ? (row as { evidence: unknown[] }).evidence.length : 0), 0);
    return { rowCount: value.length, evidenceMembershipCount: evidenceCount };
  }
  if (value === null || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const values = Array.isArray(row.values) ? row.values as Array<{ currentRevision?: { evidence?: unknown[] } | null }> : [];
  const items = Array.isArray(row.items) ? row.items : [];
  const evidenceRows = Array.isArray(row.evidence) ? row.evidence.length : 0;
  return {
    keys: Object.keys(row).slice(0, 24),
    itemCount: items.length || undefined,
    worksheetFieldCount: values.length || undefined,
    currentEvidenceMemberships: values.reduce((sum, item) => sum + (item.currentRevision?.evidence?.length ?? 0), 0) || undefined,
    paperEvidencePickerRows: evidenceRows || undefined,
    hasMore: row.hasMore,
    nextCursorPresent: typeof row.nextCursor === "string" && row.nextCursor.length > 0,
  };
}

const querySink: QuerySink = { queries: [], driverRows: 0, decodedBytes: 0, transactionApiCalls: 0 };
const countedClients = new WeakMap<object, postgres.Sql>();

function countedResult(query: object): object {
  return new Proxy(query, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (property === "then" && typeof member === "function") {
        return (resolveValue: ((value: unknown) => unknown) | undefined, reject: ((reason: unknown) => unknown) | undefined) => Reflect.apply(member, target, [
          (result: unknown) => {
            if (Array.isArray(result)) {
              querySink.driverRows += result.length;
              querySink.decodedBytes += jsonBytes(result);
            }
            return resolveValue ? resolveValue(result) : result;
          },
          reject,
        ]);
      }
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const next = Reflect.apply(member, target, args) as unknown;
        return next && typeof next === "object" && typeof (next as { then?: unknown }).then === "function" ? countedResult(next) : next;
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
          const result = Reflect.apply(member, target, args) as unknown;
          return result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function" ? countedResult(result) : result;
        };
      }
      if (property === "begin" && typeof member === "function") {
        return (...args: unknown[]) => {
          if (typeof args[0] !== "function") return Reflect.apply(member, target, args);
          querySink.transactionApiCalls += 1;
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
    logger: { logQuery(query, params) { querySink.queries.push({ sql: query, params: [...params] }); } },
  }) as Database;
}

async function measured<T>(label: string, operation: () => Promise<T>): Promise<{ measurement: Measurement; value: T | null }> {
  querySink.queries.length = 0;
  querySink.driverRows = 0;
  querySink.decodedBytes = 0;
  querySink.transactionApiCalls = 0;
  const started = process.hrtime.bigint();
  try {
    const value = await operation();
    const statements = [...querySink.queries];
    const selectCount = statements.filter(({ sql: query }) => /^(with|select)\b/i.test(query.trim())).length;
    const transactionSetupStatementCount = statements.filter(({ sql: query }) => /^set\b/i.test(query.trim())).length;
    return {
      value,
      measurement: {
        label,
        status: "completed",
        diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        selectCount,
        queryStatementCount: statements.length,
        nonSelectStatementCount: statements.length - selectCount,
        transactionSetupStatementCount,
        transactionApiCalls: querySink.transactionApiCalls,
        driverRows: querySink.driverRows,
        driverDecodedUtf8Bytes: querySink.decodedBytes,
        dtoUtf8Bytes: jsonBytes(value),
        queryStatements: statements,
        valueSummary: summarizeValue(value),
      },
    };
  } catch (error) {
    const statements = [...querySink.queries];
    const selectCount = statements.filter(({ sql: query }) => /^(with|select)\b/i.test(query.trim())).length;
    const transactionSetupStatementCount = statements.filter(({ sql: query }) => /^set\b/i.test(query.trim())).length;
    return {
      value: null,
      measurement: {
        label,
        status: "failed",
        diagnosticWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        selectCount,
        queryStatementCount: statements.length,
        nonSelectStatementCount: statements.length - selectCount,
        transactionSetupStatementCount,
        transactionApiCalls: querySink.transactionApiCalls,
        driverRows: querySink.driverRows,
        driverDecodedUtf8Bytes: querySink.decodedBytes,
        dtoUtf8Bytes: null,
        queryStatements: statements,
        error: safeError(error).message,
      },
    };
  }
}

async function seedScenario(
  client: postgres.Sql,
  projectId: string,
  key: string,
  label: string,
  fieldCount: number,
  revisionsPerField: number,
  evidenceCount: number,
): Promise<WorksheetScenario> {
  const paperId = stableUuid(`${key}:paper`);
  await client.unsafe("INSERT INTO papers (id,project_id,title) VALUES ($1::uuid,$2::uuid,$3::text)", [paperId, projectId, label]);
  await client.unsafe("INSERT INTO screening_decisions (project_id,paper_id,decision) VALUES ($1::uuid,$2::uuid,'include')", [projectId, paperId]);
  await client.unsafe("INSERT INTO full_text_retrieval_attempts (project_id,paper_id,outcome,attempted_at) VALUES ($1::uuid,$2::uuid,'retrieved',now())", [projectId, paperId]);
  await client.unsafe("INSERT INTO full_text_screening_decisions (project_id,paper_id,decision) VALUES ($1::uuid,$2::uuid,'include')", [projectId, paperId]);
  if (fieldCount > 0) {
    await client.unsafe(
      `INSERT INTO extraction_fields (id,project_id,name,field_type,sort_order)
       SELECT ${uuidSql("$3::text || ':field:' || field_n::text")},$1::uuid,'Benchmark Field '||field_n,'short_text',field_n-1
       FROM generate_series(1,$2::int) AS field_n`,
      [projectId, fieldCount, key],
    );
    await client.unsafe(
      `INSERT INTO extraction_values (id,project_id,paper_id,field_id)
       SELECT ${uuidSql("$3::text || ':slot:' || field_n::text")},$1::uuid,$2::uuid,
         ${uuidSql("$3::text || ':field:' || field_n::text")}
       FROM generate_series(1,$4::int) AS field_n`,
      [projectId, paperId, key, fieldCount],
    );
    if (revisionsPerField > 0) {
      await client.unsafe(
        `INSERT INTO extraction_value_revisions (
           sequence,id,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,researcher_note,finalized_at
         ) OVERRIDING SYSTEM VALUE
         SELECT 1000000000000::bigint + field_n::bigint*1000000 + revision_n::bigint,
           ${uuidSql("$3::text || ':field:' || field_n::text || ':revision:' || revision_n::text")},
           $1::uuid,$2::uuid,${uuidSql("$3::text || ':field:' || field_n::text")},
           ${uuidSql("$3::text || ':slot:' || field_n::text")},'short_text','present',
           'Benchmark current value for field '||field_n,'Benchmark researcher note',null
         FROM generate_series(1,$4::int) AS field_n
         CROSS JOIN generate_series(1,$5::int) AS revision_n`,
        [projectId, paperId, key, fieldCount, revisionsPerField],
      );
    }
  }
  if (evidenceCount > 0) {
    await client.unsafe(
      `INSERT INTO evidence (id,project_id,paper_id,source_text,page_number,note)
       SELECT ${uuidSql("$3::text || ':evidence:' || evidence_n::text")},$1::uuid,$2::uuid,
         'Benchmark source passage '||evidence_n,evidence_n,'Synthetic fixture'
       FROM generate_series(1,$4::int) AS evidence_n`,
      [projectId, paperId, key, evidenceCount],
    );
    if (fieldCount > 0 && revisionsPerField > 0) {
      await client.unsafe(
        `WITH current_revisions AS MATERIALIZED (
         SELECT DISTINCT ON (revision.field_id) revision.id
           FROM extraction_value_revisions revision
           WHERE revision.project_id=$1::uuid AND revision.paper_id=$2::uuid
           ORDER BY revision.field_id,revision.sequence DESC
         ), evidence_rows AS MATERIALIZED (
           SELECT id FROM evidence WHERE project_id=$1::uuid AND paper_id=$2::uuid
         )
         INSERT INTO extraction_revision_evidence (project_id,paper_id,revision_id,evidence_id)
         SELECT $1::uuid,$2::uuid,current_revisions.id,evidence_rows.id
         FROM current_revisions CROSS JOIN evidence_rows`,
        [projectId, paperId],
      );
    }
  }
  if (revisionsPerField > 0) {
    await client.unsafe(
      "UPDATE extraction_value_revisions SET finalized_at=now() WHERE project_id=$1::uuid AND paper_id=$2::uuid AND finalized_at IS NULL",
      [projectId, paperId],
    );
  }
  return { label, projectId, paperId, fieldCount, revisionsPerField, evidenceCount };
}

async function anchor(client: postgres.Sql, projectId: string, paperId: string, fieldId: string, offset: number): Promise<Anchor> {
  const result = await client.unsafe(
    `SELECT id::text AS id,sequence::text AS sequence
     FROM extraction_value_revisions
     WHERE project_id=$1::uuid AND paper_id=$2::uuid AND field_id=$3::uuid AND finalized_at IS NOT NULL
     ORDER BY sequence DESC,id DESC OFFSET $4::int LIMIT 1`,
    [projectId, paperId, fieldId, offset],
  );
  if (!result[0]) throw new Error(`Could not select history cursor anchor at offset ${offset}.`);
  return result[0] as Anchor;
}

function historyCursor(corpus: Corpus, row: Anchor) {
  return encodeExtractionHistoryCursor({
    v: 1,
    projectId: corpus.projectId,
    paperId: corpus.paperId,
    fieldId: corpus.fieldId,
    extractionValueId: corpus.slotId,
    historyType: "extraction-value-revision",
    pageSize: PAGE_SIZE,
    lastSequence: row.sequence,
    lastRevisionId: row.id,
  });
}

function summarizePlan(explainRows: unknown) {
  const rows = explainRows as Array<Record<string, unknown>>;
  const queryPlan = rows[0]?.["QUERY PLAN"];
  const root = Array.isArray(queryPlan) ? queryPlan[0] as Record<string, unknown> | undefined : undefined;
  const nodes: Array<Record<string, unknown>> = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const children = Array.isArray(node.Plans) ? node.Plans as Array<Record<string, unknown>> : [];
    const tupleInputs = children.filter((child) => child["Parent Relationship"] !== "InitPlan" && child["Parent Relationship"] !== "SubPlan");
    const actualRows = typeof node["Actual Rows"] === "number" ? node["Actual Rows"] : null;
    const loops = typeof node["Actual Loops"] === "number" ? node["Actual Loops"] : null;
    const removedByFilter = Number(node["Rows Removed by Filter"] ?? 0);
    const removedByRecheck = Number(node["Rows Removed by Index Recheck"] ?? 0);
    const relation = node["Relation Name"];
    nodes.push({
      nodeType: node["Node Type"],
      relation,
      index: node["Index Name"],
      scanDirection: node["Scan Direction"],
      planRows: node["Plan Rows"],
      actualRows,
      loops,
      actualTuples: actualRows !== null && loops !== null ? actualRows * loops : null,
      indexEntriesExamined: (node["Node Type"] === "Index Scan" || node["Node Type"] === "Index Only Scan") && actualRows !== null && loops !== null
        ? (actualRows + removedByFilter + removedByRecheck) * loops : null,
      heapTuplesVisited: node["Node Type"] === "Index Scan" && actualRows !== null && loops !== null
        ? (actualRows + removedByFilter + removedByRecheck) * loops : null,
      heapFetches: node["Heap Fetches"],
      rowsRemovedByFilter: node["Rows Removed by Filter"],
      rowsRemovedByIndexRecheck: node["Rows Removed by Index Recheck"],
      indexCondition: node["Index Cond"],
      filter: node.Filter,
      sortMethod: node["Sort Method"],
      sortSpaceType: node["Sort Space Type"],
      sortSpaceUsed: node["Sort Space Used"],
      sortInputRows: node["Node Type"] === "Sort" || node["Node Type"] === "Incremental Sort"
        ? tupleInputs.reduce((sum, child) => sum + Number(child["Actual Rows"] ?? 0) * Number(child["Actual Loops"] ?? 0), 0)
        : null,
      sharedHitBlocks: node["Shared Hit Blocks"],
      sharedReadBlocks: node["Shared Read Blocks"],
      tempReadBlocks: node["Temp Read Blocks"],
      tempWrittenBlocks: node["Temp Written Blocks"],
      actualTotalTimeMs: node["Actual Total Time"],
    });
    if (Array.isArray(node.Plans)) node.Plans.forEach(visit);
  }
  if (root?.Plan) visit(root.Plan);
  const rootPlan = root?.Plan && typeof root.Plan === "object" ? root.Plan as Record<string, unknown> : undefined;
  return {
    planningTimeMs: root?.["Planning Time"],
    executionTimeMs: root?.["Execution Time"],
    returnedRows: rootPlan?.["Actual Rows"],
    nodes,
  };
}

async function explainQuery(client: postgres.Sql, query: CapturedQuery | undefined, label: string) {
  if (!query) return { label, status: "missing_application_query" };
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never);
    return {
      label,
      status: "completed",
      explainWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      applicationSql: query.sql,
      parameters: query.params,
      summary: summarizePlan(rows),
    };
  } catch (error) {
    return {
      label,
      status: "failed",
      explainWallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      applicationSql: query.sql,
      parameters: query.params,
      error: safeError(error),
    };
  }
}

function pageQuery(measurement: Measurement) {
  return measurement.queryStatements.find(({ sql: query }) => /^(with|select)\b/i.test(query.trim()) && /page_keys\s+as\s+materialized/i.test(query));
}

function worksheetCurrentQuery(measurement: Measurement) {
  return measurement.queryStatements.find(({ sql: query }) => /^(with|select)\b/i.test(query.trim())
    && /from\s+extraction_fields\s+f\b/i.test(query)
    && /left\s+join\s+lateral/i.test(query)
    && /order\s+by\s+r\.sequence\s+desc\s+limit\s+1/i.test(query));
}

async function main() {
  if (process.versions.node !== "22.13.0") throw new Error(`Expected Node 22.13.0, found ${process.versions.node}.`);
  const baseUrl = resolveDatabaseUrl();
  const admin = postgres(baseUrl, { max: 1, prepare: false, onnotice: () => {} });
  const databaseName = `slice53_extraction_history_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const disposableUrl = new URL(baseUrl);
  disposableUrl.pathname = `/${databaseName}`;
  let databaseCreated = false;
  let appClient: postgres.Sql | undefined;
  let runStatus: "completed" | "failed" = "completed";
  let runError: ReturnType<typeof safeError> | undefined;
  let postgresVersion = "unknown";
  let projectId = "";
  const corpora: Corpus[] = [];
  const worksheetScenarios: WorksheetScenario[] = [];
  const historyMeasurements: Array<Record<string, unknown>> = [];
  const worksheetMeasurements: Array<Record<string, unknown>> = [];
  const measurements: Measurement[] = [];
  const plans: Array<Record<string, unknown>> = [];
  const structuralGate = { status: "pending", pageKeyIndex: HISTORY_INDEX, requiredVisibleKeys: PAGE_SIZE + 1 } as Record<string, unknown>;
  const cleanup: Record<string, unknown> = { status: "not_started" };
  let migrationVersion = 0;
  let historyIndexVerification: Record<string, unknown> = {
    status: "not_checked",
    expectedMigrationTag: "0039_slice53_finalized_extraction_history_keysets",
  };
  try {
    const versionRows = await admin.unsafe("SELECT current_setting('server_version_num') AS version_num,current_setting('server_version') AS version_text");
    const version = Number((versionRows[0] as { version_num: string }).version_num);
    postgresVersion = String((versionRows[0] as { version_text: string }).version_text);
    if (Math.floor(version / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16, found ${postgresVersion}.`);
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const migrationClient = postgres(disposableUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      const migrationDb = drizzle(migrationClient, { schema });
      await migrate(migrationDb, { migrationsFolder: resolve(process.cwd(), "drizzle") });
      const tail = await migrationClient.unsafe("SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1");
      migrationVersion = Number((tail[0] as { id: number }).id);
      const indexRows = await migrationClient.unsafe(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
        [HISTORY_INDEX],
      );
      const indexDefinition = String((indexRows[0] as { indexdef?: string } | undefined)?.indexdef ?? "");
      const normalizedIndexDefinition = indexDefinition.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ").trim();
      const approvedColumns = /\busing btree\s*\(project_id,\s*paper_id,\s*field_id,\s*sequence,\s*id\)/i.test(normalizedIndexDefinition);
      const approvedPredicate = /\bwhere\s+\(?([a-z_][\w.]*\.)?finalized_at\s+is\s+not\s+null\)?\s*$/i.test(normalizedIndexDefinition);
      historyIndexVerification = {
        status: indexRows.length === 1 && approvedColumns && approvedPredicate ? "verified" : "failed",
        expectedMigrationTag: "0039_slice53_finalized_extraction_history_keysets",
        migrationTailId: migrationVersion,
        indexName: HISTORY_INDEX,
        indexPresent: indexRows.length === 1,
        orderedColumnsMatch: approvedColumns,
        finalizedPredicateMatches: approvedPredicate,
        indexDefinition,
      };
      if (historyIndexVerification.status !== "verified") {
        throw new Error("Disposable database migration did not install the approved 0039 history index definition.");
      }
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    appClient = postgres(disposableUrl.toString(), { max: 2, prepare: false, onnotice: () => {} });
    await appClient.unsafe(`SET statement_timeout = '${SEED_TIMEOUT_MS}ms'`);
    projectId = stableUuid(`${databaseName}:project`);
    await appClient.unsafe("INSERT INTO projects (id,title) VALUES ($1::uuid,'Slice 53 extraction history benchmark')", [projectId]);

    for (const population of POPULATIONS) {
      const key = `${databaseName}:history:${population}`;
      const scenario = await seedScenario(appClient, projectId, key, `History ${population}`, 1, population, 10);
      const corpus = {
        label: `history_${population}`,
        projectId,
        paperId: scenario.paperId,
        fieldId: stableUuid(`${key}:field:1`),
        slotId: stableUuid(`${key}:slot:1`),
        population,
        evidencePerCurrentRevision: 10,
      };
      corpora.push(corpus);
    }

    const scenarioSpecs: Array<{ label: string; fields: number; depth: number; evidence: number }> = [
      ...[1, 10, 50].map((fields) => ({ label: `worksheet_fields_${fields}`, fields, depth: 100, evidence: 5 })),
      ...[1, 1_000, 10_000].map((depth) => ({ label: `worksheet_history_${depth}`, fields: 10, depth, evidence: 5 })),
      ...[0, 5, 50].map((evidence) => ({ label: `worksheet_evidence_${evidence}`, fields: 10, depth: 100, evidence })),
    ];
    for (const spec of scenarioSpecs) {
      const scenarioProjectId = stableUuid(`${databaseName}:worksheet-project:${spec.label}`);
      await appClient.unsafe(
        "INSERT INTO projects (id,title) VALUES ($1::uuid,'Slice 53 isolated worksheet benchmark')",
        [scenarioProjectId],
      );
      const paperTitle = spec.label.startsWith("worksheet_history_")
        ? "Worksheet history-depth transfer"
        : `Worksheet ${spec.label}`;
      const scenario = await seedScenario(
        appClient,
        scenarioProjectId,
        `${databaseName}:${spec.label}`,
        paperTitle,
        spec.fields,
        spec.depth,
        spec.evidence,
      );
      worksheetScenarios.push({ ...scenario, label: spec.label });
    }
    await appClient.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await appClient.unsafe("ANALYZE extraction_value_revisions");
    await appClient.unsafe("ANALYZE extraction_revision_evidence");
    await appClient.unsafe("ANALYZE extraction_fields");

    const db = makeDatabase(appClient);
    const historyReads = createExtractionHistoryReadServices(db);
    const extractionReads = createExtractionReadServices(db);
    const legacyServices = createReviewServices(db);

    for (const corpus of corpora) {
      const entry: Record<string, unknown> = { population: corpus.population, pages: {} };
      const first = await measured(`${corpus.label}_first_page`, () => historyReads.getExtractionFieldRevisionHistoryPage(
        corpus.projectId, corpus.paperId, corpus.fieldId, { pageSize: PAGE_SIZE },
      ));
      measurements.push(first.measurement);
      (entry.pages as Record<string, unknown>).first = first.measurement;
      plans.push(await explainQuery(appClient, pageQuery(first.measurement), `${corpus.label}_first_page`));

      const deepAnchor = await anchor(appClient, corpus.projectId, corpus.paperId, corpus.fieldId, Math.floor(corpus.population / 2) - 1);
      const deep = await measured(`${corpus.label}_deep_page`, () => historyReads.getExtractionFieldRevisionHistoryPage(
        corpus.projectId, corpus.paperId, corpus.fieldId, { pageSize: PAGE_SIZE, cursor: historyCursor(corpus, deepAnchor) },
      ));
      measurements.push(deep.measurement);
      (entry.pages as Record<string, unknown>).deep = { anchor: deepAnchor, measurement: deep.measurement };
      const deepPlan = await explainQuery(appClient, pageQuery(deep.measurement), `${corpus.label}_deep_page`);
      plans.push(deepPlan);

      const finalAnchor = await anchor(appClient, corpus.projectId, corpus.paperId, corpus.fieldId, corpus.population - PAGE_SIZE - 1);
      const final = await measured(`${corpus.label}_final_page`, () => historyReads.getExtractionFieldRevisionHistoryPage(
        corpus.projectId, corpus.paperId, corpus.fieldId, { pageSize: PAGE_SIZE, cursor: historyCursor(corpus, finalAnchor) },
      ));
      measurements.push(final.measurement);
      (entry.pages as Record<string, unknown>).final = { anchor: finalAnchor, measurement: final.measurement };
      plans.push(await explainQuery(appClient, pageQuery(final.measurement), `${corpus.label}_final_page`));

      const exactAnchor = await anchor(appClient, corpus.projectId, corpus.paperId, corpus.fieldId, 0);
      const exact = await measured(`${corpus.label}_exact_revision`, () => historyReads.getExtractionRevisionExact(
        corpus.projectId, corpus.paperId, corpus.fieldId, exactAnchor.id,
      ));
      measurements.push(exact.measurement);
      (entry as Record<string, unknown>).exact = { revision: exactAnchor, measurement: exact.measurement };
      const exactSelects = exact.measurement.queryStatements.filter(({ sql: query }) => /^(with|select)\b/i.test(query.trim()));
      plans.push(await explainQuery(appClient, exactSelects[0], `${corpus.label}_exact_ownership`));

      if (corpus.population === 1_000) {
        const legacy = await measured("legacy_full_history_1000", () => legacyServices.getExtractionValueHistory(
          corpus.projectId, corpus.paperId, corpus.fieldId,
        ));
        measurements.push(legacy.measurement);
        (entry as Record<string, unknown>).practicalLegacyHistory = legacy.measurement;
        if (!legacy.value || !Array.isArray(legacy.value) || legacy.value.length !== corpus.population) {
          throw new Error("Legacy 1k ExtractionValue history did not return the full fixture.");
        }
        const orderedLegacy = [...legacy.value].sort((left, right) => {
          const leftRow = left as { sequence: number | string; id: string };
          const rightRow = right as { sequence: number | string; id: string };
          const sequenceOrder = BigInt(String(rightRow.sequence)) - BigInt(String(leftRow.sequence));
          return sequenceOrder === 0n ? (leftRow.id < rightRow.id ? 1 : leftRow.id > rightRow.id ? -1 : 0) : sequenceOrder < 0n ? -1 : 1;
        });
        let cursor: string | null = null;
        const pageItems: Array<Record<string, unknown>> = [];
        let pageTurns = 0;
        do {
          const page = await historyReads.getExtractionFieldRevisionHistoryPage(corpus.projectId, corpus.paperId, corpus.fieldId, { pageSize: PAGE_SIZE, cursor });
          pageItems.push(...page.items as unknown as Array<Record<string, unknown>>);
          cursor = page.nextCursor;
          pageTurns += 1;
          if (pageTurns > 25) throw new Error("Unexpected unbounded history pagination during legacy equivalence check.");
        } while (cursor);
        const legacyIdentity = orderedLegacy.map((value) => {
          const row = value as { id: string; sequence: number | string; evidence: unknown[]; textValue: string | null; valueState: string; fieldType: string };
          return { id: row.id, sequence: String(row.sequence), textValuePreview: row.textValue?.slice(0, 448) ?? null, textValueTruncated: (row.textValue?.length ?? 0) > 448, valueState: row.valueState, fieldType: row.fieldType, evidenceCount: String(row.evidence.length) };
        });
        const pageIdentity = pageItems.map((row) => ({ id: row.id, sequence: row.sequence, textValuePreview: row.textValuePreview, textValueTruncated: row.textValueTruncated, valueState: row.valueState, fieldType: row.fieldType, evidenceCount: row.evidenceCount }));
        (entry as Record<string, unknown>).legacyEquivalence = {
          passed: JSON.stringify(pageIdentity) === JSON.stringify(legacyIdentity),
          legacyRows: legacyIdentity.length,
          concatenatedPageRows: pageIdentity.length,
          pageTurns,
          order: "sequence DESC,id DESC; this safe-sequence fixture has no ties",
        };
        if (JSON.stringify(pageIdentity) !== JSON.stringify(legacyIdentity)) throw new Error("Bounded Extraction history pages differ from the mapped legacy 1k history.");
      }
      historyMeasurements.push(entry);
    }

    for (const scenario of worksheetScenarios) {
      const result = await measured(scenario.label, () => extractionReads.getPaperExtractionWorksheet(scenario.projectId, scenario.paperId));
      measurements.push(result.measurement);
      const currentQuery = worksheetCurrentQuery(result.measurement);
      const currentRows = result.measurement.queryStatements.filter(({ sql: query }) => /^(with|select)\b/i.test(query.trim()) && /from\s+extraction_fields\s+f\b/i.test(query) && /left\s+join\s+lateral/i.test(query));
      const evidenceLinks = await appClient.unsafe(
        `SELECT count(*)::int AS links FROM extraction_revision_evidence link
         JOIN papers paper ON paper.project_id=link.project_id AND paper.id=link.paper_id
         WHERE link.project_id=$1::uuid AND link.paper_id=$2::uuid`,
        [scenario.projectId, scenario.paperId],
      );
      const sequenceMetrics = result.value === null ? null : sequenceNormalizedDtoMetrics(result.value);
      const actualActiveFieldCount = result.value && typeof result.value === "object"
        && Array.isArray((result.value as { values?: unknown }).values)
        ? (result.value as { values: unknown[] }).values.length
        : null;
      const item: Record<string, unknown> = {
        scenario: scenario.label,
        fieldCount: scenario.fieldCount,
        actualActiveFieldCount,
        revisionsPerField: scenario.revisionsPerField,
        totalHistoricalRevisions: scenario.fieldCount * scenario.revisionsPerField,
        paperEvidencePickerRows: scenario.evidenceCount,
        currentRevisionEvidenceLinks: Number((evidenceLinks[0] as { links: number }).links),
        normalizedDtoUtf8Bytes: sequenceMetrics?.normalizedUtf8Bytes ?? null,
        currentRevisionSequenceCount: sequenceMetrics?.sequenceCount ?? null,
        currentRevisionSequenceCharacters: sequenceMetrics?.sequenceCharacters ?? null,
        measurement: result.measurement,
        currentSelectorQueryCount: currentRows.length,
      };
      if (currentQuery && (scenario.label === "worksheet_history_1" || scenario.label === "worksheet_history_10000")) {
        plans.push(await explainQuery(appClient, currentQuery, `${scenario.label}_current_revision_selector`));
      }
      worksheetMeasurements.push(item);
    }

    const deepPlan50k = plans.find((plan) => plan.label === "history_50000_deep_page") as Record<string, unknown> | undefined;
    const deepSummary = deepPlan50k?.summary as { nodes?: Array<Record<string, unknown>> } | undefined;
    const keyNode = deepSummary?.nodes?.find((node) => node.index === HISTORY_INDEX && ["Index Scan", "Index Only Scan"].includes(String(node.nodeType)));
    const oversizedSorts = deepSummary?.nodes?.filter((node) => typeof node.sortInputRows === "number" && node.sortInputRows > PAGE_SIZE + 1) ?? [];
    const keyTuples = Number(keyNode?.actualTuples ?? Number.POSITIVE_INFINITY);
    structuralGate.status = deepPlan50k?.status === "completed" && keyNode !== undefined && keyTuples <= PAGE_SIZE + 1 && oversizedSorts.length === 0 ? "pass" : "fail";
    structuralGate.pageKeyIndexNode = keyNode ?? null;
    structuralGate.pageKeyTuplesObserved = Number.isFinite(keyTuples) ? keyTuples : null;
    structuralGate.oversizedSorts = oversizedSorts;
    structuralGate.explainLabel = "history_50000_deep_page";

    const historyDepthRows = worksheetMeasurements.filter((item) => String(item.scenario).startsWith("worksheet_history_"));
    const historyDepthFlat = historyDepthRows.map((item) => {
      const measure = item.measurement as Measurement;
      return {
        scenario: item.scenario,
        totalHistoricalRevisions: item.totalHistoricalRevisions,
        selectCount: measure.selectCount,
        driverRows: measure.driverRows,
        dtoUtf8Bytes: measure.dtoUtf8Bytes,
        normalizedDtoUtf8Bytes: item.normalizedDtoUtf8Bytes,
        currentRevisionSequenceCount: item.currentRevisionSequenceCount,
        currentRevisionSequenceCharacters: item.currentRevisionSequenceCharacters,
        paperEvidencePickerRows: item.paperEvidencePickerRows,
        currentRevisionEvidenceLinks: item.currentRevisionEvidenceLinks,
      };
    });
    const normalizedHistoryTransferSignatures = new Set(historyDepthFlat.map((row) => JSON.stringify([
      row.selectCount,
      row.driverRows,
      row.normalizedDtoUtf8Bytes,
      row.currentRevisionSequenceCount,
      row.paperEvidencePickerRows,
      row.currentRevisionEvidenceLinks,
    ])));
    const sequenceByteDeltasAccounted = historyDepthFlat.every((row) =>
      typeof row.dtoUtf8Bytes === "number"
      && typeof row.normalizedDtoUtf8Bytes === "number"
      && typeof row.currentRevisionSequenceCount === "number"
      && typeof row.currentRevisionSequenceCharacters === "number"
      && row.dtoUtf8Bytes - row.normalizedDtoUtf8Bytes
        === row.currentRevisionSequenceCharacters - row.currentRevisionSequenceCount * SEQUENCE_TRANSFER_SENTINEL.length,
    );
    const historyDepthBounded = normalizedHistoryTransferSignatures.size === 1 && sequenceByteDeltasAccounted;
    structuralGate.worksheetHistoryDepthTransferInvariant = historyDepthBounded ? "pass" : "fail";
    structuralGate.worksheetHistoryDepthMeasurements = historyDepthFlat;
    structuralGate.worksheetHistorySequenceByteDeltaAccounting = sequenceByteDeltasAccounted ? "pass" : "fail";
    const fieldCountRows = worksheetMeasurements.filter((item) => String(item.scenario).startsWith("worksheet_fields_"));
    const fieldCountsMatch = fieldCountRows.every((item) => item.actualActiveFieldCount === item.fieldCount);
    structuralGate.worksheetFieldCountIsolation = fieldCountsMatch ? "pass" : "fail";
    structuralGate.worksheetFieldCountMeasurements = fieldCountRows.map((item) => ({
      scenario: item.scenario,
      expectedActiveFields: item.fieldCount,
      actualActiveFields: item.actualActiveFieldCount,
    }));
    const evidenceRows = worksheetMeasurements.filter((item) => String(item.scenario).startsWith("worksheet_evidence_"));
    const evidenceLinksMatch = evidenceRows.every((item) =>
      item.currentRevisionEvidenceLinks === Number(item.fieldCount) * Number(item.paperEvidencePickerRows),
    );
    structuralGate.worksheetEvidenceSupportCounts = evidenceLinksMatch ? "pass" : "fail";
    structuralGate.worksheetEvidenceSupportMeasurements = evidenceRows.map((item) => ({
      scenario: item.scenario,
      fieldCount: item.fieldCount,
      paperEvidencePickerRows: item.paperEvidencePickerRows,
      expectedCurrentRevisionEvidenceLinks: Number(item.fieldCount) * Number(item.paperEvidencePickerRows),
      actualCurrentRevisionEvidenceLinks: item.currentRevisionEvidenceLinks,
    }));
    if (structuralGate.status !== "pass") runStatus = "failed";
    if (!historyDepthBounded || !fieldCountsMatch || !evidenceLinksMatch) runStatus = "failed";
  } catch (error) {
    runStatus = "failed";
    runError = safeError(error);
  } finally {
    if (appClient) {
      try {
        await appClient.end({ timeout: 5 });
        cleanup.applicationClientClosed = true;
      } catch (error) {
        cleanup.applicationClientClosed = false;
        cleanup.applicationClientCloseError = safeError(error);
        runStatus = "failed";
      }
    }
    if (databaseCreated) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
        const remaining = await admin.unsafe("SELECT count(*)::int AS count FROM pg_database WHERE datname=$1", [databaseName]);
        const absent = Number((remaining[0] as { count: number }).count) === 0;
        cleanup.status = absent ? "verified_dropped" : "drop_not_verified";
        cleanup.databaseAbsentAfterDrop = absent;
        if (!absent) runStatus = "failed";
      } catch (error) {
        cleanup.status = "failed";
        cleanup.error = safeError(error);
        runStatus = "failed";
      }
    } else {
      cleanup.status = "not_created";
    }
    await admin.end({ timeout: 5 });
    await mkdir(resolve("docs/benchmarks"), { recursive: true });
    const output = {
      benchmark: "Slice 53 Scalable Extraction Revision History Read Paths",
      status: runStatus,
      nodeVersion: process.versions.node,
      postgresVersion,
      migrationTailId: migrationVersion,
      database: { name: databaseName, disposable: true, createdByRun: databaseCreated },
      populations: [...POPULATIONS],
      pageSize: PAGE_SIZE,
      approvedHistoryIndex: HISTORY_INDEX,
      migrationVerification: historyIndexVerification,
      statementAccounting: {
        transactionApiCallsAreReportedSeparately: true,
        transactionSetupStatementCountIsIncludedInNonSelectStatementCount: true,
        transactionSetupStatements: ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", "SET LOCAL statement_timeout"],
        beginAndCommitAreManagedByThePostgresTransactionAPIAndNotCountedByDrizzleQueryLogger: true,
      },
      fixtureSummary: {
        extractionHistorySlots: corpora.map((corpus) => ({ label: corpus.label, paperId: corpus.paperId, fieldId: corpus.fieldId, finalizedRevisions: corpus.population, currentRevisionEvidenceLinks: corpus.evidencePerCurrentRevision })),
        worksheetScenarios: worksheetScenarios.map((scenario) => ({ label: scenario.label, fieldCount: scenario.fieldCount, revisionsPerField: scenario.revisionsPerField, totalHistoricalRevisions: scenario.fieldCount * scenario.revisionsPerField, paperEvidenceRows: scenario.evidenceCount })),
        expectedGeneratedRevisionCount: corpora.reduce((sum, corpus) => sum + corpus.population, 0) + worksheetScenarios.reduce((sum, scenario) => sum + scenario.fieldCount * scenario.revisionsPerField, 0),
      },
      historyMeasurements,
      worksheetMeasurements,
      measurements,
      plans,
      structuralGates: structuralGate,
      boundaries: {
        paperEvidencePicker: "Deferred unbounded debt: retained by approval; its returned rows and DTO bytes may grow with Paper Evidence count.",
        boundednessClaim: "Complete historical ExtractionRevision streams and historical revision-Evidence hydration are no longer materialized by the normal worksheet.",
        separateReads: "Project layout plus unchanged conditional preferred-document and text-extraction reads are outside this getPaperExtractionWorksheet-only measurement.",
        artifactGrowth: "Current worksheet and exact revision DTOs may grow with their exact current/exact Evidence support membership.",
        legacyHistory: "Full legacy history is measured only on the practical safe-sequence 1k fixture because the released API performs per-revision Evidence reads; larger legacy history is not executed.",
        plannerHints: "No planner-disable GUCs or benchmark-only SQL hints were used.",
      },
      runError,
      cleanup,
    };
    await writeFile(ARTIFACT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  if (runStatus !== "completed") throw new Error(`Slice 53 benchmark failed. See ${ARTIFACT}. ${runError?.message ?? `Structural gate: ${String(structuralGate.status)}.`}`);
  console.log(`Slice 53 benchmark wrote ${ARTIFACT}; deep-page gate=${String(structuralGate.status)}; disposable database cleanup=${String(cleanup.status)}.`);
}

void main().catch((error: unknown) => {
  const value = error instanceof Error ? error.message : String(error);
  console.error(value.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]"));
  process.exitCode = 1;
});
