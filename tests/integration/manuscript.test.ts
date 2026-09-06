/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { manuscriptClaimPlacements } from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db) as any;
let projectId = "";

/**
 * Slice 6 integration contract.  The small `call` wrapper intentionally keeps
 * this test file typecheckable while the service surface is being introduced;
 * it still fails loudly when an expected public operation is absent.
 */
async function call(name: string, ...args: unknown[]) {
  const operation = services[name];
  expect(typeof operation, `${name} must be exposed by createReviewServices`).toBe("function");
  return operation.apply(services, args);
}

describe("Slice 7 manuscript workspace", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Manuscript project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, evidence, claims, papers, projects");
    await client.end();
  });

  async function includedPaper(ownerProjectId: string, title: string, details: Record<string, unknown> = {}) {
    const paper = await services.addPaper(ownerProjectId, { title, authors: ["Author"], ...details });
    await services.recordScreeningDecision(ownerProjectId, paper.id, { decision: "include" });
    return paper;
  }

  async function claimWithDirectEvidence(ownerProjectId: string, paper: { id: string }, text: string) {
    const evidence = await services.recordEvidence(ownerProjectId, { paperId: paper.id, sourceText: `Source for ${text}`, pageNumber: 1 });
    const claim = await services.createClaim(ownerProjectId, { claimText: text });
    const revision = await services.createClaimRevision(ownerProjectId, claim.id, {
      claimText: text,
      lifecycle: "active",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: claim.revision.id,
    });
    return { claim, revision: revision.revision, evidence };
  }

  function sectionsOf(view: any): any[] { return view?.sections ?? view?.manuscript?.sections ?? []; }
  function placementsOf(view: any): any[] { return sectionsOf(view).flatMap((section) => (section.items ?? []).filter((item: any) => (item.itemType ?? item.type) === "claim").map((item: any) => { const placement = item.placement ?? item.claimPlacement ?? item.claim ?? item; return { ...placement, citationNumbers: item.citationNumbers ?? placement.citationNumbers, citationPaperIds: item.citationPaperIds ?? placement.citationPaperIds }; })); }
  function itemsOf(view: any): any[] { return sectionsOf(view).flatMap((section) => section.items ?? []); }
  function bibliographyOf(view: any): any[] { return view?.bibliographyCandidates ?? view?.bibliography ?? view?.manuscript?.bibliographyCandidates ?? []; }
  function warningsOf(view: any): any[] { return view?.warnings ?? view?.manuscript?.warnings ?? []; }

  it("lazily creates one default Manuscript, including under concurrent first access", async () => {
    const [first, second, third] = await Promise.all([
      call("getOrCreateDefaultManuscript", projectId),
      call("getOrCreateDefaultManuscript", projectId),
      call("getOrCreateDefaultManuscript", projectId),
    ]);
    expect(new Set([first.id, second.id, third.id]).size).toBe(1);
    expect(first.projectId).toBe(projectId);
    expect(first.citationStyle).toBe("numeric");

    const rows = await client.unsafe("select id, project_id, is_default from manuscripts where project_id = $1", [projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_default).toBe(true);
  });

  it("creates, renames, orders, and archives sections while preserving active placement restrictions", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const first = await call("createSection", projectId, manuscript.id, { title: "Introduction", sectionType: "introduction" });
    const second = await call("createSection", projectId, manuscript.id, { title: "Results", sectionType: "results" });
    await call("renameSection", projectId, manuscript.id, first.id, "Background");
    await call("reorderSections", projectId, manuscript.id, [second.id, first.id]);

    let view = await call("getManuscript", projectId, manuscript.id);
    expect(sectionsOf(view).map((section) => section.id)).toEqual([second.id, first.id]);
    expect(sectionsOf(view).find((section) => section.id === first.id).title).toBe("Background");

    const paper = await includedPaper(projectId, "Archive guard");
    const claim = await claimWithDirectEvidence(projectId, paper, "Cannot archive active section");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, first.id, claim.revision.id);
    await expect(call("archiveSection", projectId, manuscript.id, first.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await call("removeClaimPlacement", projectId, manuscript.id, placement.id);
    await call("archiveSection", projectId, manuscript.id, first.id);
    view = await call("getManuscript", projectId, manuscript.id);
    expect(sectionsOf(view).some((section) => section.id === first.id)).toBe(false);
  });

  it("places exact ClaimRevisions, permits intentional cross-section reuse, and rejects cross-project references", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const one = await call("createSection", projectId, manuscript.id, { title: "One" });
    const two = await call("createSection", projectId, manuscript.id, { title: "Two" });
    const paper = await includedPaper(projectId, "Exact placement source");
    const claim = await claimWithDirectEvidence(projectId, paper, "An exact historical assertion");
    const first = await call("placeClaimRevision", projectId, manuscript.id, one.id, claim.revision.id);
    const second = await call("placeClaimRevision", projectId, manuscript.id, two.id, claim.revision.id);
    expect(first.claimRevisionId).toBe(claim.revision.id);
    expect(second.claimRevisionId).toBe(claim.revision.id);
    await expect(call("placeClaimRevision", projectId, manuscript.id, one.id, claim.revision.id)).rejects.toMatchObject({ code: "DUPLICATE_LINK" });

    const otherProject = (await services.createProject({ title: "Foreign manuscript project" })).id;
    const foreignPaper = await includedPaper(otherProject, "Foreign source");
    const foreignClaim = await claimWithDirectEvidence(otherProject, foreignPaper, "Foreign assertion");
    await expect(call("placeClaimRevision", projectId, manuscript.id, one.id, foreignClaim.revision.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });

  it("allows unsupported active Claims with visible warnings, but rejects draft/withdrawn placement targets", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Drafting" });
    const unsupported = await services.createClaim(projectId, { claimText: "Not grounded yet" });
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, unsupported.revision.id);
    const view = await call("getManuscript", projectId, manuscript.id);
    const placed = placementsOf(view).find((item) => item.id === placement.id);
    expect(placed.claimRevisionId).toBe(unsupported.revision.id);
    expect(placed.supportStatus).toBe("unsupported");
    expect(warningsOf(view).some((warning) => String(warning.code ?? warning.kind ?? warning).toLowerCase().includes("unsupported"))).toBe(true);
    expect(placed.citationCandidates ?? []).toHaveLength(0);

    const draftRows = await client.unsafe("insert into claim_revisions (project_id, claim_id, state, claim_text) values ($1, $2, 'active', 'draft') returning id", [projectId, unsupported.id]);
    await expect(call("placeClaimRevision", projectId, manuscript.id, section.id, draftRows[0].id)).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION_ERROR|INELIGIBLE_REFERENCE/) });

    const withdrawn = await services.withdrawClaim(projectId, unsupported.id, { expectedCurrentRevisionId: unsupported.revision.id });
    await expect(call("placeClaimRevision", projectId, manuscript.id, section.id, withdrawn.revision.id)).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION_ERROR|INELIGIBLE_REFERENCE/) });
  });

  it("keeps an exact placement historical after Claim revision and requires monotonic explicit replacement", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Results" });
    const paper = await includedPaper(projectId, "Revision source");
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "The original result", pageNumber: 2 });
    const claim = await services.createClaim(projectId, { claimText: "Original wording" });
    const revisionTwo = await services.createClaimRevision(projectId, claim.id, { claimText: "Original wording", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id });
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, revisionTwo.revision.id);
    const revisionThree = await services.createClaimRevision(projectId, claim.id, { claimText: "Updated wording", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: revisionTwo.revision.id });

    let view = await call("getManuscript", projectId, manuscript.id);
    let placed = placementsOf(view).find((item) => item.id === placement.id);
    expect(placed.claimRevisionId).toBe(revisionTwo.revision.id);
    expect(placed.claimRevision?.claimText ?? placed.claimRevision?.text).toBe("Original wording");
    expect(placed.isCurrentClaimRevision).toBe(false);
    expect(placed.isSuperseded).toBe(true);

    const replaced = await call("replacePlacedClaimRevision", projectId, manuscript.id, placement.id, revisionThree.revision.id, revisionTwo.revision.id);
    expect(replaced.claimRevisionId).toBe(revisionThree.revision.id);
    await expect(call("replacePlacedClaimRevision", projectId, manuscript.id, placement.id, revisionTwo.revision.id, revisionThree.revision.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const history = await call("getManuscriptPlacementHistory", projectId, manuscript.id, placement.id);
    expect(history.map((event: any) => event.eventType ?? event.event_type ?? event.type)).toEqual(["placed", "replaced"]);
    expect((history[1].fromClaimRevisionId ?? history[1].from_claim_revision_id ?? history[1].fromRevisionId)).toBe(revisionTwo.revision.id);
    expect((history[1].toClaimRevisionId ?? history[1].to_claim_revision_id ?? history[1].toRevisionId)).toBe(revisionThree.revision.id);

    view = await call("getManuscript", projectId, manuscript.id);
    placed = placementsOf(view).find((item) => item.id === placement.id);
    expect(placed.claimRevisionId).toBe(revisionThree.revision.id);
  });

  it("soft-removes placements one way, preserves history, and excludes them from active composition", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Removals" });
    const paper = await includedPaper(projectId, "Removal source");
    const claim = await claimWithDirectEvidence(projectId, paper, "A removable assertion");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, claim.revision.id);
    await call("removeClaimPlacement", projectId, manuscript.id, placement.id);
    const view = await call("getManuscript", projectId, manuscript.id);
    expect(placementsOf(view).some((item) => item.id === placement.id)).toBe(false);
    const historicalRows = await client.unsafe("select removed_at from manuscript_claim_placements where id = $1", [placement.id]);
    expect(historicalRows[0].removed_at).not.toBeNull();
    await expect(call("replacePlacedClaimRevision", projectId, manuscript.id, placement.id, claim.revision.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(call("reorderSectionItems", projectId, manuscript.id, section.id, [placement.id])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const history = await call("getManuscriptPlacementHistory", projectId, manuscript.id, placement.id);
    expect(history.map((event: any) => event.eventType ?? event.event_type ?? event.type)).toEqual(["placed", "removed"]);
  });

  it("enforces placement identity and one-way removal in PostgreSQL", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Database guards" });
    const paper = await includedPaper(projectId, "Database guard source");
    const claim = await claimWithDirectEvidence(projectId, paper, "Guarded assertion");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, claim.revision.id);
    const otherProject = await services.createProject({ title: "Immutable identity target" });
    const before = await db.select().from(manuscriptClaimPlacements).where(and(eq(manuscriptClaimPlacements.projectId, projectId), eq(manuscriptClaimPlacements.id, placement.id)));

    await expect(db.update(manuscriptClaimPlacements).set({ projectId: otherProject.id }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    await expect(db.update(manuscriptClaimPlacements).set({ manuscriptId: otherProject.id }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    await expect(db.update(manuscriptClaimPlacements).set({ sectionId: otherProject.id }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    await expect(db.update(manuscriptClaimPlacements).set({ claimId: otherProject.id }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    await expect(db.update(manuscriptClaimPlacements).set({ claimRevisionId: otherProject.id }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    await expect(db.update(manuscriptClaimPlacements).set({ createdAt: new Date(0) }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    await call("removeClaimPlacement", projectId, manuscript.id, placement.id);
    await expect(db.update(manuscriptClaimPlacements).set({ removedAt: null }).where(eq(manuscriptClaimPlacements.id, placement.id))).rejects.toThrow();
    expect(before[0].claimRevisionId).toBe(claim.revision.id);
  });

  it("derives deterministic first-appearance citation numbers and deduplicates bibliography by Paper ID", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const firstSection = await call("createSection", projectId, manuscript.id, { title: "Introduction" });
    const secondSection = await call("createSection", projectId, manuscript.id, { title: "Discussion" });
    const paperX = await includedPaper(projectId, "Paper X", { publicationYear: 2022, venue: "Venue X" });
    const paperY = await includedPaper(projectId, "Paper Y", { publicationYear: 2021, venue: "Venue Y", doi: "10.1/shared" });
    const paperZ = await includedPaper(projectId, "Paper Z", { publicationYear: 2020, venue: "Venue Z" });
    const claimA = await claimWithDirectEvidence(projectId, paperX, "Claim A");
    const evidenceY = await services.recordEvidence(projectId, { paperId: paperY.id, sourceText: "Shared passage", pageNumber: 3 });
    const claimB = await services.createClaim(projectId, { claimText: "Claim B" });
    const revisionB = await services.createClaimRevision(projectId, claimB.id, { claimText: "Claim B", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidenceY.id }], expectedCurrentRevisionId: claimB.revision.id });
    const evidenceZ = await services.recordEvidence(projectId, { paperId: paperZ.id, sourceText: "Final passage", pageNumber: 4 });
    const claimC = await services.createClaim(projectId, { claimText: "Claim C" });
    const revisionC = await services.createClaimRevision(projectId, claimC.id, { claimText: "Claim C", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidenceY.id }, { kind: "evidence", evidenceId: evidenceZ.id }], expectedCurrentRevisionId: claimC.revision.id });
    await call("placeClaimRevision", projectId, manuscript.id, firstSection.id, claimA.revision.id);
    await call("placeClaimRevision", projectId, manuscript.id, firstSection.id, revisionB.revision.id);
    await call("placeClaimRevision", projectId, manuscript.id, secondSection.id, revisionC.revision.id);

    const view = await call("getManuscript", projectId, manuscript.id);
    const bibliography = bibliographyOf(view);
    expect(bibliography.map((candidate) => candidate.paper?.id ?? candidate.paperId)).toEqual([paperX.id, paperY.id, paperZ.id]);
    expect(new Set(bibliography.map((candidate) => candidate.paper?.id ?? candidate.paperId)).size).toBe(3);
    expect(bibliography.map((candidate) => candidate.citationNumber ?? candidate.number)).toEqual([1, 2, 3]);
    const placements = placementsOf(view);
    expect(placements[1].citationNumbers ?? placements[1].citationCandidateNumbers).toEqual([2]);
    expect(placements[2].citationNumbers ?? placements[2].citationCandidateNumbers).toEqual([2, 3]);

    await call("reorderSections", projectId, manuscript.id, [secondSection.id, firstSection.id]);
    const reordered = await call("getManuscript", projectId, manuscript.id);
    expect(bibliographyOf(reordered).map((candidate) => candidate.paper?.id ?? candidate.paperId)).toEqual([paperY.id, paperZ.id, paperX.id]);
  });

  it("keeps withdrawn parents and superseded revisions as readable warnings, without mutating upstream records", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Lifecycle" });
    const paper = await includedPaper(projectId, "Lifecycle source");
    const claim = await claimWithDirectEvidence(projectId, paper, "Historical assertion");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, claim.revision.id);
    const claimBefore = await services.getClaimRevision(projectId, claim.claim.id, claim.revision.id);
    await services.withdrawClaim(projectId, claim.claim.id, { expectedCurrentRevisionId: claim.revision.id, researcherNote: "No longer relied on for new writing" });
    const view = await call("getManuscript", projectId, manuscript.id);
    const placed = placementsOf(view).find((item) => item.id === placement.id);
    expect(placed.claimRevisionId).toBe(claim.revision.id);
    expect(placed.claimRevision?.claimText ?? placed.claimText).toBe("Historical assertion");
    expect(placed.currentClaimLifecycle ?? placed.claimLifecycle).toBe("withdrawn");
    expect(warningsOf(view).some((warning) => String(warning.code ?? warning.kind ?? warning).toLowerCase().includes("withdraw"))).toBe(true);
    const claimAfter = await services.getClaimRevision(projectId, claim.claim.id, claim.revision.id);
    expect(claimAfter.revision).toEqual(claimBefore.revision);
    const history = await call("getManuscriptPlacementHistory", projectId, manuscript.id, placement.id);
    expect(history).toHaveLength(1);
  });

  it("composes mutable plain-text prose with exact Claim items and reorders them together", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Mixed composition" });
    const paper = await includedPaper(projectId, "Mixed source");
    const claim = await claimWithDirectEvidence(projectId, paper, "A claim between prose blocks");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, claim.revision.id);
    const before = "  Opening paragraph.\n\n  With intentional spacing.  ";
    const prose = await call("createProseBlock", projectId, manuscript.id, section.id, { text: before, position: 0 });
    const after = await call("createProseBlock", projectId, manuscript.id, section.id, { text: "Closing paragraph.", position: 2 });

    let view = await call("getManuscript", projectId, manuscript.id);
    let items = itemsOf(view).filter((item) => item.sectionId === section.id);
    expect(items.map((item) => item.itemType ?? item.type)).toEqual(["prose", "claim", "prose"]);
    expect(items[0].text ?? items[0].proseBlock?.text).toBe(before);
    const claimItem = items.find((item) => (item.itemType ?? item.type) === "claim");
    expect((claimItem.placement ?? claimItem.claimPlacement).id).toBe(placement.id);
    expect((claimItem.placement ?? claimItem.claimPlacement).claimRevisionId).toBe(claim.revision.id);
    expect((claimItem.placement ?? claimItem.claimPlacement).citationNumbers).toEqual([1]);

    await call("updateProseBlock", projectId, manuscript.id, prose.id ?? prose.sectionItemId, { text: "  Edited opening.\nStill plain text.  " });
    await call("reorderSectionItems", projectId, manuscript.id, section.id, [placement.id, after.id ?? after.sectionItemId, prose.id ?? prose.sectionItemId]);
    view = await call("getManuscript", projectId, manuscript.id);
    items = itemsOf(view).filter((item) => item.sectionId === section.id);
    expect(items.map((item) => item.itemType ?? item.type)).toEqual(["claim", "prose", "prose"]);
    expect((items[0].placement ?? items[0].claimPlacement).claimRevisionId).toBe(claim.revision.id);
    expect(items[2].text ?? items[2].proseBlock?.text).toContain("Edited opening");
    expect(bibliographyOf(view).map((candidate) => candidate.paper?.id ?? candidate.paperId)).toEqual([paper.id]);
  });

  it("removes prose independently and removes Claim placement/item markers atomically", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Removal parity" });
    const paper = await includedPaper(projectId, "Parity source");
    const claim = await claimWithDirectEvidence(projectId, paper, "A parity assertion");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, claim.revision.id);
    const prose = await call("createProseBlock", projectId, manuscript.id, section.id, { text: "Temporary prose" });
    await call("removeProseBlock", projectId, manuscript.id, prose.id ?? prose.sectionItemId);
    let view = await call("getManuscript", projectId, manuscript.id);
    expect(itemsOf(view).some((item) => item.id === (prose.id ?? prose.sectionItemId))).toBe(false);

    await call("removeClaimPlacement", projectId, manuscript.id, placement.id);
    view = await call("getManuscript", projectId, manuscript.id);
    expect(itemsOf(view).some((item) => item.id === placement.id)).toBe(false);
    const rows = await client.unsafe("select p.removed_at as placement_removed_at, i.removed_at as item_removed_at from manuscript_claim_placements p join manuscript_section_items i on i.id=p.id where p.id=$1", [placement.id]);
    expect(rows[0].placement_removed_at).not.toBeNull();
    expect(rows[0].item_removed_at).not.toBeNull();
    expect(new Date(rows[0].placement_removed_at).getTime()).toBe(new Date(rows[0].item_removed_at).getTime());
    const history = await call("getManuscriptPlacementHistory", projectId, manuscript.id, placement.id);
    expect(history.map((event: any) => event.eventType ?? event.event_type ?? event.type)).toEqual(["placed", "removed"]);
    await call("archiveSection", projectId, manuscript.id, section.id);
  });

  it("does not retain a second ClaimPlacement ordering authority", async () => {
    const placementColumns = await client.unsafe("select column_name from information_schema.columns where table_name='manuscript_claim_placements' and column_name='sort_order'");
    expect(placementColumns).toHaveLength(0);
    const itemColumns = await client.unsafe("select column_name from information_schema.columns where table_name='manuscript_section_items' and column_name='sort_order'");
    expect(itemColumns).toHaveLength(1);
  });

  it("persists citation style without changing canonical identity or numbering", async () => {
    const manuscript = await call("getOrCreateDefaultManuscript", projectId);
    const section = await call("createSection", projectId, manuscript.id, { title: "Formatting" });
    const paper = await includedPaper(projectId, "Opaque author source", { authors: ["Alice Smith"], publicationYear: 2024, venue: "Journal" });
    const claim = await claimWithDirectEvidence(projectId, paper, "Exact placed claim");
    const placement = await call("placeClaimRevision", projectId, manuscript.id, section.id, claim.revision.id);

    const numeric = await call("getFormattedManuscript", projectId, manuscript.id);
    const numericItem = itemsOf(numeric).find((item) => item.id === placement.id);
    const numericPaperIds = bibliographyOf(numeric).map((entry) => entry.paper?.id ?? entry.paperId);
    const numericNumbers = bibliographyOf(numeric).map((entry) => entry.citationNumber);
    expect(numeric.manuscript.citationStyle).toBe("numeric");
    expect(numericItem.renderedCitationMarker).toBe("[1]");

    await call("setManuscriptCitationStyle", projectId, manuscript.id, "author_year");
    const authorYear = await call("getFormattedManuscript", projectId, manuscript.id);
    const authorYearItem = itemsOf(authorYear).find((item) => item.id === placement.id);
    expect(authorYear.manuscript.citationStyle).toBe("author_year");
    expect(authorYearItem.renderedCitationMarker).toBe("(Alice Smith, 2024)");
    expect(bibliographyOf(authorYear).map((entry) => entry.paper?.id ?? entry.paperId)).toEqual(numericPaperIds);
    expect(bibliographyOf(authorYear).map((entry) => entry.citationNumber)).toEqual(numericNumbers);
    expect(authorYearItem.placementId).toBe(placement.id);
    expect(authorYearItem.claimRevisionId).toBe(claim.revision.id);

    await call("setManuscriptCitationStyle", projectId, manuscript.id, "numeric");
    const restored = await call("getFormattedManuscript", projectId, manuscript.id);
    expect(itemsOf(restored).find((item) => item.id === placement.id).renderedCitationMarker).toBe("[1]");
    await expect(call("setManuscriptCitationStyle", projectId, manuscript.id, "csl" as any)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
