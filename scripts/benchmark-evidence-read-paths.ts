import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createEvidenceWorkspaceReadServices } from "@/application/evidence-workspace-read-services";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";

const EVIDENCE_SIZES = [1_000, 10_000, 50_000] as const;
const PAGE_SIZE = 50;
const PAPER_PAGE_SIZE = 20;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_STATEMENT_TIMEOUT_MS = 600_000;

type CapturedQuery = { query: string; params: unknown[] };
type TimedResult<T> = {
  value: T;
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  payloadBytes: number;
  queries: CapturedQuery[];
};
type JsonRecord = Record<string, unknown>;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function uuidExpression(value: string) {
  const digest = `md5(${value})`;
  return `(substring(${digest} from 1 for 12) || '5' || substring(${digest} from 14 for 3) || 'a' || substring(${digest} from 18 for 15))::uuid`;
}

function selectQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function createCapturedDatabase(client: postgres.Sql, queries: CapturedQuery[]): Database {
  return drizzle(client, {
    schema,
    logger: {
      logQuery(query, params) {
        queries.push({ query, params: [...params] });
      },
    },
  }) as Database;
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? value as JsonRecord : {};
}

function asNumber(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function timed<T>(queries: CapturedQuery[], run: () => Promise<T>): Promise<TimedResult<T>> {
  queries.length = 0;
  const started = process.hrtime.bigint();
  const value = await run();
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  const captured = [...queries];
  return {
    value,
    wallTimeMs: Number(elapsed.toFixed(2)),
    statementCount: captured.length,
    selectCount: selectQueries(captured).length,
    payloadBytes: jsonBytes(value),
    queries: captured,
  };
}

async function seedCorpus(client: postgres.Sql, services: ReturnType<typeof createReviewServices>, size: number) {
  const project = await services.createProject({ title: `Slice 39 Evidence benchmark ${size} ${randomUUID()}` });
  const projectId = project.id;
  const paperId = uuidExpression(`$1::text || ':paper:' || g.n::text`);
  await client.unsafe(
    `insert into papers (id, project_id, title, authors, publication_year, venue, created_at, updated_at)
     select ${paperId}, $1::uuid, 'Benchmark Paper ' || lpad(g.n::text, 8, '0'),
       array['Benchmark Researcher']::text[], 2018 + mod(g.n, 8)::integer, 'Synthetic benchmark',
       now() - (g.n * interval '1 second'), now() - (g.n * interval '1 second')
     from generate_series(1, $2::integer) as g(n)`,
    [projectId, size],
  );

  const documentId = uuidExpression(`source.project_id::text || ':document:' || source.n::text`);
  await client.unsafe(
    `with source as (
       select p.project_id, p.id as paper_id, right(p.title, 8)::integer as n
       from papers p where p.project_id=$1::uuid
     ), documents as (
       select source.*, ${documentId} as document_id from source
     )
     insert into full_text_documents
       (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256)
     select document_id, project_id, paper_id,
       'projects/' || project_id::text || '/papers/' || paper_id::text || '/documents/' || document_id::text || '/source.pdf',
       'benchmark-source.pdf', 'application/pdf', 1024, repeat('a', 64)
     from documents where mod(n, 10)=0 or mod(n, 20)=2`,
    [projectId],
  );

  const extractionId = uuidExpression(`source.project_id::text || ':text-extraction:' || source.n::text`);
  await client.begin(async (tx) => {
    await tx.unsafe(
    `with source as (
       select p.project_id, p.id as paper_id, right(p.title, 8)::integer as n
       from papers p where p.project_id=$1::uuid
     ), extractions as (
       select source.*, document.id as document_id, ${extractionId} as extraction_id
       from source
       join full_text_documents document on document.project_id=source.project_id and document.paper_id=source.paper_id
       where mod(source.n, 20)=2
     )
     insert into document_text_extractions
       (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version,
        algorithm_version, status, page_count, character_count, started_at, completed_at)
     select extraction_id, project_id, paper_id, document_id, 'benchmark-extractor', '1', '1',
       'succeeded', 1, char_length('Benchmark extracted page ' || lpad(n::text, 8, '0')), now(), now()
     from extractions`,
    [projectId],
    );
    await tx.unsafe(
    `insert into document_text_extraction_pages
       (project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count)
     select extraction.project_id, extraction.paper_id, extraction.id, 1, 'succeeded',
       'Benchmark extracted page ' || right(paper.title, 8),
       char_length('Benchmark extracted page ' || right(paper.title, 8))
     from document_text_extractions extraction
     join papers paper on paper.project_id=extraction.project_id and paper.id=extraction.paper_id
     where extraction.project_id=$1::uuid`,
    [projectId],
    );
  });

  await client.unsafe(
    `with source as (
       select p.project_id, p.id as paper_id, right(p.title, 8)::integer as n,
         document.id as document_id, extraction.id as extraction_id,
         'Benchmark extracted page ' || right(p.title, 8) as extracted_text
       from papers p
       left join full_text_documents document on document.project_id=p.project_id and document.paper_id=p.id
       left join document_text_extractions extraction on extraction.project_id=p.project_id and extraction.paper_id=p.id
       where p.project_id=$1::uuid
     )
     insert into evidence
       (project_id, paper_id, full_text_document_id, document_text_extraction_id,
        extraction_start_offset, extraction_end_offset, source_text, page_number, created_at, updated_at)
     select project_id, paper_id,
       case when mod(n, 10)=0 or mod(n, 20)=2 then document_id else null end,
       case when mod(n, 20)=2 then extraction_id else null end,
       case when mod(n, 20)=2 then 0 else null end,
       case when mod(n, 20)=2 then char_length(extracted_text) else null end,
       case when mod(n, 20)=2 then extracted_text else 'Manual benchmark passage ' || n::text end,
       case when mod(n, 20)=2 then 1 else mod(n, 20) + 1 end,
       now() - (n * interval '1 second'), now() - (n * interval '1 second')
     from source`,
    [projectId],
  );

  await client.unsafe(
    `insert into evidence_review_decisions (project_id, evidence_id, decision, created_at)
     select evidence.project_id, evidence.id, 'needs_review', now() - interval '2 seconds'
     from evidence
     join papers on papers.project_id=evidence.project_id and papers.id=evidence.paper_id
     where evidence.project_id=$1::uuid and mod(right(papers.title, 8)::integer, 4) in (0, 1, 2)`,
    [projectId],
  );
  await client.unsafe(
    `insert into evidence_review_decisions (project_id, evidence_id, decision, created_at)
     select evidence.project_id, evidence.id,
       case when mod(right(papers.title, 8)::integer, 4)=0 then 'accepted' else 'rejected' end,
       now() - interval '1 second'
     from evidence
     join papers on papers.project_id=evidence.project_id and papers.id=evidence.paper_id
     where evidence.project_id=$1::uuid and mod(right(papers.title, 8)::integer, 4) in (0, 2)`,
    [projectId],
  );

  const labelId = uuidExpression(`$1::text || ':label:' || g.n::text`);
  await client.unsafe(
    `insert into evidence_labels (id, project_id, name)
     select ${labelId}, $1::uuid, 'Benchmark label ' || g.n::text
     from generate_series(1, 3) as g(n)`,
    [projectId],
  );
  const labelOne = uuidExpression(`project_id::text || ':label:1'`);
  const labelTwo = uuidExpression(`project_id::text || ':label:2'`);
  const labelThree = uuidExpression(`project_id::text || ':label:3'`);
  await client.unsafe(
    `with numbered as (
       select evidence.project_id, evidence.id, right(papers.title, 8)::integer as n
       from evidence join papers on papers.project_id=evidence.project_id and papers.id=evidence.paper_id
       where evidence.project_id=$1::uuid
     )
     insert into evidence_label_events (project_id, evidence_id, label_id, event)
     select project_id, id, ${labelOne}, 'assigned' from numbered where mod(n, 3)=0
     union all
     select project_id, id, ${labelTwo}, 'assigned' from numbered where mod(n, 7)=0
     union all
     select project_id, id, ${labelThree}, 'assigned' from numbered where mod(n, 20)=0`,
    [projectId],
  );

  const fieldId = uuidExpression(`$1::text || ':extraction-field'`);
  await client.unsafe(
    `insert into extraction_fields (id, project_id, name, field_type)
     values (${fieldId}, $1::uuid, 'Benchmark extraction field', 'short_text')`,
    [projectId],
  );
  const valueId = uuidExpression(`p.project_id::text || ':extraction-value:' || right(p.title, 8)`);
  await client.unsafe(
    `insert into extraction_values (id, project_id, paper_id, field_id)
     select ${valueId}, p.project_id, p.id, ${fieldId}
     from papers p where p.project_id=$1::uuid and mod(right(p.title, 8)::integer, 20)=3`,
    [projectId],
  );
  const revisionId = uuidExpression(`p.project_id::text || ':extraction-revision:' || right(p.title, 8)`);
  await client.unsafe(
    `insert into extraction_value_revisions
       (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value)
     select ${revisionId}, p.project_id, p.id, ${fieldId}, ${valueId},
       'short_text', 'present', 'Benchmark extraction value'
     from papers p where p.project_id=$1::uuid and mod(right(p.title, 8)::integer, 20)=3`,
    [projectId],
  );
  await client.unsafe(
    `insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id)
     select evidence.project_id, evidence.paper_id, revision.id, evidence.id
     from evidence
     join papers on papers.project_id=evidence.project_id and papers.id=evidence.paper_id
     join extraction_value_revisions revision on revision.project_id=evidence.project_id
       and revision.paper_id=evidence.paper_id
     where evidence.project_id=$1::uuid and mod(right(papers.title, 8)::integer, 20)=3`,
    [projectId],
  );
  await client.unsafe(
    `update extraction_value_revisions set finalized_at=created_at
     where project_id=$1::uuid and field_id=${fieldId} and finalized_at is null`,
    [projectId],
  );

  const paperRows = await client.unsafe(
    `select id from papers where project_id=$1::uuid order by created_at desc, id desc limit 2`,
    [projectId],
  ) as unknown as Array<{ id: string }>;
  const labelRows = await client.unsafe(
    `select id from evidence_labels where project_id=$1::uuid order by name, id`,
    [projectId],
  ) as unknown as Array<{ id: string }>;
  const counts = await client.unsafe(
    `select
       (select count(*)::integer from papers where project_id=$1::uuid) as papers,
       (select count(*)::integer from evidence where project_id=$1::uuid) as evidence,
       (select count(*)::integer from evidence_review_decisions where project_id=$1::uuid) as review_decisions,
       (select count(*)::integer from evidence_label_events where project_id=$1::uuid) as label_events,
       (select count(*)::integer from extraction_revision_evidence where project_id=$1::uuid) as used_evidence`,
    [projectId],
  ) as unknown as Array<Record<string, unknown>>;
  const verified = counts[0];
  if (Number(verified?.papers) !== size || Number(verified?.evidence) !== size) {
    throw new Error(`Seed verification failed at ${size} rows`);
  }
  return {
    projectId,
    paperIds: paperRows.map((row) => row.id),
    labelIds: labelRows.map((row) => row.id),
    counts: {
      papers: Number(verified.papers),
      evidence: Number(verified.evidence),
      reviewDecisions: Number(verified.review_decisions),
      labelEvents: Number(verified.label_events),
      usedEvidence: Number(verified.used_evidence),
    },
  };
}

function explainRoot(rows: unknown[]) {
  const row = asRecord(rows[0]);
  const raw = row["QUERY PLAN"];
  const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  const explain = Array.isArray(parsed) ? asRecord(parsed[0]) : asRecord(parsed);
  const root = asRecord(explain.Plan);
  const accessNodes: string[] = [];
  const visit = (value: unknown) => {
    const node = asRecord(value);
    const nodeType = String(node["Node Type"] ?? "");
    if (/scan/i.test(nodeType)) {
      accessNodes.push([
        nodeType,
        node["Relation Name"] ? String(node["Relation Name"]) : "",
        node["Index Name"] ? String(node["Index Name"]) : "",
        `rows=${asNumber(node["Actual Rows"])}`,
      ].filter(Boolean).join(" "));
    }
    const children = node.Plans;
    if (Array.isArray(children)) children.forEach(visit);
  };
  visit(root);
  return {
    planningTimeMs: Number(asNumber(explain["Planning Time"]).toFixed(2)),
    executionTimeMs: Number(asNumber(explain["Execution Time"]).toFixed(2)),
    rootNode: String(root["Node Type"] ?? "unknown"),
    sharedHitBlocks: asNumber(root["Shared Hit Blocks"]),
    sharedReadBlocks: asNumber(root["Shared Read Blocks"]),
    tempReadBlocks: asNumber(root["Temp Read Blocks"]),
    tempWrittenBlocks: asNumber(root["Temp Written Blocks"]),
    accessNodes: [...new Set(accessNodes)].slice(0, 12),
  };
}

async function measuredExplain(client: postgres.Sql, item: { name: string; query: CapturedQuery }) {
  const rows = await client.unsafe(
    `explain (analyze, buffers, format json) ${item.query.query}`,
    item.query.params,
  );
  return { name: item.name, ...explainRoot(rows as unknown[]) };
}

async function runBenchmark() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) {
    throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  }
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_evidence_read_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  const queries: CapturedQuery[] = [];
  const corpusResults: Array<{
    size: number;
    projectId: string;
    core: Record<string, unknown>;
    legacy: Record<string, unknown>;
    paperSearch: Record<string, unknown>;
    allPapers: Record<string, unknown>;
    seed: Record<string, unknown>;
  }> = [];

  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) {
      throw new Error(`Requires PostgreSQL 16; connected server version number is ${versionNumber}.`);
    }
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;

    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    client = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await client.unsafe(`set statement_timeout = '${SEED_STATEMENT_TIMEOUT_MS}ms'`);
    const db = createCapturedDatabase(client, queries);
    const services = createReviewServices(db);
    const reads = createEvidenceWorkspaceReadServices(db);
    console.log(JSON.stringify({
      benchmark: "Slice 39 Evidence workspace and Paper reads",
      postgresVersion: 16,
      evidenceAndPaperSizes: EVIDENCE_SIZES,
      workspacePageSize: PAGE_SIZE,
      paperPageSize: PAPER_PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      seedStatementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      fixtureMix: "Per 20 Papers: one historical ExtractionRevision Evidence link (unused by current review state); document-only provenance on two additional Papers; current review states distributed across accepted, needs_review, rejected, and unreviewed; three Labels with sparse-to-multiple assignments.",
      note: "Synthetic rows are written only to one uniquely named migrated database that is force-dropped in finally. Wall times are diagnostics, not pass/fail thresholds.",
    }));

    const projects: Array<Awaited<ReturnType<typeof seedCorpus>>> = [];
    for (const size of EVIDENCE_SIZES) {
      await client.unsafe(`set statement_timeout = '${SEED_STATEMENT_TIMEOUT_MS}ms'`);
      const seed = await seedCorpus(client, services, size);
      projects.push(seed);
      await client.unsafe(
        "analyze papers, evidence, evidence_review_decisions, evidence_labels, evidence_label_events, extraction_fields, extraction_values, extraction_value_revisions, extraction_revision_evidence",
      );
      console.log(JSON.stringify({ phase: "seed-complete", size, fixtureCounts: seed.counts }));
    }

    for (const seed of projects) {
      const size = EVIDENCE_SIZES[projects.indexOf(seed)];
      await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      const newPage = await timed(queries, () => reads.getEvidenceWorkspacePage(seed.projectId, { state: "all", page: 1, pageSize: PAGE_SIZE }));
      const legacyPage = await timed(queries, () => services.listEvidenceWorkspace(seed.projectId, { state: "all", page: 1, pageSize: PAGE_SIZE }));
      const newPaperOptions = await timed(queries, () => reads.searchEvidencePaperOptions({
        projectId: seed.projectId,
        query: "Benchmark Paper",
        page: 1,
        pageSize: PAPER_PAGE_SIZE,
      }));
      const allPapers = await timed(queries, () => services.listPapers(seed.projectId));
      const legacyRows = (legacyPage.value as { items?: unknown[] }).items ?? [];
      const newRows = (newPage.value as { items?: unknown[] }).items ?? [];
      if (newRows.length !== PAGE_SIZE || Number((newPage.value as { totalCount: number }).totalCount) !== size) {
        throw new Error(`New Evidence page returned an unexpected count for the ${size}-row fixture`);
      }
      if (newPage.selectCount !== 4) throw new Error(`Workspace projection executed ${newPage.selectCount} SELECTs instead of four`);
      if (legacyRows.length !== PAGE_SIZE || legacyPage.selectCount <= newPage.selectCount) {
        throw new Error(`Legacy Evidence projection did not show the expected per-row query expansion at ${size} rows`);
      }
      if (newPaperOptions.selectCount !== 2 || (newPaperOptions.value as { items: unknown[] }).items.length !== PAPER_PAGE_SIZE) {
        throw new Error(`Bounded Paper search failed its two-query, ${PAPER_PAGE_SIZE}-row contract at ${size} Papers`);
      }

      const core = {
        totalEvidence: size,
        pageRows: newRows.length,
        newSelects: newPage.selectCount,
        legacySelects: legacyPage.selectCount,
        newPayloadBytes: newPage.payloadBytes,
        legacyPayloadBytes: legacyPage.payloadBytes,
        newWallTimeMs: newPage.wallTimeMs,
        legacyWallTimeMs: legacyPage.wallTimeMs,
      };
      const paperSearch = {
        totalPapers: size,
        boundedRows: (newPaperOptions.value as { items: unknown[] }).items.length,
        boundedSelects: newPaperOptions.selectCount,
        boundedPayloadBytes: newPaperOptions.payloadBytes,
        boundedWallTimeMs: newPaperOptions.wallTimeMs,
      };
      const allPaperRead = {
        materializedRows: Array.isArray(allPapers.value) ? allPapers.value.length : 0,
        selects: allPapers.selectCount,
        payloadBytes: allPapers.payloadBytes,
        wallTimeMs: allPapers.wallTimeMs,
      };
      const result = { size, projectId: seed.projectId, core, legacy: { selectCount: legacyPage.selectCount }, paperSearch, allPapers: allPaperRead, seed: seed.counts };
      corpusResults.push(result);
      console.log(JSON.stringify({ corpusResult: result }));
    }

    const largest = projects[projects.length - 1];
    const largeSize = EVIDENCE_SIZES[EVIDENCE_SIZES.length - 1];
    await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const compositionLabels = await timed(queries, () => services.listEvidenceLabels(largest.projectId, true));
    const compositionPaperOptions = await timed(queries, () => reads.searchEvidencePaperOptions({ projectId: largest.projectId, page: 1, pageSize: PAPER_PAGE_SIZE }));
    const selectedPaperOne = await timed(queries, () => reads.getEvidencePaperOption(largest.projectId, largest.paperIds[0]));
    const selectedPaperTwo = await timed(queries, () => reads.getEvidencePaperOption(largest.projectId, largest.paperIds[1]));
    const fullPageComposition = {
      coreProjectionSelects: 4,
      labelDefinitionSelects: compositionLabels.selectCount,
      initialPaperSearchSelects: compositionPaperOptions.selectCount,
      exactSelectedPaperSelects: selectedPaperOne.selectCount + selectedPaperTwo.selectCount,
      totalWithTwoSelectedPapers: 4 + compositionLabels.selectCount + compositionPaperOptions.selectCount + selectedPaperOne.selectCount + selectedPaperTwo.selectCount,
      scope: "The four-SELECT invariant covers only filtered count, bounded Evidence page, current Labels, and usage. These separate page-composition reads are reported independently.",
    };
    console.log(JSON.stringify({ fullPageComposition }));

    const labelId = largest.labelIds[0];
    const baseQueries = await timed(queries, () => reads.getEvidenceWorkspacePage(largest.projectId, { state: "all", page: 1, pageSize: PAGE_SIZE }));
    const labelQueries = await timed(queries, () => reads.getEvidenceWorkspacePage(largest.projectId, { state: "all", labelId, page: 1, pageSize: PAGE_SIZE }));
    const usedQueries = await timed(queries, () => reads.getEvidenceWorkspacePage(largest.projectId, { state: "all", usage: "used", page: 1, pageSize: PAGE_SIZE }));
    const unusedQueries = await timed(queries, () => reads.getEvidenceWorkspacePage(largest.projectId, { state: "all", usage: "unused", page: 1, pageSize: PAGE_SIZE }));
    const paperSearchQueries = await timed(queries, () => reads.searchEvidencePaperOptions({ projectId: largest.projectId, query: "Benchmark Paper", page: 1, pageSize: PAPER_PAGE_SIZE }));
    const exactPaperQueries = await timed(queries, () => reads.getEvidencePaperOption(largest.projectId, largest.paperIds[0]));
    const baseSelects = selectQueries(baseQueries.queries);
    const labelSelects = selectQueries(labelQueries.queries);
    const usedSelects = selectQueries(usedQueries.queries);
    const unusedSelects = selectQueries(unusedQueries.queries);
    const paperSearchSelects = selectQueries(paperSearchQueries.queries);
    const exactPaperSelects = selectQueries(exactPaperQueries.queries);
    const explainCases = [
      { name: "Evidence filtered count (all)", query: baseSelects[0] },
      { name: "Evidence bounded page (all)", query: baseSelects[1] },
      { name: "Current Labels set projection", query: baseSelects[2] },
      { name: "Historical usage set projection", query: baseSelects[3] },
      { name: "Evidence filtered count (label)", query: labelSelects[0] },
      { name: "Evidence page (label filter)", query: labelSelects[1] },
      { name: "Evidence filtered count (usage used)", query: usedSelects[0] },
      { name: "Evidence page (usage used)", query: usedSelects[1] },
      { name: "Evidence filtered count (usage unused)", query: unusedSelects[0] },
      { name: "Evidence page (usage unused)", query: unusedSelects[1] },
      { name: "Paper search count", query: paperSearchSelects[0] },
      { name: "Paper bounded search page", query: paperSearchSelects[1] },
      { name: "Exact selected Paper resolution", query: exactPaperSelects[0] },
    ];
    if (explainCases.some((item) => !item.query)) throw new Error("Unable to capture every required Evidence/Paper EXPLAIN query");
    const plans = [];
    for (const item of explainCases) plans.push(await measuredExplain(client, item));
    console.log(JSON.stringify({ explainPlans: plans }));
    console.log(JSON.stringify({ benchmarkSummary: {
      sizeCount: corpusResults.length,
      largestCorpusSize: largeSize,
      composition: fullPageComposition,
      results: corpusResults,
      explainPlans: plans,
    } }));
  } finally {
    if (client) await client.end({ timeout: 1 });
    try {
      if (created) {
        await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
        console.log(JSON.stringify({ phase: "cleanup-complete", droppedOwnBenchmarkDatabase: true }));
      }
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
}

runBenchmark().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(message.replace(/postgres(?:ql)?:\/\S+/gi, "[redacted database URL]"));
  process.exitCode = 1;
});
