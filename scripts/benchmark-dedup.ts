import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createReviewServices } from "@/application/services";
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

async function benchmarkScenario(
  db: ReturnType<typeof createDb>["db"],
  client: postgres.Sql,
  services: ReturnType<typeof createReviewServices>,
  scenario: Scenario,
) {
  const { project, source, runs } = await createScenarioContext(services, scenario);
  const seeded = buildSeedRows(project.id, source.id, [runs[0].id, runs[1].id], scenario);
  await insertRows(client, seeded.rows);
  const historyCount = scenario.distribution === "dense" ? 0 : await insertHistory(client, project.id, seeded.candidatePairs);
  await client.unsafe("analyze retrieved_records; analyze retrieved_record_deduplication_decisions");

  const newCount = await measuredCount(db, optimizedCountQuery(project.id), NEW_QUERY_TIMEOUT_MS);
  const newRow = newCount.status === "completed" ? newCount.row as Record<string, unknown> : null;
  const oldEstimate = await estimatedPlan(db, releasedCountQuery(project.id));
  const newEstimate = await estimatedPlan(db, optimizedCountQuery(project.id));
  const newPlan = await measuredExplain(db, optimizedCountQuery(project.id), NEW_QUERY_TIMEOUT_MS);
  const oldCount = scenario.recordCount <= 10_000
    ? await measuredCount(db, releasedCountQuery(project.id), OLD_QUERY_TIMEOUT_MS)
    : { status: "not_run" as const, timeoutMs: OLD_QUERY_TIMEOUT_MS, wallTimeMs: null, row: null };
  const oldPlan = await measuredExplain(db, releasedCountQuery(project.id), OLD_QUERY_TIMEOUT_MS);

  const summary = {
    scenario: scenario.name,
    distribution: scenario.distribution,
    N_retrieved_records: seeded.rows.length,
    M_candidate_pairs: newRow ? Number(newRow.candidate_count) : null,
    unresolved_pairs: newRow ? Number(newRow.unresolved_count) : null,
    expected_M_from_seed: seeded.expectedCandidatePairs,
    history_rows: historyCount,
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
  console.log(oldPlan.plan ?? `[${oldPlan.status}; ${oldPlan.timeoutMs} ms bound; ${oldPlan.wallTimeMs.toFixed(1)} ms wall]`);
  console.log("\n--- indexed EXPLAIN (ANALYZE, BUFFERS) ---");
  console.log(newPlan.plan ?? `[${newPlan.status}; ${newPlan.timeoutMs} ms bound; ${newPlan.wallTimeMs.toFixed(1)} ms wall]`);

  if (newCount.status !== "completed") throw new Error(`Indexed query timed out for ${scenario.name}`);
  if (Number(newRow?.candidate_count) !== seeded.expectedCandidatePairs) {
    throw new Error(`${scenario.name} produced ${String(newRow?.candidate_count)} candidates; fixture expects ${seeded.expectedCandidatePairs}`);
  }
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
    const versionRows = await admin`select current_setting('server_version_num')::integer as version`;
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
    ];
    console.log(`PostgreSQL 16 confirmed; disposable database ${databaseName} created and migrated.`);
    console.log(`Old query timeout: ${OLD_QUERY_TIMEOUT_MS} ms. Indexed query timeout: ${NEW_QUERY_TIMEOUT_MS} ms.`);
    console.log("N is retrieved records; M is actual candidate pairs before history exclusion. Dense case output is quadratic in M by definition.");
    const results = [];
    for (const scenario of scenarios) results.push(await benchmarkScenario(app.db, app.client, services, scenario));
    console.log("\n=== benchmark summary ===");
    console.log(JSON.stringify(results, null, 2));
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
