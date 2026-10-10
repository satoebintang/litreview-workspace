import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtractionEvidenceSelectionReadServices } from "@/application/extraction-evidence-selection-read-services";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { schema } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice55_extract_evidence_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.hostname = "127.0.0.1";
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 55 bounded Extraction Evidence candidate reads", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let countedClient: postgres.Sql | undefined;
  let services: ReturnType<typeof createReviewServices> | undefined;
  let candidateReads: ReturnType<typeof createExtractionEvidenceSelectionReadServices> | undefined;
  const queryLog: string[] = [];

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const created = createDb(databaseUrl.toString());
    appClient = created.client;
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    services = createReviewServices(created.db);
    countedClient = postgres(databaseUrl.toString(), { max: 1, prepare: false });
    const countedDb = drizzle(countedClient, {
      schema,
      logger: { logQuery(query) { queryLog.push(query); } },
    });
    candidateReads = createExtractionEvidenceSelectionReadServices(countedDb);
  });

  afterAll(async () => {
    await Promise.all([appClient?.end(), countedClient?.end()]);
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("pages every Paper candidate in deterministic timestamp/id order, including microsecond ties and rejected items", async () => {
    const project = await services!.createProject({ title: `Slice 55 candidate page ${randomUUID()}` });
    const paper = await services!.addPaper(project.id, { title: "Selection paper" });
    const otherPaper = await services!.addPaper(project.id, { title: "Other selection paper" });
    const foreignProject = await services!.createProject({ title: `Slice 55 foreign ${randomUUID()}` });
    const foreignPaper = await services!.addPaper(foreignProject.id, { title: "Foreign selection paper" });
    const longSource = "🙂\u0001".repeat(800);
    const longNote = "漢\u0002".repeat(400);
    const timestamps = [
      "2026-10-06T12:00:00.123456Z",
      "2026-10-06T12:00:00.123455Z",
      "2026-10-06T12:00:00.123456Z",
      "2026-10-06T12:00:00.123456Z",
      "2026-10-06T12:00:00.123457Z",
    ];
    const evidenceDrafts = [
      { sourceText: longSource, note: longNote, pageNumber: 1 },
      { sourceText: "Needs review passage", note: null, pageNumber: 2 },
      { sourceText: "Rejected passage", note: null, pageNumber: 3 },
      { sourceText: "Unreviewed passage", note: null, pageNumber: 4 },
      { sourceText: "Newest tied passage", note: null, pageNumber: 5 },
    ];
    const items = [] as { id: string }[];
    for (const [index, draft] of evidenceDrafts.entries()) {
      const [item] = await appClient!<{ id: string }[]>`insert into evidence
        (project_id, paper_id, source_text, note, page_number, created_at, updated_at)
        values (${project.id}::uuid, ${paper.id}::uuid, ${draft.sourceText}, ${draft.note}, ${draft.pageNumber}, ${timestamps[index]}::timestamptz, ${timestamps[index]}::timestamptz)
        returning id::text as id`;
      items.push(item);
    }
    await services!.appendEvidenceReviewDecision(project.id, items[1].id, { decision: "needs_review" });
    await services!.appendEvidenceReviewDecision(project.id, items[2].id, { decision: "rejected" });
    await services!.appendEvidenceReviewDecision(project.id, items[0].id, { decision: "accepted" });
    const otherPaperEvidence = await services!.recordEvidence(project.id, { paperId: otherPaper.id, sourceText: "Other Paper", pageNumber: 1 });
    const foreignEvidence = await services!.recordEvidence(foreignProject.id, { paperId: foreignPaper.id, sourceText: "Foreign Project", pageNumber: 1 });

    const oracle = await appClient!<{ id: string }[]>`select id::text as id from evidence where project_id=${project.id}::uuid and paper_id=${paper.id}::uuid order by created_at desc, id asc`;
    const traversed: string[] = [];
    let after: string | null = null;
    let firstPage: Awaited<ReturnType<ReturnType<typeof createExtractionEvidenceSelectionReadServices>["getPaperExtractionEvidenceCandidatePage"]>> | null = null;
    do {
      const result = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { pageSize: 2, after });
      if (!firstPage) firstPage = result;
      expect(result.items.length).toBeLessThanOrEqual(2);
      traversed.push(...result.items.map((item) => item.id));
      after = result.nextCursor;
    } while (after);

    expect(firstPage).not.toBeNull();
    expect(firstPage!.items).toHaveLength(2);
    expect(firstPage!.hasNext).toBe(true);
    expect(firstPage!.items.map((item) => item.id)).toEqual(oracle.slice(0, 2).map((item) => item.id));
    expect(traversed).toEqual(oracle.map((item) => item.id));
    expect(new Set(traversed).size).toBe(traversed.length);
    const rejectedPage = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { pageSize: 10 });
    expect(rejectedPage.items.find((item) => item.id === items[2].id)).toMatchObject({ reviewState: "rejected", curationWarning: "currently_rejected" });
    expect(rejectedPage.items.find((item) => item.id === items[1].id)).toMatchObject({ reviewState: "needs_review", curationWarning: "needs_review" });
    expect(rejectedPage.items.find((item) => item.id === items[3].id)).toMatchObject({ reviewState: "unreviewed", curationWarning: "never_reviewed" });
    expect(rejectedPage.items.find((item) => item.id === items[0].id)).toMatchObject({
      sourceTextPreview: "🙂\u0001".repeat(600),
      sourceTextTruncated: true,
      notePreview: "漢\u0002".repeat(300),
      noteTruncated: true,
      reviewState: "accepted",
      href: `/projects/${project.id}/evidence/${items[0].id}`,
    });
    expect(rejectedPage.items.map((item) => item.id)).not.toContain(otherPaperEvidence.id);
    expect(rejectedPage.items.map((item) => item.id)).not.toContain(foreignEvidence.id);

    const selectedMetadata = await candidateReads!.getPaperExtractionEvidenceSupportMetadata(project.id, paper.id, [items[2].id, otherPaperEvidence.id, foreignEvidence.id, "not-a-uuid"]);
    expect(selectedMetadata.map((item) => item.id)).toEqual([items[2].id]);
    expect(selectedMetadata[0]).toMatchObject({ reviewState: "rejected", projectId: project.id, paperId: paper.id });
  });

  it("uses two reads for an empty Paper and three bounded reads for a nonempty page", async () => {
    const project = await services!.createProject({ title: `Slice 55 SQL count ${randomUUID()}` });
    const emptyPaper = await services!.addPaper(project.id, { title: "Empty Paper" });
    queryLog.length = 0;
    const empty = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, emptyPaper.id);
    expect(empty.items).toEqual([]);
    expect(empty.hasNext).toBe(false);
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);

    await services!.recordEvidence(project.id, { paperId: emptyPaper.id, sourceText: "One row", pageNumber: 1 });
    queryLog.length = 0;
    const nonempty = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, emptyPaper.id);
    expect(nonempty.items).toHaveLength(1);
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(3);

    const otherProject = await services!.createProject({ title: `Slice 55 other scope ${randomUUID()}` });
    const foreignPaper = await services!.addPaper(otherProject.id, { title: "Foreign Paper" });
    await expect(candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, foreignPaper.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await expect(candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, emptyPaper.id, { pageSize: 1, after: "bad-cursor" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("filters complete same-Paper passage and note text before keyset pagination", async () => {
    const project = await services!.createProject({ title: `Slice 57 search ${randomUUID()}` });
    const paper = await services!.addPaper(project.id, { title: "Search paper" });
    const otherPaper = await services!.addPaper(project.id, { title: "Other search paper" });
    const longSource = `${"prefix ".repeat(190)}RARE-TAIL-Ω`;
    const longNote = `${"researcher note ".repeat(50)}NOTE-TAIL-NEEDLE`;
    const drafts = [
      { sourceText: longSource, note: null, pageNumber: 1 },
      { sourceText: "Ordinary source", note: longNote, pageNumber: 2 },
      { sourceText: "COMMON term in the passage", note: null, pageNumber: 3 },
      { sourceText: "Another common TERM result", note: "unrelated" , pageNumber: 4 },
      { sourceText: "COMMON term in a third passage", note: null, pageNumber: 5 },
      { sourceText: "Literal token 50%_\\Path 'quoted'", note: null, pageNumber: 6 },
      { sourceText: "CAFÉ 🙂 in Unicode text", note: null, pageNumber: 7 },
      { sourceText: `Replacement marker ${"\uFFFD".repeat(3)} is literal searchable text`, note: null, pageNumber: 8 },
    ];
    const evidenceIds: string[] = [];
    for (const draft of drafts) {
      const [row] = await appClient!<{ id: string }[]>`insert into evidence
        (project_id,paper_id,source_text,note,page_number,created_at,updated_at)
        values (${project.id}::uuid,${paper.id}::uuid,${draft.sourceText},${draft.note},${draft.pageNumber},'2026-10-06T12:00:00.123456Z'::timestamptz,'2026-10-06T12:00:00.123456Z'::timestamptz)
        returning id::text as id`;
      evidenceIds.push(row.id);
    }
    const otherPaperEvidence = await services!.recordEvidence(project.id, {
      paperId: otherPaper.id, sourceText: "COMMON term in another Paper", pageNumber: 1,
    });

    queryLog.length = 0;
    const firstCommonPage = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, {
      pageSize: 1, query: "  COMMON term  ",
    });
    expect(firstCommonPage.items).toHaveLength(1);
    expect(firstCommonPage.hasNext).toBe(true);
    expect(firstCommonPage.nextCursor).toBeTruthy();
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(3);
    await expect(candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, {
      pageSize: 1, query: "common TERM", after: firstCommonPage.nextCursor,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { input: "pagination" } });

    const traversed: string[] = [];
    let after: string | null = null;
    do {
      const result = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, {
        pageSize: 1, query: "COMMON term", after,
      });
      traversed.push(...result.items.map((item) => item.id));
      after = result.nextCursor;
    } while (after);
    const oracle = await appClient!<{ id: string }[]>`select e.id::text as id
      from evidence e where e.project_id=${project.id}::uuid and e.paper_id=${paper.id}::uuid
        and (position(lower('common term') in lower(e.source_text)) > 0
          or position(lower('common term') in lower(e.note)) > 0)
      order by e.created_at desc,e.id asc`;
    expect(traversed).toEqual(oracle.map((row) => row.id));
    expect(new Set(traversed).size).toBe(traversed.length);
    expect(traversed).not.toContain(otherPaperEvidence.id);

    const passageHit = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "rare-tail-ω" });
    expect(passageHit.items).toHaveLength(1);
    expect(passageHit.items[0]).toMatchObject({ sourceTextTruncated: true, notePreview: null });
    expect(passageHit.items[0]!.sourceTextPreview).not.toContain("RARE-TAIL-Ω");

    const noteHit = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "note-tail-needle" });
    expect(noteHit.items).toHaveLength(1);
    expect(noteHit.items[0]).toMatchObject({ sourceTextPreview: "Ordinary source", noteTruncated: true });
    expect(noteHit.items[0]!.notePreview).not.toContain("NOTE-TAIL-NEEDLE");

    expect((await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "50%_\\path 'quoted'" })).items.map((item) => item.id))
      .toEqual([evidenceIds[5]]);
    expect((await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "café 🙂" })).items.map((item) => item.id))
      .toEqual([evidenceIds[6]]);

    queryLog.length = 0;
    const noMatches = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "no-such-evidence-term" });
    expect(noMatches).toMatchObject({ items: [], hasNext: false, nextCursor: null });
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);

    const emptyQuery = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "   " });
    const omittedQuery = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id);
    expect(emptyQuery.items.map((item) => item.id)).toEqual(omittedQuery.items.map((item) => item.id));
    const replacementQuery = "\uFFFD".repeat(3);
    const replacementHit = await candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: replacementQuery });
    expect(replacementHit.items.map((item) => item.id)).toEqual([evidenceIds[7]]);
    await expect(candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, {
      query: replacementQuery, after: "bad-cursor",
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { input: "pagination" } });
    queryLog.length = 0;
    await expect(candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: "bad\0query", after: "bad-cursor" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { input: "query" } });
    expect(queryLog).toHaveLength(0);
    await expect(candidateReads!.getPaperExtractionEvidenceCandidatePage(project.id, paper.id, { query: null }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { input: "query" } });
    expect(queryLog).toHaveLength(0);

    const selectedOutsideSearch = await candidateReads!.getPaperExtractionEvidenceSupportMetadata(project.id, paper.id, [evidenceIds[0]!]);
    expect(selectedOutsideSearch.map((item) => item.id)).toEqual([evidenceIds[0]]);
  });
});
