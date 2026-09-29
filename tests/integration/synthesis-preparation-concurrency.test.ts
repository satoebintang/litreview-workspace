import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Database } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";
import { synthesisPreparations } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice47_synth_concurrency_${randomUUID().replaceAll("-", "")}`;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sqlText).join(" ");
  if (!value || typeof value !== "object") return "";
  const item = value as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(item.queryChunks)) return sqlText(item.queryChunks);
  if (Array.isArray(item.value)) return sqlText(item.value);
  return typeof item.value === "string" ? item.value : "";
}

function createPreparationLockGate(database: Database, pauseAfterLock: boolean) {
  const started = deferred<void>();
  const acquired = deferred<void>();
  const release = deferred<void>();
  let observed = false;

  async function observeLockQuery<T>(query: PromiseLike<T>): Promise<T> {
    if (observed) return await query;
    observed = true;
    started.resolve();
    const result = await query;
    acquired.resolve();
    if (pauseAfterLock) await release.promise;
    return result;
  }

  function wrapBuilder(builder: unknown, isPreparation = false, hasUpdateLock = false): unknown {
    if ((typeof builder !== "object" || builder === null) && typeof builder !== "function") return builder;
    const queryBuilder = builder as object;
    return new Proxy(queryBuilder, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "then" && isPreparation && hasUpdateLock && typeof value === "function") {
          return (...args: unknown[]) => observeLockQuery(Reflect.apply(value, target, args) as PromiseLike<unknown>);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const nextIsPreparation = isPreparation || (property === "from" && args[0] === synthesisPreparations);
          const nextHasUpdateLock = hasUpdateLock || (property === "for" && args[0] === "update" && nextIsPreparation);
          return wrapBuilder(Reflect.apply(value, target, args), nextIsPreparation, nextHasUpdateLock);
        };
      },
    });
  }

  function wrapTransaction(tx: unknown): object {
    if ((typeof tx !== "object" || tx === null) && typeof tx !== "function") {
      throw new Error("The database transaction did not provide a transaction object");
    }
    const transaction = tx as object;
    return new Proxy(transaction, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "select" && typeof value === "function") {
          return (...args: unknown[]) => wrapBuilder(Reflect.apply(value, target, args));
        }
        if (property === "execute" && typeof value === "function") {
          return (...args: unknown[]) => {
            const query = Reflect.apply(value, target, args) as PromiseLike<unknown>;
            const statement = sqlText(args[0]);
            return /synthesis_preparations/i.test(statement) && /for\s+update/i.test(statement)
              ? observeLockQuery(query)
              : query;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  const gatedDatabase = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "transaction" && typeof value === "function") {
        return (...args: unknown[]) => {
          const [callback, ...options] = args;
          if (typeof callback !== "function") return Reflect.apply(value, target, args);
          return Reflect.apply(value, target, [
            (tx: unknown) => Reflect.apply(callback, undefined, [wrapTransaction(tx)]),
            ...options,
          ]);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;

  return { database: gatedDatabase, started: started.promise, acquired: acquired.promise, release: release.resolve };
}

describe("Slice 47 synthesis preparation selection concurrency", () => {
  let admin: postgres.Sql | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let services: ReturnType<typeof createReviewServices>;

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    db = createDb(databaseUrl(databaseName));
    await migrate(db.db, { migrationsFolder: migrationFolder });
    services = createReviewServices(db.db);
  });

  afterAll(async () => {
    if (db) await db.client.end();
    if (admin) {
      await admin.unsafe(`drop database if exists "${databaseName}"`);
      await admin.end();
    }
  });

  async function includedPaper(projectId: string, title: string) {
    const paper = await services.addPaper(projectId, { title });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  async function fixture(count = 2, initiallySelected = 0) {
    const project = await services.createProject({ title: `Slice 47 concurrency ${randomUUID()}` });
    const field = await services.createExtractionField(project.id, { name: "Outcome", fieldType: "short_text" });
    const papers = [] as Array<{ id: string }>;
    const evidences = [] as Array<{ id: string }>;
    const revisions = [] as Array<{ id: string }>;
    for (let index = 0; index < count; index += 1) {
      const paper = await includedPaper(project.id, `Study ${index + 1}`);
      const evidence = await services.recordEvidence(project.id, {
        paperId: paper.id,
        sourceText: `Evidence passage ${index + 1}.`,
        pageNumber: 1,
      });
      const revision = await services.reviseExtractionValue(project.id, paper.id, field.id, {
        value: `Outcome ${index + 1}`,
        evidenceIds: [evidence.id],
      });
      papers.push(paper);
      evidences.push(evidence);
      revisions.push(revision);
    }
    const set = (await services.createEvidenceSet(project.id, { name: "Pinned source" })).set;
    for (const evidence of evidences) {
      const current = await services.getEvidenceSet(project.id, set.id);
      await services.addEvidenceToSet(project.id, set.id, {
        evidenceId: evidence.id,
        expectedRevisionId: current.currentRevision.id,
      });
    }
    const preparation = await services.createSynthesisPreparation(project.id, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });
    if (initiallySelected > 0) {
      await services.replaceSynthesisPreparationSelections(project.id, preparation.id, {
        extractionRevisionIds: revisions.slice(0, initiallySelected).map((revision) => revision.id),
      });
    }
    return { project, field, set, preparation, papers, evidences, revisions };
  }

  async function selections(projectId: string, preparationId: string) {
    const rows = await db!.client`
      select extraction_revision_id
      from synthesis_preparation_selections
      where project_id=${projectId}::uuid and preparation_id=${preparationId}::uuid
      order by extraction_revision_id
    `;
    return rows.map((row) => String(row.extraction_revision_id));
  }

  async function supports(projectId: string, synthesisRevisionId: string) {
    const rows = await db!.client`
      select extraction_revision_id
      from synthesis_revision_supports
      where project_id=${projectId}::uuid and synthesis_revision_id=${synthesisRevisionId}::uuid
      order by extraction_revision_id
    `;
    return rows.map((row) => String(row.extraction_revision_id));
  }

  async function raceOnPreparationLock<T, U>(
    firstAction: (firstServices: ReturnType<typeof createReviewServices>) => Promise<T>,
    secondAction: (secondServices: ReturnType<typeof createReviewServices>) => Promise<U>,
  ): Promise<[T, U]> {
    const holder = createPreparationLockGate(db!.db, true);
    const waiter = createPreparationLockGate(db!.db, false);
    const firstServices = createReviewServices(holder.database);
    const secondServices = createReviewServices(waiter.database);
    const firstPromise = firstAction(firstServices);
    let secondPromise: Promise<U> | undefined;
    try {
      await Promise.race([
        holder.acquired,
        firstPromise.then(() => { throw new Error("First operation completed before acquiring the preparation lock"); }),
      ]);
      secondPromise = secondAction(secondServices);
      await Promise.race([
        waiter.started,
        secondPromise.then(() => { throw new Error("Second operation completed before reaching the preparation lock"); }),
      ]);
      holder.release();
      return await Promise.all([firstPromise, secondPromise]);
    } finally {
      holder.release();
    }
  }

  async function raceAiBeginWithSelection<T>(
    fixtureValue: Awaited<ReturnType<typeof fixture>>,
    select: (lockedServices: ReturnType<typeof createReviewServices>) => Promise<T>,
  ): Promise<[T, Record<string, unknown>]> {
    const holder = createPreparationLockGate(db!.db, true);
    const waiter = createPreparationLockGate(db!.db, false);
    const lockedServices = createReviewServices(holder.database);
    const ai = createAiSynthesisSuggestionServices(waiter.database, undefined, {
      defaultModel: "fake-model",
      defaultReasoningEffort: "low",
      finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction,
    });
    const selected = select(lockedServices);
    let begun: Promise<Record<string, unknown>> | undefined;
    try {
      await Promise.race([
        holder.acquired,
        selected.then(() => { throw new Error("Selection completed before acquiring the preparation lock"); }),
      ]);
      begun = ai.beginAiSynthesisSuggestion({
        projectId: fixtureValue.project.id,
        preparationId: fixtureValue.preparation.id,
        idempotencyKey: randomUUID(),
        externalTransmissionAcknowledged: true,
        disclosureVersion: "slice47-concurrency-test-v1",
      });
      await Promise.race([
        waiter.started,
        begun.then(() => { throw new Error("AI begin completed before reaching the preparation lock"); }),
      ]);
      holder.release();
      return await Promise.all([selected, begun]);
    } finally {
      holder.release();
    }
  }

  it("serializes disjoint and duplicate single-revision selections", async () => {
    const distinct = await fixture(2);
    await raceOnPreparationLock(
      (locked) => locked.selectSynthesisPreparationRevision(distinct.project.id, distinct.preparation.id, { extractionRevisionId: distinct.revisions[0].id }),
      (waiting) => waiting.selectSynthesisPreparationRevision(distinct.project.id, distinct.preparation.id, { extractionRevisionId: distinct.revisions[1].id }),
    );
    expect(await selections(distinct.project.id, distinct.preparation.id)).toEqual(distinct.revisions.map((revision) => revision.id).sort());

    const same = await fixture(1);
    await raceOnPreparationLock(
      (locked) => locked.selectSynthesisPreparationRevision(same.project.id, same.preparation.id, { extractionRevisionId: same.revisions[0].id }),
      (waiting) => waiting.selectSynthesisPreparationRevision(same.project.id, same.preparation.id, { extractionRevisionId: same.revisions[0].id }),
    );
    expect(await selections(same.project.id, same.preparation.id)).toEqual([same.revisions[0].id]);
  });

  it("serializes select-deselect and select-metadata writes on the preparation row", async () => {
    const toggled = await fixture(1, 1);
    await raceOnPreparationLock(
      (locked) => locked.selectSynthesisPreparationRevision(toggled.project.id, toggled.preparation.id, { extractionRevisionId: toggled.revisions[0].id }),
      (waiting) => waiting.deselectSynthesisPreparationRevision(toggled.project.id, toggled.preparation.id, { extractionRevisionId: toggled.revisions[0].id }),
    );
    expect(await selections(toggled.project.id, toggled.preparation.id)).toEqual([]);

    const metadata = await fixture(1);
    await raceOnPreparationLock(
      (locked) => locked.selectSynthesisPreparationRevision(metadata.project.id, metadata.preparation.id, { extractionRevisionId: metadata.revisions[0].id }),
      (waiting) => waiting.updateSynthesisPreparation(metadata.project.id, metadata.preparation.id, { workingTitle: "Serialized metadata" }),
    );
    expect(await selections(metadata.project.id, metadata.preparation.id)).toEqual([metadata.revisions[0].id]);
    const workspace = await services.getSynthesisPreparationWorkspace(metadata.project.id, metadata.preparation.id);
    expect(workspace.preparation.workingTitle).toBe("Serialized metadata");
  });

  it("serializes select-abandon and select-finalize transitions", async () => {
    const abandoned = await fixture(1);
    const [selected, terminal] = await raceOnPreparationLock(
      (locked) => locked.selectSynthesisPreparationRevision(abandoned.project.id, abandoned.preparation.id, { extractionRevisionId: abandoned.revisions[0].id }),
      (waiting) => waiting.abandonSynthesisPreparation(abandoned.project.id, abandoned.preparation.id),
    );
    expect(selected).toBe(abandoned.revisions[0].id);
    expect(terminal.status).toBe("abandoned");
    expect(await selections(abandoned.project.id, abandoned.preparation.id)).toEqual([abandoned.revisions[0].id]);

    const finalized = await fixture(1);
    const [, result] = await raceOnPreparationLock(
      (locked) => locked.selectSynthesisPreparationRevision(finalized.project.id, finalized.preparation.id, { extractionRevisionId: finalized.revisions[0].id }),
      (waiting) => waiting.finalizeSynthesisPreparation(finalized.project.id, finalized.preparation.id, { statementText: "Finalized after concurrent selection" }),
    );
    expect(result.preparation.status).toBe("finalized");
    expect(await supports(finalized.project.id, result.revision.id)).toEqual([finalized.revisions[0].id]);
  });

  it("serializes deselect-finalize so finalization freezes the post-deselection empty support set", async () => {
    const prepared = await fixture(1, 1);
    const [, result] = await raceOnPreparationLock(
      (locked) => locked.deselectSynthesisPreparationRevision(prepared.project.id, prepared.preparation.id, { extractionRevisionId: prepared.revisions[0].id }),
      (waiting) => waiting.finalizeSynthesisPreparation(prepared.project.id, prepared.preparation.id, { statementText: "Finalized after concurrent deselection" }),
    );
    expect(result.preparation.status).toBe("finalized");
    expect(await selections(prepared.project.id, prepared.preparation.id)).toEqual([]);
    expect(await supports(prepared.project.id, result.revision.id)).toEqual([]);
  });

  it("serializes AI begin with a selection mutation and captures the committed selection", async () => {
    const prepared = await fixture(2, 1);
    const [, begun] = await raceAiBeginWithSelection(prepared, (locked) =>
      locked.selectSynthesisPreparationRevision(prepared.project.id, prepared.preparation.id, { extractionRevisionId: prepared.revisions[1].id }),
    );
    const rows = await db!.client`
      select extraction_revision_id
      from ai_synthesis_request_supports
      where project_id=${prepared.project.id}::uuid and request_id=${String(begun.requestId)}::uuid
      order by extraction_revision_id
    `;
    expect(rows.map((row) => String(row.extraction_revision_id))).toEqual(prepared.revisions.map((revision) => revision.id).sort());
  });
});
