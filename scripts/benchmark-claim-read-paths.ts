import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createClaimReadServices } from "@/application/claim-read-services";
import { createReviewServices } from "@/application/services";
import { schema } from "@/db/schema";
import { resolveDatabaseUrl } from "@/db/config";
import type { Database } from "@/db/client";

const CLAIM_SIZES = [1_000, 10_000, 50_000] as const;
const HISTORY_SIZES = [1, 50, 500, 1_000] as const;
const PAGE_SIZE = 50;
const STATEMENT_TIMEOUT_MS = 120_000;
const SEED_STATEMENT_TIMEOUT_MS = 600_000;
const LEGACY_WALL_TIMEOUT_MS = 20_000;
const LEGACY_HISTORY_TIMEOUT_MS = 20_000;

type CapturedQuery = { query: string; params: unknown[] };
type CaptureSink = { queries: CapturedQuery[]; onQuery?: (query: string, count: number) => void };
type Counts = { all: number; supported: number; unsupported: number; withdrawn: number };
type LegacySummary = {
  materializedRows: number;
  materializedSupports: number;
  counts: Counts;
  citationCandidateTotal: number;
  distinctPaperTotal: number;
  directEvidenceTotal: number;
  extractionRevisionTotal: number;
  synthesisRevisionTotal: number;
};
type LegacyMeasurement = {
  value: LegacySummary | null;
  status: "completed" | "timed_out" | "failed";
  wallTimeMs: number;
  statementCount: number;
  selectCount: number;
  payloadBytes: number | null;
  error?: string;
  historySummary?: Record<string, number>;
};
type WorkerResult = { kind: "result"; mode: "claims" | "history"; measurement: LegacyMeasurement; historySummary?: Record<string, number> };
type LegacyRevisionProjection = {
  lifecycle?: string;
  supportStatus?: string;
  directEvidenceCount?: number;
  extractionRevisionCount?: number;
  synthesisRevisionCount?: number;
  citationCandidateCount?: number;
  distinctPaperCount?: number;
  supports?: { evidence?: unknown[]; extractionRevisions?: unknown[]; synthesisRevisions?: unknown[] };
};
type LegacyHistorySummary = {
  revisions: number;
  supports: number;
  directEvidence: number;
  extractionRevisions: number;
  synthesisRevisions: number;
  citationCandidates: number;
  distinctPapers: number;
  supported: number;
  unsupported: number;
  withdrawn: number;
};

const readCapture: CaptureSink = { queries: [] };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value.code ?? value.cause?.code;
}

function safeError(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } }
    : null;
  const causeMessage = typeof record?.cause?.message === "string" ? record.cause.message : null;
  const message = causeMessage
    ? `${String(record?.name ?? "Error")}: ${causeMessage}${record?.cause?.code ? ` (SQLSTATE ${String(record.cause.code)})` : ""}`
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = message.replace(/postgres(?:ql)?:\/\S+/gi, "[redacted database URL]");
  return redacted.length > 1_000 ? `${redacted.slice(0, 1_000)}… [truncated]` : redacted;
}

function isTimeout(error: unknown) {
  return errorCode(error) === "57014" || /statement timeout|canceling statement/i.test(safeError(error));
}

function captureQueries(client: postgres.Sql, sink: CaptureSink): Database {
  return drizzle(client, {
    schema,
    logger: {
      logQuery(query, params) {
        sink.queries.push({ query, params: [...params] });
        sink.onQuery?.(query, sink.queries.length);
      },
    },
  }) as Database;
}

function selectQueries(queries: CapturedQuery[]) {
  return queries.filter(({ query }) => /^(with|select)\b/i.test(query.trim()));
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hashedUuidSql(valueExpression: string) {
  const digest = `md5(${valueExpression})`;
  return `(substring(${digest} from 1 for 12) || '5' || substring(${digest} from 14 for 3) || 'a' || substring(${digest} from 18 for 15))::uuid`;
}

async function measured<T>(sink: CaptureSink, run: () => Promise<T>) {
  sink.queries.length = 0;
  const started = process.hrtime.bigint();
  const value = await run();
  return {
    value,
    wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    statementCount: sink.queries.length,
    selectCount: selectQueries(sink.queries).length,
    queries: [...sink.queries],
    payloadBytes: jsonBytes(value),
  };
}

function supportArrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function summarizeClaimRows(rows: Array<{ currentRevision: LegacyRevisionProjection }>): LegacySummary {
  const counts: Counts = { all: rows.length, supported: 0, unsupported: 0, withdrawn: 0 };
  let citationCandidateTotal = 0;
  let distinctPaperTotal = 0;
  let directEvidenceTotal = 0;
  let extractionRevisionTotal = 0;
  let synthesisRevisionTotal = 0;
  let materializedSupports = 0;
  for (const row of rows) {
    const revision = row.currentRevision;
    const direct = Number(revision.directEvidenceCount ?? supportArrayLength(revision.supports?.evidence));
    const extraction = Number(revision.extractionRevisionCount ?? supportArrayLength(revision.supports?.extractionRevisions));
    const synthesis = Number(revision.synthesisRevisionCount ?? supportArrayLength(revision.supports?.synthesisRevisions));
    directEvidenceTotal += direct;
    extractionRevisionTotal += extraction;
    synthesisRevisionTotal += synthesis;
    materializedSupports += direct + extraction + synthesis;
    citationCandidateTotal += Number(revision.citationCandidateCount ?? 0);
    distinctPaperTotal += Number(revision.distinctPaperCount ?? 0);
    if (revision.lifecycle === "withdrawn") counts.withdrawn += 1;
    else if (revision.supportStatus === "supported") counts.supported += 1;
    else counts.unsupported += 1;
  }
  return { materializedRows: rows.length, materializedSupports, counts, citationCandidateTotal, distinctPaperTotal, directEvidenceTotal, extractionRevisionTotal, synthesisRevisionTotal };
}

function summarizeHistory(rows: LegacyRevisionProjection[]): LegacyHistorySummary {
  const summary: LegacyHistorySummary = { revisions: 0, supports: 0, directEvidence: 0, extractionRevisions: 0, synthesisRevisions: 0, citationCandidates: 0, distinctPapers: 0, supported: 0, unsupported: 0, withdrawn: 0 };
  for (const revision of rows) {
    const direct = Number(revision.directEvidenceCount ?? supportArrayLength(revision.supports?.evidence));
    const extraction = Number(revision.extractionRevisionCount ?? supportArrayLength(revision.supports?.extractionRevisions));
    const synthesis = Number(revision.synthesisRevisionCount ?? supportArrayLength(revision.supports?.synthesisRevisions));
    summary.revisions += 1;
    summary.supports += direct + extraction + synthesis;
    summary.directEvidence += direct;
    summary.extractionRevisions += extraction;
    summary.synthesisRevisions += synthesis;
    summary.citationCandidates += Number(revision.citationCandidateCount ?? 0);
    summary.distinctPapers += Number(revision.distinctPaperCount ?? 0);
    if (revision.lifecycle === "withdrawn") summary.withdrawn += 1;
    else if (revision.supportStatus === "supported") summary.supported += 1;
    else summary.unsupported += 1;
  }
  return summary;
}

async function seedPaperAndSupports(services: ReturnType<typeof createReviewServices>, projectId: string, label: string) {
  async function includedPaper(title: string) {
    const paper = await services.addPaper(projectId, { title, authors: ["Benchmark Researcher"] });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date("2026-01-01T00:00:00.000Z") });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }
  const evidencePaper = await includedPaper(`${label} evidence paper`);
  const structuralPaper = await includedPaper(`${label} structural paper`);
  const evidence = await services.recordEvidence(projectId, { paperId: evidencePaper.id, sourceText: "Synthetic benchmark evidence passage.", pageNumber: 1 });
  const field = await services.createExtractionField(projectId, { name: `${label} benchmark field`, fieldType: "short_text" });
  const evidencedExtraction = await services.reviseExtractionValue(projectId, evidencePaper.id, field.id, { value: "Evidence-backed value", evidenceIds: [evidence.id] });
  const structuralExtraction = await services.reviseExtractionValue(projectId, structuralPaper.id, field.id, { value: "Structural-only value", evidenceIds: [] });
  const synthesis = await services.createSynthesisStatement(projectId, { statementText: "Synthetic benchmark synthesis.", extractionRevisionIds: [evidencedExtraction.id] });
  return { evidence, evidencedExtraction, structuralExtraction, synthesisRevisionId: synthesis.revision.id };
}

async function seedClaims(client: postgres.Sql, projectId: string, size: number, targets: Awaited<ReturnType<typeof seedPaperAndSupports>>) {
  await client.unsafe(
    `insert into claims (id, project_id)
     select ${hashedUuidSql("$1::text || ':claim:' || g.n::text")}, $1::uuid
     from generate_series(1, $2::integer) as g(n)`,
    [projectId, size],
  );
  await client.unsafe(
    `insert into claim_revisions (project_id, claim_id, state, claim_text)
     select $1::uuid, c.id, 'active', 'Benchmark claim ' || row_number() over (order by c.id)::text
     from claims c where c.project_id=$1::uuid`,
    [projectId],
  );
  await client.unsafe(
    `insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id)
     select r.project_id, r.id, $2::uuid
     from claim_revisions r
     where r.project_id=$1::uuid and mod(substring(r.claim_text from '^Benchmark claim ([0-9]+)$')::integer, 3)=0`,
    [projectId, targets.evidence.id],
  );
  await client.unsafe(
    `insert into claim_revision_extraction_supports (project_id, claim_revision_id, extraction_revision_id)
     select r.project_id, r.id, $2::uuid
     from claim_revisions r
     where r.project_id=$1::uuid and mod(substring(r.claim_text from '^Benchmark claim ([0-9]+)$')::integer, 4)=0
     union all
     select r.project_id, r.id, $3::uuid
     from claim_revisions r
     where r.project_id=$1::uuid and mod(substring(r.claim_text from '^Benchmark claim ([0-9]+)$')::integer, 5)=0`,
    [projectId, targets.evidencedExtraction.id, targets.structuralExtraction.id],
  );
  await client.unsafe(
    `insert into claim_revision_synthesis_supports (project_id, claim_revision_id, synthesis_revision_id)
     select r.project_id, r.id, $2::uuid
     from claim_revisions r
     where r.project_id=$1::uuid and mod(substring(r.claim_text from '^Benchmark claim ([0-9]+)$')::integer, 7)=0`,
    [projectId, targets.synthesisRevisionId],
  );
  await client.unsafe("update claim_revisions set finalized_at=created_at where project_id=$1::uuid and finalized_at is null", [projectId]);
}

async function addHistoryFixtures(client: postgres.Sql, services: ReturnType<typeof createReviewServices>, projectId: string) {
  const fixtures: Array<{ claimId: string; requestedRevisions: number }> = [];
  for (const requestedRevisions of HISTORY_SIZES) {
    const claim = await services.createClaim(projectId, { claimText: `History fixture ${requestedRevisions}` });
    fixtures.push({ claimId: claim.id, requestedRevisions });
    const additionalActive = Math.max(0, requestedRevisions - 2);
    if (additionalActive > 0) {
      await client.unsafe(
        `insert into claim_revisions (project_id, claim_id, state, claim_text)
         select $1::uuid, $2::uuid, 'active', 'History fixture ${requestedRevisions} revision ' || g.n::text
         from generate_series(2, $3::integer) as g(n)`,
        [projectId, claim.id, additionalActive + 1],
      );
      await client.unsafe("update claim_revisions set finalized_at=created_at where project_id=$1::uuid and claim_id=$2::uuid and finalized_at is null", [projectId, claim.id]);
    }
    if (requestedRevisions > 1) {
      await services.withdrawClaim(projectId, claim.id);
    }
  }
  return fixtures;
}

function summarizePlan(planValue: unknown) {
  const parsed = typeof planValue === "string" ? JSON.parse(planValue) as unknown : planValue;
  const root = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined;
  const rootPlan = root?.Plan as Record<string, unknown> | undefined;
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
      sharedHitBlocks: current["Shared Hit Blocks"],
      sharedReadBlocks: current["Shared Read Blocks"],
      tempReadBlocks: current["Temp Read Blocks"],
      tempWrittenBlocks: current["Temp Written Blocks"],
    });
    if (Array.isArray(current.Plans)) for (const child of current.Plans) visit(child);
  }
  visit(rootPlan);
  return { planningTimeMs: root?.["Planning Time"], executionTimeMs: root?.["Execution Time"], nodes };
}

async function explain(client: postgres.Sql, label: string, query: CapturedQuery) {
  const started = process.hrtime.bigint();
  try {
    const rows = await client.unsafe(`explain (analyze, buffers, format json) ${query.query}`, query.params as never) as unknown as Array<Record<string, unknown>>;
    return { label, status: "completed" as const, wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, sqlBytes: Buffer.byteLength(query.query), plan: summarizePlan(rows[0]?.["QUERY PLAN"]) };
  } catch (error) {
    return { label, status: isTimeout(error) ? "timed_out" as const : "failed" as const, wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, sqlBytes: Buffer.byteLength(query.query), error: safeError(error), plan: null };
  }
}

async function terminateWorkerSessions(client: postgres.Sql, applicationName: string) {
  let emptyChecks = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await client.unsafe("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and application_name=$1 and pid<>pg_backend_pid()", [applicationName]);
    const rows = await client.unsafe("select count(*)::integer as count from pg_stat_activity where datname=current_database() and application_name=$1 and pid<>pg_backend_pid()", [applicationName]) as unknown as Array<{ count: number }>;
    if (Number(rows[0]?.count ?? 0) === 0) {
      emptyChecks += 1;
      if (emptyChecks >= 3) return;
    } else emptyChecks = 0;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Timed-out Claim benchmark worker session did not terminate within four seconds.");
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<boolean>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    function finish(exited: boolean) {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    }
    child.once("exit", onExit);
  });
}

async function measureLegacy(client: postgres.Sql, databaseUrl: string, mode: "claims" | "history", projectId: string, claimId: string | undefined, timeoutMs: number): Promise<LegacyMeasurement> {
  const applicationName = `slice38_legacy_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const scriptPath = resolve(process.cwd(), "scripts/benchmark-claim-read-paths.ts");
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, "--legacy-worker", mode, projectId, claimId ?? "", applicationName], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: "", SLICE38_BENCHMARK_DATABASE_URL: databaseUrl, SLICE38_BENCHMARK_APPLICATION_NAME: applicationName },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const started = process.hrtime.bigint();
  let progress = { statementCount: 0, selectCount: 0 };

  return await new Promise((resolveMeasurement) => {
    let settled = false;
    let timingOut = false;
    let receivedResult = false;
    const finish = (measurement: LegacyMeasurement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveMeasurement(measurement);
    };
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record.kind === "progress") {
        progress = { statementCount: Number(record.statementCount ?? progress.statementCount), selectCount: Number(record.selectCount ?? progress.selectCount) };
      }
      const workerResult = message as WorkerResult;
      if (workerResult.kind === "result" && workerResult.mode === mode && !timingOut) {
        receivedResult = true;
        clearTimeout(timer);
        const measurement = { ...workerResult.measurement, historySummary: workerResult.historySummary };
        void waitForExit(child, 3_000).then(async (exited) => {
          if (exited) {
            finish(measurement);
            return;
          }
          child.kill();
          try {
            await terminateWorkerSessions(client, applicationName);
            if (!await waitForExit(child, 3_000)) throw new Error("Legacy worker did not exit after result cleanup.");
            finish({
              value: null, status: "failed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
              statementCount: measurement.statementCount, selectCount: measurement.selectCount, payloadBytes: null,
              error: "Legacy worker returned a result but did not exit cleanly.",
            });
          } catch (error) {
            finish({
              value: null, status: "failed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
              statementCount: measurement.statementCount, selectCount: measurement.selectCount, payloadBytes: null,
              error: `Legacy worker post-result cleanup was not verified: ${safeError(error)}`,
            });
          }
        });
      }
    };
    child.on("message", onMessage);
    child.once("error", (error) => finish({ value: null, status: "failed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, ...progress, payloadBytes: null, error: safeError(error) }));
    child.once("exit", (code, signal) => {
      if (settled || timingOut || receivedResult) return;
      finish({ value: null, status: "failed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, ...progress, payloadBytes: null, error: `Worker exited without a result (code ${String(code)}, signal ${String(signal)}).` });
    });
    const timer = setTimeout(() => {
      timingOut = true;
      child.kill();
      void (async () => {
        try {
          await terminateWorkerSessions(client, applicationName);
          if (!await waitForExit(child, 3_000)) throw new Error("Timed-out legacy worker process did not exit.");
          finish({ value: null, status: "timed_out", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, ...progress, payloadBytes: null, error: `Legacy ${mode} wall-time budget reached (${timeoutMs} ms); worker and tagged database sessions were terminated.` });
        } catch (error) {
          finish({ value: null, status: "failed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, ...progress, payloadBytes: null, error: `Legacy worker cleanup was not verified: ${safeError(error)}` });
        }
      })();
    }, timeoutMs);
  });
}

async function sendWorkerMessage(message: unknown) {
  const workerProcess = process as NodeJS.Process & { send?: (message: unknown, callback: (error: Error | null) => void) => void; disconnect?: () => void };
  if (!workerProcess.send) throw new Error("Legacy benchmark worker has no IPC channel.");
  await new Promise<void>((resolveSend, rejectSend) => workerProcess.send!(message, (error) => error ? rejectSend(error) : resolveSend()));
}

async function runLegacyWorker() {
  const mode = process.argv[3] as "claims" | "history";
  const projectId = process.argv[4];
  const claimId = process.argv[5];
  const applicationName = process.argv[6];
  const databaseUrl = process.env.SLICE38_BENCHMARK_DATABASE_URL;
  if ((mode !== "claims" && mode !== "history") || !projectId || !databaseUrl?.trim()) throw new Error("Legacy benchmark worker arguments are invalid.");
  const parsedUrl = new URL(databaseUrl);
  if (!parsedUrl.pathname.slice(1).startsWith("litreview_claim_read_")) throw new Error("Legacy worker refused a database outside its disposable Claim benchmark.");
  if (!applicationName || applicationName !== process.env.SLICE38_BENCHMARK_APPLICATION_NAME || !/^slice38_legacy_[a-f0-9]+$/.test(applicationName)) throw new Error("Legacy worker requires its unique tagged application name.");
  let statementCount = 0;
  let selectCount = 0;
  const client = postgres(databaseUrl, { max: 1, prepare: false, connection: { application_name: applicationName }, onnotice: () => {} });
  const db = drizzle(client, {
    schema,
    logger: { logQuery(query) {
      statementCount += 1;
      if (/^(with|select)\b/i.test(query.trim())) selectCount += 1;
      if (selectCount > 0 && selectCount % 100 === 0) {
        void sendWorkerMessage({ kind: "progress", statementCount, selectCount }).catch(() => {});
      }
    } },
  }) as Database;
  const services = createReviewServices(db);
  const started = process.hrtime.bigint();
  let measurement: LegacyMeasurement;
  let historySummary: Record<string, number> | undefined;
  try {
    if (mode === "claims") {
      const result = await services.listClaims(projectId);
      const summary = summarizeClaimRows(result);
      measurement = { value: summary, status: "completed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, statementCount, selectCount, payloadBytes: jsonBytes(result) };
    } else {
      if (!claimId) throw new Error("History worker requires the target Claim id.");
      const result = await services.getClaimHistory(projectId, claimId);
      historySummary = summarizeHistory(result.revisions);
      measurement = { value: null, status: "completed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, statementCount, selectCount, payloadBytes: jsonBytes(result) };
    }
  } catch (error) {
    measurement = { value: null, status: isTimeout(error) ? "timed_out" : "failed", wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000, statementCount, selectCount, payloadBytes: null, error: safeError(error) };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
  await sendWorkerMessage({ kind: "result", mode, measurement, historySummary });
  (process as NodeJS.Process & { disconnect?: () => void }).disconnect?.();
}

function summaryMatchesLegacy(page: NonNullable<Awaited<ReturnType<ReturnType<typeof createClaimReadServices>["getClaimLedgerPage"]>>>, legacy: LegacySummary) {
  return page.counts.all === legacy.counts.all &&
    page.counts.supported === legacy.counts.supported &&
    page.counts.unsupported === legacy.counts.unsupported &&
    page.counts.withdrawn === legacy.counts.withdrawn &&
    page.citationCandidateTotal === legacy.citationCandidateTotal;
}

async function benchmarkClaims(args: { client: postgres.Sql; db: Database; services: ReturnType<typeof createReviewServices>; databaseUrl: string; size: number }) {
  const { client, db, services, databaseUrl, size } = args;
  const label = `Slice 38 Claim read benchmark ${size}`;
  const project = await services.createProject({ title: label });
  const targets = await seedPaperAndSupports(services, project.id, label);
  await client.unsafe(`set statement_timeout = '${SEED_STATEMENT_TIMEOUT_MS}ms'`);
  await seedClaims(client, project.id, size, targets);
  const historyFixtures = size === 50_000 ? await addHistoryFixtures(client, services, project.id) : [];
  for (const table of [
    "claims", "claim_revisions", "claim_revision_evidence_supports", "claim_revision_extraction_supports",
    "claim_revision_synthesis_supports", "papers", "screening_decisions", "extraction_value_revisions",
    "extraction_revision_evidence", "synthesis_revisions", "synthesis_revision_supports", "evidence",
  ]) await client.unsafe(`analyze ${table}`);
  await client.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

  readCapture.queries.length = 0;
  const read = createClaimReadServices(db);
  const bounded = await measured(readCapture, () => read.getClaimLedgerPage(project.id, { page: 1, pageSize: PAGE_SIZE }));
  assert(bounded.value, `Bounded ledger read returned no Project at ${size} Claims.`);
  assert(bounded.selectCount === 2, `Ledger SELECT count must remain two at ${size}; saw ${bounded.selectCount}.`);
  const legacy = await measureLegacy(client, databaseUrl, "claims", project.id, undefined, LEGACY_WALL_TIMEOUT_MS);
  const equivalence = legacy.status === "completed" && legacy.value ? summaryMatchesLegacy(bounded.value, legacy.value) : null;
  if (legacy.status === "completed") assert(equivalence, `New ledger aggregate differs from legacy Claim metrics at ${size}.`);
  const ledgerQueries = selectQueries(bounded.queries);
  assert(ledgerQueries.length === 2, `Captured ledger query set differs from its two-SELECT contract at ${size}.`);
  const plans = [
    await explain(client, `${size}.ledger.aggregate`, ledgerQueries[0]),
    await explain(client, `${size}.ledger.page`, ledgerQueries[1]),
  ];

  return {
    projectId: project.id,
    requestedClaims: size,
    auxiliaryHistoryClaims: historyFixtures.length,
    boundedLedger: {
      wallTimeMs: bounded.wallTimeMs,
      statementCount: bounded.statementCount,
      selectCount: bounded.selectCount,
      materializedRows: bounded.value.items.length,
      payloadBytes: bounded.payloadBytes,
      page: { from: bounded.value.from, to: bounded.value.to, totalCount: bounded.value.totalCount, counts: bounded.value.counts, citationCandidateTotal: bounded.value.citationCandidateTotal },
    },
    legacyListClaims: {
      ...legacy,
      value: legacy.value ? { ...legacy.value, counts: legacy.value.counts } : null,
    },
    legacyAggregateEquivalent: equivalence,
    plans,
    historyFixtures: historyFixtures.map((item) => ({ claimId: item.claimId, requestedRevisions: item.requestedRevisions })),
  };
}

async function benchmarkHistory(args: { client: postgres.Sql; db: Database; services: ReturnType<typeof createReviewServices>; databaseUrl: string; projectId: string; claimId: string; requestedRevisions: number }) {
  const { client, db, services, databaseUrl, projectId, claimId, requestedRevisions } = args;
  const read = createClaimReadServices(db);
  const compact = await measured(readCapture, () => read.getClaimHistorySummaries(projectId, claimId));
  assert(compact.selectCount === 2, `History summary SELECT count must remain two at ${requestedRevisions} revisions; saw ${compact.selectCount}.`);
  const legacy = await measureLegacy(client, databaseUrl, "history", projectId, claimId, LEGACY_HISTORY_TIMEOUT_MS);
  const current = await measured(readCapture, () => services.getCurrentClaim(projectId, claimId));
  const latestActive = requestedRevisions === 1 ? null : await measured(readCapture, () => read.getLatestActiveClaimRevisionId(projectId, claimId));
  const latestActiveId = latestActive?.value ?? null;
  const previousActive = latestActiveId ? await measured(readCapture, () => services.getClaimRevision(projectId, claimId, latestActiveId)) : null;
  const fullRevisionHydrations = 1 + (previousActive ? 1 : 0);
  const planQueries = selectQueries(compact.queries);
  const plan = await explain(client, `history.${requestedRevisions}.summary`, planQueries.at(-1)!);
  const compactProjection = summarizeHistory(compact.value.map((item) => ({
    lifecycle: item.lifecycle,
    supportStatus: item.supportStatus,
    directEvidenceCount: item.directEvidenceCount,
    extractionRevisionCount: item.extractionRevisionCount,
    synthesisRevisionCount: item.synthesisRevisionCount,
    totalSupportCount: item.totalSupportCount,
    citationCandidateCount: item.citationCandidateCount,
    distinctPaperCount: item.distinctPaperCount,
  })));
  const legacyEquivalent = legacy.status === "completed" && legacy.historySummary
    ? Object.entries(compactProjection).every(([key, value]) => legacy.historySummary?.[key] === value)
    : null;
  if (legacyEquivalent === false) throw new Error(`History summary metrics differ from legacy history at ${requestedRevisions} revisions.`);

  return {
    requestedRevisions,
    currentLifecycle: current.value.currentRevision.lifecycle,
    fullRevisionHydrations,
    compactHistory: { wallTimeMs: compact.wallTimeMs, statementCount: compact.statementCount, selectCount: compact.selectCount, materializedRows: compact.value.length, payloadBytes: compact.payloadBytes },
    detailComposition: {
      wallTimeMs: current.wallTimeMs + compact.wallTimeMs + (latestActive?.wallTimeMs ?? 0) + (previousActive?.wallTimeMs ?? 0),
      statementCount: current.statementCount + compact.statementCount + (latestActive?.statementCount ?? 0) + (previousActive?.statementCount ?? 0),
      selectCount: current.selectCount + compact.selectCount + (latestActive?.selectCount ?? 0) + (previousActive?.selectCount ?? 0),
      materializedSummaryRows: compact.value.length,
      payloadBytes: jsonBytes({ current: current.value, priorActive: previousActive?.value ?? null, history: compact.value }),
    },
    legacyGetClaimHistory: legacy,
    legacySummaryEquivalent: legacyEquivalent,
    plan,
  };
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) throw new Error("Set DATABASE_URL to a PostgreSQL 16 role allowed to create and drop its own uniquely named disposable benchmark database.");
  const adminUrl = resolveDatabaseUrl(undefined, configuredUrl);
  const databaseName = `litreview_claim_read_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const benchmarkUrl = new URL(adminUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  const results: unknown[] = [];
  try {
    const versionRows = await admin.unsafe("select current_setting('server_version_num') as version") as unknown as Array<{ version: string }>;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) throw new Error(`Requires PostgreSQL 16; connected server version number is ${versionNumber}.`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;

    const migrationClient = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    } finally {
      await migrationClient.end({ timeout: 1 });
    }

    client = postgres(benchmarkUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const db = captureQueries(client, readCapture);
    await client.unsafe(`set statement_timeout = '${SEED_STATEMENT_TIMEOUT_MS}ms'`);
    const services = createReviewServices(db);
    console.log(JSON.stringify({
      benchmark: "Slice 38 Claim ledger and history read paths",
      postgresVersion: 16,
      claimSizes: CLAIM_SIZES,
      historySizes: HISTORY_SIZES,
      pageSize: PAGE_SIZE,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      seedStatementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      legacyClaimListWallTimeoutMs: LEGACY_WALL_TIMEOUT_MS,
      legacyHistoryWallTimeoutMs: LEGACY_HISTORY_TIMEOUT_MS,
      supportDistribution: "Per Claim ordinal: direct Evidence at %3=0; evidenced ExtractionRevision at %4=0; structural-only ExtractionRevision at %5=0; SynthesisRevision at %7=0. Targets are shared immutable benchmark fixtures.",
      note: "Synthetic data is created only in one uniquely named migrated database and that database is force-dropped in finally. Timings are diagnostics, not pass/fail thresholds.",
    }));

    for (const size of CLAIM_SIZES) {
      const scenario = await benchmarkClaims({ client, db, services, databaseUrl: benchmarkUrl.toString(), size });
      results.push(scenario);
      console.log(JSON.stringify({ claimScenario: scenario }));
    }

    const historyProject = results[2] as { projectId: string; historyFixtures: Array<{ claimId: string; requestedRevisions: number }> };
    const historyResults = [];
    for (const fixture of historyProject.historyFixtures) {
      const result = await benchmarkHistory({ client, db, services, databaseUrl: benchmarkUrl.toString(), projectId: historyProject.projectId, ...fixture });
      historyResults.push(result);
      console.log(JSON.stringify({ historyScenario: result }));
    }
    console.log(JSON.stringify({ benchmarkSummary: { claimScenarioCount: results.length, historyScenarioCount: historyResults.length, results, historyResults } }));
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

if (process.argv[2] === "--legacy-worker") {
  runLegacyWorker().catch((error: unknown) => {
    void sendWorkerMessage({ kind: "result", mode: process.argv[3], measurement: { value: null, status: "failed", wallTimeMs: 0, statementCount: 0, selectCount: 0, payloadBytes: null, error: safeError(error) } }).catch(() => {}).finally(() => {
      (process as NodeJS.Process & { disconnect?: () => void }).disconnect?.();
    });
  });
} else {
  main().catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
