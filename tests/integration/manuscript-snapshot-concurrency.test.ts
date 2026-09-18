import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createManuscriptSnapshotServices } from "@/application/manuscript-snapshot-services";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice25_concurrency_${Date.now()}_${randomUUID().slice(0, 8)}`;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

function gate() {
  let release!: () => void;
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const open = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, wait: async () => { signal(); await open; } };
}

describe("Slice 25 Repeatable Read capture boundary", () => {
  let admin: postgres.Sql | undefined;
  let concurrentClient: postgres.Sql | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let services: ReturnType<typeof createReviewServices>;

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    db = createDb(databaseUrl(databaseName));
    await migrate(db.db, { migrationsFolder: migrationFolder });
    services = createReviewServices(db.db);
    concurrentClient = postgres(databaseUrl(databaseName), { max: 1 });
  });

  afterAll(async () => {
    if (db) await db.client.end();
    if (concurrentClient) await concurrentClient.end();
    if (admin) {
      await admin.unsafe(`drop database if exists "${databaseName}"`);
      await admin.end();
    }
  });

  async function captureAfterBoundary(projectId: string, manuscriptId: string, mutate: () => Promise<void>) {
    const boundary = gate();
    let attempts = 0;
    const snapshots = createManuscriptSnapshotServices(db!.db, async (executor, ownerProjectId, ownerManuscriptId) => {
      attempts += 1;
      if (attempts === 1) await boundary.wait();
      return services.loadManuscriptProjection(executor, ownerProjectId, ownerManuscriptId);
    });
    const capture = snapshots.createManuscriptSnapshot(projectId, manuscriptId);
    await boundary.reached;
    await mutate();
    boundary.release();
    return { snapshots, result: await capture, attempts };
  }

  async function captureBeforeMutation(projectId: string, manuscriptId: string, mutate: () => Promise<void>) {
    const snapshots = createManuscriptSnapshotServices(db!.db, (executor, ownerProjectId, ownerManuscriptId) => services.loadManuscriptProjection(executor, ownerProjectId, ownerManuscriptId));
    await mutate();
    const result = await snapshots.createManuscriptSnapshot(projectId, manuscriptId);
    return { snapshots, result };
  }

  it("excludes a Prose revision and newly created Section/SectionItem committed after the boundary", async () => {
    const project = await services.createProject({ title: `RR prose race ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Existing" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Before boundary");
    const { snapshots, result, attempts } = await captureAfterBoundary(project.id, manuscript.id, async () => {
      await services.reviseProseBlock(project.id, manuscript.id, prose.id, { text: "After boundary", expectedCurrentRevisionId: prose.currentRevisionId });
      const newSection = await services.createSection(project.id, manuscript.id, { title: "Created after boundary" });
      await services.createProseBlock(project.id, manuscript.id, newSection.id, "New item after boundary");
    });
    const snapshot = await snapshots.getManuscriptSnapshot(project.id, manuscript.id, result.id);
    if (attempts === 1) {
      expect(snapshot.sections.map((sectionRow) => sectionRow.title)).toEqual(["Existing"]);
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].prose_text).toBe("Before boundary");
      expect(snapshot.items[0].prose_revision_id).toBe(prose.currentRevisionId);
    } else {
      expect(snapshot.sections.map((sectionRow) => sectionRow.title)).toEqual(["Existing", "Created after boundary"]);
      expect(snapshot.items[0].prose_text).toBe("After boundary");
    }
  });

  it("keeps pre-boundary Section order/title and citation style when all mutate afterward", async () => {
    const project = await services.createProject({ title: `RR section race ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const first = await services.createSection(project.id, manuscript.id, { title: "First" });
    const second = await services.createSection(project.id, manuscript.id, { title: "Second" });
    const { snapshots, result, attempts } = await captureAfterBoundary(project.id, manuscript.id, async () => {
      await services.renameSection(project.id, manuscript.id, first.id, "Renamed after boundary");
      await services.reorderSections(project.id, manuscript.id, [second.id, first.id]);
      await services.setManuscriptCitationStyle(project.id, manuscript.id, "author_year");
    });
    const snapshot = await snapshots.getManuscriptSnapshot(project.id, manuscript.id, result.id);
    if (attempts === 1) {
      expect(snapshot.sections.map((sectionRow) => sectionRow.title)).toEqual(["First", "Second"]);
      expect(snapshot.citationStyle).toBe("numeric");
    } else {
      expect(snapshot.sections.map((sectionRow) => sectionRow.title)).toEqual(["Second", "Renamed after boundary"]);
      expect(snapshot.citationStyle).toBe("author_year");
    }
  });

  it("does not observe a mixed state from one atomic multi-fact manuscript mutation", async () => {
    const project = await services.createProject({ title: `RR atomic race ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const first = await services.createSection(project.id, manuscript.id, { title: "Atomic first" });
    const second = await services.createSection(project.id, manuscript.id, { title: "Atomic second" });
    const { snapshots, result, attempts } = await captureAfterBoundary(project.id, manuscript.id, async () => {
      await db!.client.begin(async (tx) => {
        await tx`update manuscript_sections set title = case when id = ${first.id} then 'Atomic first after' when id = ${second.id} then 'Atomic second after' else title end, sort_order = case when id = ${first.id} then 1 when id = ${second.id} then 0 else sort_order end where project_id = ${project.id} and manuscript_id = ${manuscript.id}`;
        await tx`update manuscripts set citation_style = 'author_year', updated_at = now() where project_id = ${project.id} and id = ${manuscript.id}`;
      });
    });
    const snapshot = await snapshots.getManuscriptSnapshot(project.id, manuscript.id, result.id);
    if (attempts === 1) {
      expect(snapshot.sections.map((sectionRow) => sectionRow.title)).toEqual(["Atomic first", "Atomic second"]);
      expect(snapshot.citationStyle).toBe("numeric");
    } else {
      expect(snapshot.sections.map((sectionRow) => sectionRow.title)).toEqual(["Atomic second after", "Atomic first after"]);
      expect(snapshot.citationStyle).toBe("author_year");
    }
  });

  it("keeps the old Claim placement/revision and Paper metadata while replacement, removal, and correction commit afterward", async () => {
    const project = await services.createProject({ title: `RR claim race ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Claims" });
    const paper = await services.addPaper(project.id, { title: "Paper before", authors: ["Author Before"], publicationYear: 2020, venue: "Venue Before", doi: "10.5555/before" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(project.id, { paperId: paper.id, sourceText: "Claim source", pageNumber: 1 });
    const claim = await services.createClaim(project.id, { claimText: "Claim before" });
    const revision = await services.createClaimRevision(project.id, claim.id, { claimText: "Claim before", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id });
    const placement = await services.placeClaimRevision(project.id, manuscript.id, section.id, revision.revision.id);
    const replacement = await services.createClaimRevision(project.id, claim.id, { claimText: "Claim replacement", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: revision.revision.id });
    const { snapshots, result, attempts } = await captureAfterBoundary(project.id, manuscript.id, async () => {
      await services.replacePlacedClaimRevision(project.id, manuscript.id, placement.id, replacement.revision.id, revision.revision.id);
      await services.removeClaimPlacement(project.id, manuscript.id, placement.id);
      await db!.client.unsafe("update papers set title=$1, authors=$2, publication_year=$3, venue=$4, doi=$5, updated_at=now() where project_id=$6 and id=$7", ["Paper after", ["Author After"], 2024, "Venue After", "10.5555/after", project.id, paper.id]);
    });
    const snapshot = await snapshots.getManuscriptSnapshot(project.id, manuscript.id, result.id);
    if (attempts === 1) {
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].claim_revision_id).toBe(revision.revision.id);
      expect(snapshot.items[0].claim_text).toBe("Claim before");
      expect(snapshot.bibliography[0].title).toBe("Paper before");
    } else {
      expect(snapshot.items).toHaveLength(0);
      expect(snapshot.bibliography).toHaveLength(0);
    }
  });

  it("freezes SectionItem reorder on the Repeatable Read side of the boundary", async () => {
    const project = await services.createProject({ title: `RR item reorder ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Items" });
    const first = await services.createProseBlock(project.id, manuscript.id, section.id, "First");
    const second = await services.createProseBlock(project.id, manuscript.id, section.id, "Second");
    const reorderOnSecondConnection = (ordered: string[]) => concurrentClient!.begin(async (tx) => {
      await tx`select id from manuscript_sections where project_id=${project.id} and manuscript_id=${manuscript.id} and id=${section.id} for update`;
      for (const [position, itemId] of ordered.entries()) await tx`update manuscript_section_items set sort_order=${position} where project_id=${project.id} and manuscript_id=${manuscript.id} and section_id=${section.id} and id=${itemId} and removed_at is null`;
    }).then(() => undefined);
    const after = await captureAfterBoundary(project.id, manuscript.id, () => reorderOnSecondConnection([second.id, first.id]));
    expect(after.attempts).toBe(1);
    const oldSnapshot = await after.snapshots.getManuscriptSnapshot(project.id, manuscript.id, after.result.id);
    expect(oldSnapshot.items.map((item) => String(item.source_section_item_id))).toEqual([first.id, second.id]);

    const before = await captureBeforeMutation(project.id, manuscript.id, () => reorderOnSecondConnection([first.id, second.id]));
    const newSnapshot = await before.snapshots.getManuscriptSnapshot(project.id, manuscript.id, before.result.id);
    expect(newSnapshot.items.map((item) => String(item.source_section_item_id))).toEqual([first.id, second.id]);
  });

  it("captures legal empty Section archive on the correct side of the boundary", async () => {
    const project = await services.createProject({ title: `RR archive ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const populated = await services.createSection(project.id, manuscript.id, { title: "Populated" });
    await services.createProseBlock(project.id, manuscript.id, populated.id, "Cannot archive while active");
    const empty = await services.createSection(project.id, manuscript.id, { title: "Empty" });
    await expect(services.archiveSection(project.id, manuscript.id, populated.id)).rejects.toThrow(/active items|PROTECTED_DELETE/i);
    const after = await captureAfterBoundary(project.id, manuscript.id, () => services.archiveSection(project.id, manuscript.id, empty.id).then(() => undefined));
    const old = await after.snapshots.getManuscriptSnapshot(project.id, manuscript.id, after.result.id);
    expect(old.sections.map((section) => section.title)).toEqual(after.attempts === 1 ? ["Populated", "Empty"] : ["Populated"]);

    const secondEmpty = await services.createSection(project.id, manuscript.id, { title: "Second empty" });
    const before = await captureBeforeMutation(project.id, manuscript.id, () => services.archiveSection(project.id, manuscript.id, secondEmpty.id).then(() => undefined));
    const current = await before.snapshots.getManuscriptSnapshot(project.id, manuscript.id, before.result.id);
    expect(current.sections.map((section) => section.title)).toEqual(["Populated"]);
  });

  it("keeps exact Claim placement identity while supersession and withdrawal annotations cross the boundary", async () => {
    const project = await services.createProject({ title: `RR claim lifecycle ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Claims" });
    const claim = await services.createClaim(project.id, { claimText: "Lifecycle claim" });
    const initial = await services.createClaimRevision(project.id, claim.id, { claimText: "Lifecycle claim", lifecycle: "active", supports: [], expectedCurrentRevisionId: claim.revision.id });
    const placement = await services.placeClaimRevision(project.id, manuscript.id, section.id, initial.revision.id);
    let supersedingId = "";
    const afterSupersession = await captureAfterBoundary(project.id, manuscript.id, async () => {
      const superseding = await services.createClaimRevision(project.id, claim.id, { claimText: "Superseding claim", lifecycle: "active", supports: [], expectedCurrentRevisionId: initial.revision.id });
      supersedingId = superseding.revision.id;
    });
    const oldSupersession = await afterSupersession.snapshots.getManuscriptSnapshot(project.id, manuscript.id, afterSupersession.result.id);
    expect(oldSupersession.items[0].claim_revision_id).toBe(initial.revision.id);
    expect(oldSupersession.items[0].claim_text).toBe("Lifecycle claim");
    expect(oldSupersession.items[0].capture_is_current_claim_revision).toBe(true);
    expect(oldSupersession.items[0].capture_is_superseded).toBe(false);
    expect(supersedingId).not.toBe(placement.id);

    const beforeSupersession = await captureBeforeMutation(project.id, manuscript.id, async () => {
      const next = await services.createClaimRevision(project.id, claim.id, { claimText: "Superseding again", lifecycle: "active", supports: [], expectedCurrentRevisionId: supersedingId });
      expect(next.revision.id).not.toBe(initial.revision.id);
    });
    const superseded = await beforeSupersession.snapshots.getManuscriptSnapshot(project.id, manuscript.id, beforeSupersession.result.id);
    expect(superseded.items[0].claim_revision_id).toBe(initial.revision.id);
    expect(superseded.items[0].claim_text).toBe("Lifecycle claim");
    expect(superseded.items[0].capture_is_superseded).toBe(true);

    const withdrawalProject = await services.createProject({ title: `RR claim withdrawal ${randomUUID()}` });
    const withdrawalManuscript = await services.getOrCreateDefaultManuscript(withdrawalProject.id);
    const withdrawalSection = await services.createSection(withdrawalProject.id, withdrawalManuscript.id, { title: "Claims" });
    const withdrawalClaim = await services.createClaim(withdrawalProject.id, { claimText: "Withdrawn parent" });
    const withdrawalInitial = await services.createClaimRevision(withdrawalProject.id, withdrawalClaim.id, { claimText: "Withdrawn parent", lifecycle: "active", supports: [], expectedCurrentRevisionId: withdrawalClaim.revision.id });
    await services.placeClaimRevision(withdrawalProject.id, withdrawalManuscript.id, withdrawalSection.id, withdrawalInitial.revision.id);
    const afterWithdrawal = await captureAfterBoundary(withdrawalProject.id, withdrawalManuscript.id, () => services.withdrawClaim(withdrawalProject.id, withdrawalClaim.id).then(() => undefined));
    expect(afterWithdrawal.attempts).toBe(1);
    const oldWithdrawal = await afterWithdrawal.snapshots.getManuscriptSnapshot(withdrawalProject.id, withdrawalManuscript.id, afterWithdrawal.result.id);
    expect(oldWithdrawal.items[0].claim_revision_id).toBe(withdrawalInitial.revision.id);
    expect(oldWithdrawal.items[0].capture_claim_lifecycle).toBe("active");
    const beforeWithdrawal = await captureBeforeMutation(withdrawalProject.id, withdrawalManuscript.id, () => services.withdrawClaim(withdrawalProject.id, withdrawalClaim.id).then(() => undefined));
    const withdrawn = await beforeWithdrawal.snapshots.getManuscriptSnapshot(withdrawalProject.id, withdrawalManuscript.id, beforeWithdrawal.result.id);
    expect(withdrawn.items[0].claim_revision_id).toBe(withdrawalInitial.revision.id);
    expect(withdrawn.items[0].claim_text).toBe("Withdrawn parent");
    expect(withdrawn.items[0].capture_claim_lifecycle).toBe("withdrawn");
    expect(withdrawn.warnings.some((warning) => warning.code === "withdrawn_parent_claim")).toBe(true);
  });

  it("captures an independently created SectionItem only when creation precedes the boundary", async () => {
    const project = await services.createProject({ title: `RR item creation ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Existing" });
    const first = await services.createProseBlock(project.id, manuscript.id, section.id, "First");
    let createdId = "";
    const after = await captureAfterBoundary(project.id, manuscript.id, async () => {
      createdId = (await services.createProseBlock(project.id, manuscript.id, section.id, "After boundary")).id;
    });
    expect(after.attempts).toBe(1);
    const old = await after.snapshots.getManuscriptSnapshot(project.id, manuscript.id, after.result.id);
    expect(old.items.map((item) => String(item.source_section_item_id))).toEqual([first.id]);
    const before = await captureBeforeMutation(project.id, manuscript.id, async () => {
      createdId = (await services.createProseBlock(project.id, manuscript.id, section.id, "Before boundary")).id;
    });
    const current = await before.snapshots.getManuscriptSnapshot(project.id, manuscript.id, before.result.id);
    expect(current.items.map((item) => String(item.source_section_item_id))).toContain(createdId);
    expect(current.items.map((item) => Number(item.item_position))).toEqual([0, 1, 2]);
  });
});
