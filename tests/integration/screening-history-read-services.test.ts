import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createReviewServices } from "@/application/services";
import { createScreeningHistoryReadServices } from "@/application/screening-history-read-services";
import type { Database } from "@/db/client";
import { schema, screeningDecisions, fullTextScreeningDecisions, fullTextRetrievalAttempts } from "@/db/schema";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const queryLog: string[] = [];
const client = postgres(databaseUrl, { max: 8, prepare: false, debug: (_connection, query) => { queryLog.push(query); } });
const db = drizzle(client, { schema }) as Database;
const services = createReviewServices(db);
const history = createScreeningHistoryReadServices(db);

function clearQueries() { queryLog.length = 0; }
function selects() { return queryLog.filter((query) => /^(with|select)\b/i.test(query.trim())); }

async function projectAndPaper(label: string) {
  const project = await services.createProject({ title: `Slice 51 ${label} ${randomUUID()}` });
  const paper = await services.addPaper(project.id, {
    title: `Paper ${label}`,
    authors: ["Exact author list"],
    abstract: "Exact abstract must stay whole.",
    doi: "10.5555/exact-paper-content",
  });
  return { project, paper };
}

function deterministicRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function collectPages<T>(load: (cursor: string | null) => Promise<{ page: { items: T[]; nextCursor: string | null; hasMore: boolean } }>) {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let step = 0; step < 100; step += 1) {
    const result = await load(cursor);
    items.push(...result.page.items);
    cursor = result.page.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("Screening history cursor traversal exceeded its test bound");
}

function decodedCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

function encodeCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("Slice 51 bounded screening history reads", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await Promise.all(Array.from({ length: 5 }, () => client.unsafe("select 1")));
  }, 120_000);

  afterAll(async () => { await client.end(); }, 120_000);

  it("traverses deterministic randomized histories equivalently and restores complete exact events", async () => {
    const random = deterministicRandom(510051);
    const { project, paper } = await projectAndPaper("randomized equivalence");
    const taCriterion = await services.createScreeningCriterion(project.id, { type: "exclusion", text: "Randomized title/abstract exclusion criterion" });
    const ftCriterion = await services.createFullTextScreeningCriterion(project.id, { text: "Randomized full-text exclusion criterion" });
    const taDecisions: Array<"include" | "exclude" | "maybe"> = [];
    for (let index = 0; index < 18; index += 1) {
      const decision = (["include", "exclude", "maybe"] as const)[Math.floor(random() * 3)];
      taDecisions.push(decision);
      const note = random() > 0.3 ? `TA event ${index} · ${"x".repeat(index)}` : undefined;
      if (decision === "exclude") {
        await services.recordScreeningDecision(project.id, paper.id, { decision, exclusionCriterionId: taCriterion.id, ...(note ? { note } : {}) });
      } else {
        await services.recordScreeningDecision(project.id, paper.id, { decision, ...(note ? { note } : {}) });
      }
    }
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include", note: "Current eligibility gate" });

    const retrievalOutcomes: Array<"pending" | "unavailable" | "retrieved"> = [];
    for (let index = 0; index < 11; index += 1) {
      const outcome = index === 10 ? "retrieved" : (["pending", "unavailable", "retrieved"] as const)[Math.floor(random() * 3)];
      retrievalOutcomes.push(outcome);
      await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
        outcome,
        method: index % 2 ? "publisher" : "manual",
        sourceReference: random() > 0.5 ? `Source ${index}` : undefined,
        note: random() > 0.5 ? `Retrieval note ${index}` : undefined,
        attemptedAt: new Date(Date.UTC(1980 + index, index % 12, 1)),
      });
    }

    for (let index = 0; index < 13; index += 1) {
      const decision = (["include", "exclude", "maybe"] as const)[Math.floor(random() * 3)];
      const note = random() > 0.4 ? `FT event ${index}` : undefined;
      if (decision === "exclude") {
        await services.recordFullTextScreeningDecision(project.id, paper.id, { decision, exclusionCriterionId: ftCriterion.id, ...(note ? { note } : {}) });
      } else {
        await services.recordFullTextScreeningDecision(project.id, paper.id, { decision, ...(note ? { note } : {}) });
      }
    }

    const legacyTa = await services.getPaperScreening(project.id, paper.id);
    const legacyFt = await services.getPaperFullTextScreening(project.id, paper.id);
    const taPaged = await collectPages((cursor) => history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 3, cursor }));
    const ftPaged = await collectPages((cursor) => history.getFullTextScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 4, cursor }));
    const retrievalPaged = await collectPages((cursor) => history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: 2, cursor }));

    expect(taPaged.map((item) => ({ id: item.id, sequence: item.sequence, decision: item.decision, criterion: item.exclusionCriterion?.id ?? null, note: item.note })))
      .toEqual(legacyTa.history.map((item) => ({ id: item.id, sequence: String(item.sequence), decision: item.decision, criterion: item.exclusionCriterion?.id ?? null, note: item.note })));
    expect(ftPaged.map((item) => ({ id: item.id, sequence: item.sequence, decision: item.decision, criterion: item.exclusionCriterion?.id ?? null, note: item.note })))
      .toEqual(legacyFt.history.map((item) => ({ id: item.id, sequence: String(item.sequence), decision: item.decision, criterion: item.exclusionCriterion?.id ?? null, note: item.note })));
    expect(retrievalPaged.map((item) => ({ id: item.id, sequence: item.sequence, outcome: item.outcome, method: item.method, attemptedAt: item.attemptedAt.toISOString(), sourceReference: item.sourceReference, note: item.note })))
      .toEqual(legacyFt.retrievalHistory.map((item) => ({ id: item.id, sequence: String(item.sequence), outcome: item.outcome, method: item.method, attemptedAt: item.attemptedAt.toISOString(), sourceReference: item.sourceReference, note: item.note })));
    expect(retrievalOutcomes.at(-1)).toBe("retrieved");
    expect(taDecisions).toHaveLength(18);

    const taExcluded = legacyTa.history.find((item) => item.decision === "exclude")!;
    const taExact = await history.getScreeningDecisionEvent(project.id, paper.id, taExcluded.id);
    expect(taExact.event.note).toBe(taExcluded.note);
    expect(taExact.event.exclusionCriterion?.text).toBe(taCriterion.text);
    const ftExcluded = legacyFt.history.find((item) => item.decision === "exclude")!;
    const ftExact = await history.getFullTextScreeningDecisionEvent(project.id, paper.id, ftExcluded.id);
    expect(ftExact.event.note).toBe(ftExcluded.note);
    expect(ftExact.event.exclusionCriterion?.text).toBe(ftCriterion.text);
    const retrievalExact = await history.getFullTextRetrievalAttemptEvent(project.id, paper.id, legacyFt.retrievalHistory[0].id);
    expect(retrievalExact.event.sourceReference).toBe(legacyFt.retrievalHistory[0].sourceReference);
    expect(retrievalExact.event.note).toBe(legacyFt.retrievalHistory[0].note);
  });

  it("keeps BIGINT sequences lossless, pages same-sequence rows by ID, and rejects forged bindings", async () => {
    const { project, paper } = await projectAndPaper("bigint and cursors");
    await db.execute(sql`select setval(pg_get_serial_sequence('screening_decisions','sequence'), 9007199254740992, true)`);
    const bigEvent = await services.recordScreeningDecision(project.id, paper.id, { decision: "include", note: "Beyond Number.MAX_SAFE_INTEGER" });

    const tieIds = await db.execute(sql`insert into screening_decisions (sequence, project_id, paper_id, stage, decision, note)
      overriding system value
      values (9007199254740993, ${project.id}::uuid, ${paper.id}::uuid, 'title_abstract', 'include', 'same sequence peer')
      returning id::text as id`);
    const peerId = String((tieIds as unknown as Array<Record<string, unknown>>)[0].id);
    const first = await history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 1 });
    expect(first.page.items[0].sequence).toBe("9007199254740993");
    expect(first.page.items[0].sequence).not.toBe(String(Number(first.page.items[0].sequence)));
    const tied = await collectPages((cursor) => history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 1, cursor }));
    const highEvents = tied.filter((item) => item.sequence === "9007199254740993");
    expect(highEvents.map((item) => item.id)).toEqual([bigEvent.id, peerId].sort());
    const sameSequenceCurrent = (await history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 50 })).page.currentEvent;
    expect(sameSequenceCurrent?.sequence).toBe("9007199254740993");

    const cursor = first.page.nextCursor!;
    const decoded = decodedCursor(cursor);
    expect(decoded.lastSequence).toBe("9007199254740993");
    const other = await projectAndPaper("cursor foreign scope");
    const foreignStreamEvent = await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
      outcome: "pending", attemptedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const foreignStreamSequenceRows = await db.execute(sql`select sequence::text as sequence from full_text_retrieval_attempts where id=${foreignStreamEvent.id}::uuid`);
    const foreignStreamSequence = String((foreignStreamSequenceRows as unknown as Array<Record<string, unknown>>)[0].sequence);
    const invalidCursorCases = [
      { name: "empty token", token: "" },
      { name: "invalid base64url", token: "not-base64!" },
      { name: "oversized token", token: "A".repeat(513) },
      { name: "invalid UTF-8", token: Buffer.from([0xff]).toString("base64url") },
      { name: "malformed JSON", token: Buffer.from("{", "utf8").toString("base64url") },
      { name: "invalid UUID field", token: encodeCursor({ ...decoded, projectId: "not-a-uuid" }) },
      { name: "PostgreSQL BIGINT overflow", token: encodeCursor({ ...decoded, lastSequence: "9223372036854775808" }) },
      { name: "wrong cursor version", token: encodeCursor({ ...decoded, v: 2 }) },
      { name: "unexpected cursor field", token: encodeCursor({ ...decoded, extra: true }) },
      { name: "different effective page size", token: encodeCursor({ ...decoded, pageSize: 2 }) },
      {
        name: "anchor tuple from another fixed history stream",
        token: encodeCursor({ ...decoded, lastSequence: foreignStreamSequence, lastEventId: foreignStreamEvent.id }),
      },
    ];
    for (const { name, token } of invalidCursorCases) {
      await expect(
        history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 1, cursor: token }),
        name,
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(history.getScreeningDecisionHistoryPage(other.project.id, other.paper.id, { pageSize: 1, cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(history.getFullTextScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 1, cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const forgedAnchor = encodeCursor({ ...decoded, lastEventId: randomUUID() });
    await expect(history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 1, cursor: forgedAnchor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const wrongEvent = await projectAndPaper("wrong exact event scope");
    await expect(history.getScreeningDecisionEvent(project.id, paper.id, wrongEvent.paper.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(history.getScreeningDecisionEvent(wrongEvent.project.id, wrongEvent.paper.id, bigEvent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(history.getFullTextScreeningDecisionEvent(project.id, paper.id, bigEvent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns generic not-found behavior for every incorrectly scoped exact event type", async () => {
    const { project, paper } = await projectAndPaper("scoped exact event negatives");
    const otherPaper = await services.addPaper(project.id, {
      title: "Second Paper for exact event scope checks",
      authors: ["Exact author list"],
      abstract: "Exact abstract must stay whole.",
      doi: "10.5555/second-exact-paper-content",
    });
    const otherProject = await services.createProject({ title: `Slice 51 unrelated exact scope ${randomUUID()}` });
    const titleAbstract = await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    const retrievalAttempt = await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
      outcome: "retrieved", attemptedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const fullTextDecision = await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });

    const readers = {
      "TA decision": history.getScreeningDecisionEvent,
      "full-text decision": history.getFullTextScreeningDecisionEvent,
      "retrieval attempt": history.getFullTextRetrievalAttemptEvent,
    } as const;
    const eventIds = {
      "TA decision": titleAbstract.id,
      "full-text decision": fullTextDecision.id,
      "retrieval attempt": retrievalAttempt.id,
    } as const;
    const wrongTypeEventIds = {
      "TA decision": [fullTextDecision.id, retrievalAttempt.id],
      "full-text decision": [titleAbstract.id, retrievalAttempt.id],
      "retrieval attempt": [titleAbstract.id, fullTextDecision.id],
    } as const;
    const exactReadCases = Object.entries(readers).flatMap(([readerName, read]) => {
      const eventId = eventIds[readerName as keyof typeof eventIds];
      const wrongTypeIds = wrongTypeEventIds[readerName as keyof typeof wrongTypeEventIds];
      return [
        { name: `${readerName}: wrong Project`, read: () => read(otherProject.id, paper.id, eventId) },
        { name: `${readerName}: wrong Paper`, read: () => read(project.id, otherPaper.id, eventId) },
        { name: `${readerName}: missing event`, read: () => read(project.id, paper.id, randomUUID()) },
        ...wrongTypeIds.map((wrongTypeId) => ({
          name: `${readerName}: event from another history type`,
          read: () => read(project.id, paper.id, wrongTypeId),
        })),
      ];
    });

    for (const { name, read } of exactReadCases) {
      await expect(read(), name).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Screening history event was not found",
      });
    }
  });

  it("uses two owned SELECTs for standalone history and exact reads and isolates stream continuations", async () => {
    const { project, paper } = await projectAndPaper("query budgets");
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    const ft = await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const retrieval = (await services.getPaperFullTextRetrieval(project.id, paper.id)).history[0];

    clearQueries();
    const ftPage = await history.getFullTextScreeningDecisionHistoryPage(project.id, paper.id);
    expect(selects()).toHaveLength(2);
    expect(queryLog.join("\n")).not.toContain("full_text_retrieval_attempts");
    expect(ftPage.page.items[0].id).toBe(ft.id);

    clearQueries();
    const retrievalPage = await history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id);
    expect(selects()).toHaveLength(2);
    expect(queryLog.join("\n")).not.toContain("full_text_screening_decisions");
    expect(retrievalPage.page.items[0].id).toBe(retrieval.id);

    const exactDecisionId = (await services.getPaperScreening(project.id, paper.id)).history[0].id;
    clearQueries();
    await history.getScreeningDecisionEvent(project.id, paper.id, exactDecisionId);
    expect(selects()).toHaveLength(2);

    clearQueries();
    await history.getTitleAbstractScreeningDetail(project.id, paper.id);
    expect(selects()).toHaveLength(4);
    expect(queryLog.some((query) => /order by event\.sequence desc\s+limit 1/i.test(query))).toBe(true);
    expect(queryLog.some((query) => /order by event\.sequence desc\s*,\s*event\.id/i.test(query))).toBe(false);

    clearQueries();
    await history.getFullTextScreeningDetail(project.id, paper.id);
    expect(selects()).toHaveLength(4);

    clearQueries();
    await history.getFullTextRetrievalDetail(project.id, paper.id);
    expect(selects()).toHaveLength(2);
  });

  it("keeps current retrieval state sequence-based and pages live appends with a separate exact value read", async () => {
    const { project, paper } = await projectAndPaper("retrieval chronology");
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
      outcome: "unavailable", attemptedAt: new Date("2200-01-01T00:00:00.000Z"), note: "Oldest sequence, future researcher time",
    });
    const retrieved = await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
      outcome: "retrieved", attemptedAt: new Date("2099-01-01T00:00:00.000Z"), sourceReference: "retrieved full source", note: "Retrieved first",
    });
    const first = await history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: 1 });
    expect(first.page.nextCursor).not.toBeNull();
    const pending = await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
      outcome: "pending", attemptedAt: new Date("1900-01-01T00:00:00.000Z"), note: "Current pending attempt with a backdated researcher time",
    });
    const second = await history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: 1, cursor: first.page.nextCursor });
    expect(second.page.items[0].id).toBe(retrieved.id);
    expect(second.page.currentEvent).toMatchObject({ id: pending.id, sequence: String(pending.sequence), outcome: "pending" });
    const detail = await history.getFullTextRetrievalDetail(project.id, paper.id);
    expect(detail.currentState).toBe("pending");
    expect(detail.everRetrieved).toBe(true);
    expect(detail.history.items.some((item) => item.id === retrieved.id && item.isCurrent)).toBe(false);
    const exact = await history.getFullTextRetrievalAttemptEvent(project.id, paper.id, retrieved.id);
    expect(exact.event.sourceReference).toBe("retrieved full source");
    expect(exact.event.note).toBe("Retrieved first");

    const live = await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "unavailable", attemptedAt: new Date("2200-01-01T00:00:00.000Z") });
    const continued = await history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: 1, cursor: second.page.nextCursor });
    expect(continued.page.items[0].id).toBe(pending.id);
    expect(continued.page.hasMore).toBe(true);
    const afterCurrent = await history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: 1, cursor: continued.page.nextCursor });
    expect(afterCurrent.page.items[0].id).toBe(live.id);
    expect(afterCurrent.page.currentEvent).toMatchObject({ id: live.id, outcome: "unavailable" });
  });

  it("enforces SQL previews and both history payload budgets while exact events recover the source text", async () => {
    const { project, paper } = await projectAndPaper("payload budgets");
    const control = `x${"\u0001".repeat(800)}`;
    const taCriterion = await services.createScreeningCriterion(project.id, { type: "exclusion", text: control });
    const ftCriterion = await services.createFullTextScreeningCriterion(project.id, { text: control });
    const titleDecisionRows = Array.from({ length: 49 }, () => ({
      projectId: project.id, paperId: paper.id, stage: "title_abstract" as const, decision: "exclude" as const,
      exclusionCriterionId: taCriterion.id, exclusionCriterionType: "exclusion" as const, note: control,
    }));
    const taInserted = await db.insert(screeningDecisions).values(titleDecisionRows).returning({ id: screeningDecisions.id });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    const ftInserted = await db.insert(fullTextScreeningDecisions).values(Array.from({ length: 50 }, () => ({
      projectId: project.id, paperId: paper.id, decision: "exclude" as const, exclusionCriterionId: ftCriterion.id, note: control,
    }))).returning({ id: fullTextScreeningDecisions.id });
    const retrievalInserted = await db.insert(fullTextRetrievalAttempts).values(Array.from({ length: 49 }, () => ({
      projectId: project.id, paperId: paper.id, outcome: "pending" as const, attemptedAt: new Date(), sourceReference: control, note: control,
    }))).returning({ id: fullTextRetrievalAttempts.id });

    await services.archiveScreeningCriterion(project.id, taCriterion.id);
    await services.archiveFullTextScreeningCriterion(project.id, ftCriterion.id);
    const taMaximum = await history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 50 });
    const ftMaximum = await history.getFullTextScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 50 });
    const retrievalMaximum = await history.getFullTextRetrievalAttemptHistoryPage(project.id, paper.id, { pageSize: 50 });
    for (const page of [taMaximum.page, ftMaximum.page, retrievalMaximum.page]) {
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(256 * 1024);
      expect(page.items).toHaveLength(50);
      expect(page.hasMore).toBe(false);
    }
    expect(taMaximum.page.items[0].note).toHaveLength(600);
    expect(taMaximum.page.items[0].noteTruncated).toBe(true);
    expect(taMaximum.page.items[0].exclusionCriterion?.text).toHaveLength(128);
    expect(taMaximum.page.items[0].criterionTextTruncated).toBe(true);
    expect(taMaximum.page.items[0].exclusionCriterion?.archivedAt).toBeInstanceOf(Date);
    expect(ftMaximum.page.items[0].exclusionCriterion?.archivedAt).toBeInstanceOf(Date);
    const retrievalPreview = retrievalMaximum.page.items.find((item) => item.note != null)!;
    expect(retrievalPreview.note).toHaveLength(384);
    expect(retrievalPreview.sourceReference).toHaveLength(384);
    expect(retrievalPreview.noteTruncated).toBe(true);
    expect(retrievalPreview.sourceReferenceTruncated).toBe(true);

    const fullTextDetail = await history.getFullTextScreeningDetail(project.id, paper.id);
    const combinedDetailBytes = Buffer.byteLength(JSON.stringify({
      decisionHistory: fullTextDetail.history,
      retrievalHistory: fullTextDetail.retrievalHistory,
      currentEvent: fullTextDetail.currentEvent,
      retrievalCurrent: fullTextDetail.retrievalCurrent,
    }), "utf8");
    expect(combinedDetailBytes).toBeLessThanOrEqual(256 * 1024);
    const exactTa = await history.getScreeningDecisionEvent(project.id, paper.id, taInserted[0].id);
    expect(exactTa.event.note).toBe(control);
    expect(exactTa.event.exclusionCriterion?.text).toBe(control);
    const exactFt = await history.getFullTextScreeningDecisionEvent(project.id, paper.id, ftInserted[0].id);
    expect(exactFt.event.note).toBe(control);
    expect(exactFt.event.exclusionCriterion?.text).toBe(control);
    const exactRetrieval = await history.getFullTextRetrievalAttemptEvent(project.id, paper.id, retrievalInserted[0].id);
    expect(exactRetrieval.event.sourceReference).toBe(control);
    expect(exactRetrieval.event.note).toBe(control);
  });

  it("documents late lower-sequence visibility without changing greatest-sequence current state", async () => {
    const { project, paper } = await projectAndPaper("late lower commit");
    const reserved = await client.unsafe(`select nextval(pg_get_serial_sequence('screening_decisions','sequence'))::text as sequence`);
    const lowerSequence = String(reserved[0].sequence);
    const higher = await services.recordScreeningDecision(project.id, paper.id, { decision: "maybe", note: "Higher event commits first" });
    const traversed = await history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 20 });
    expect(traversed.page.items.map((item) => item.id)).toEqual([higher.id]);
    expect(traversed.page.hasMore).toBe(false);
    await db.execute(sql`insert into screening_decisions (sequence, project_id, paper_id, stage, decision, note)
      overriding system value values (${lowerSequence}::bigint, ${project.id}::uuid, ${paper.id}::uuid, 'title_abstract', 'include', 'Lower sequence committed late')`);
    const restarted = await history.getScreeningDecisionHistoryPage(project.id, paper.id, { pageSize: 20 });
    expect(restarted.page.items.map((item) => item.id)).toHaveLength(2);
    expect(restarted.page.items[0].sequence).toBe(lowerSequence);
    expect(restarted.page.items[1].id).toBe(higher.id);
    expect(restarted.page.currentEvent).toMatchObject({ id: higher.id, decision: "maybe" });
    expect(restarted.page.currentEvent?.sequence).toBe(restarted.page.items[1].sequence);
  });
});
