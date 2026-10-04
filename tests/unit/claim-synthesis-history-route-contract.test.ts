import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequireClaim } from "@/application/review-services/shared";
import { normalizeClaim } from "@/app/projects/[projectId]/claims/model";
import { displaySequenceLabel, withLosslessSequence } from "@/app/projects/history-sequence-display";

const files = {
  claimDetail: "src/app/projects/[projectId]/claims/[claimId]/page.tsx",
  claimHistory: "src/app/projects/[projectId]/claims/[claimId]/history/page.tsx",
  claimExact: "src/app/projects/[projectId]/claims/[claimId]/revisions/[revisionId]/page.tsx",
  synthesisDetail: "src/app/projects/[projectId]/synthesis/[statementId]/page.tsx",
  synthesisHistory: "src/app/projects/[projectId]/synthesis/[statementId]/history/page.tsx",
  synthesisExact: "src/app/projects/[projectId]/synthesis/[statementId]/revisions/[revisionId]/page.tsx",
  interpretationHistory: "src/app/projects/[projectId]/synthesis/[statementId]/revisions/[revisionId]/interpretations/history/page.tsx",
  interpretationExact: "src/app/projects/[projectId]/synthesis/[statementId]/revisions/[revisionId]/interpretations/[interpretationId]/page.tsx",
  readers: "src/application/claim-synthesis-history-read-services.ts",
};

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Slice 52 Claim and Synthesis route contracts", () => {
  it("keeps the normal Claim and Synthesis detail pages on bounded histories", () => {
    const claim = source(files.claimDetail);
    expect(claim).toContain("getClaimRevisionHistoryPage");
    expect(claim).not.toContain("getClaimHistorySummaries");
    expect(claim).not.toContain("getClaimHistory(");

    const synthesis = source(files.synthesisDetail);
    expect(synthesis).toContain("getSynthesisRevisionHistoryPage");
    expect(synthesis).toContain("getCurrentSynthesisInterpretationSummary");
    for (const forbidden of ["getSynthesisInterpretationHistoryPage", "getSynthesisHistorySummaries", "getSynthesisHistory(", "getSynthesisPreparationContextsForRevisions", "getSynthesisInterpretationProjection"]) {
      expect(synthesis).not.toContain(forbidden);
    }
    expect(synthesis).toContain("Paginated synthesis history · oldest first");
    expect(synthesis).toContain("history.current.id");
  });

  it("displays selected and nested BIGINT sequences without rounding", () => {
    const exactSequence = "9007199254740993";
    const selected = withLosslessSequence({ sequence: Number(exactSequence) }, exactSequence);
    expect(displaySequenceLabel(selected.sequence)).toBe(exactSequence);
    expect(displaySequenceLabel(Number(exactSequence))).toBe("sequence unavailable");

    const normalized = normalizeClaim({
      claim: { id: "claim" },
      revision: {
        id: "claim-revision",
        sequence: exactSequence,
        supports: {
          evidence: [],
          extractionRevisions: [{
            extractionRevisionId: "extraction-revision",
            extractionRevision: { id: "extraction-revision", sequence: exactSequence },
          }],
          synthesisRevisions: [{
            synthesisRevisionId: "synthesis-revision",
            synthesisRevision: {
              id: "synthesis-revision",
              sequence: exactSequence,
              supports: [{ extractionRevisionId: "nested-extraction-revision", extractionRevision: { id: "nested-extraction-revision", sequence: exactSequence } }],
            },
          }],
        },
      },
    });
    expect(normalized.currentRevision.sequence).toBe(exactSequence);
    expect(displaySequenceLabel(normalized.currentRevision.supports.extraction[0].extraction?.sequence)).toBe(exactSequence);
    expect(displaySequenceLabel(normalized.currentRevision.supports.synthesis[0].synthesis?.sequence)).toBe(exactSequence);
    expect(displaySequenceLabel(normalized.currentRevision.supports.synthesis[0].synthesis?.extractions[0].sequence)).toBe(exactSequence);

    const claim = source(files.claimDetail);
    expect(claim).toContain("claimRevisionExactAuditReadServices.getClaimRevisionForExactAudit");
    expect(claim).toContain("{ selectedCurrentRevisionId: claimHistory.current.id }");
    expect(claim).toContain("withLosslessSequence(claim.currentRevision, claimHistory.current.sequence)");
    expect(claim).toContain("displaySequenceLabel(item.sequence)");
    expect(claim).toContain("displaySequenceLabel(support.synthesis?.sequence)");

    const synthesis = source(files.synthesisDetail);
    expect(synthesis).toContain("synthesisRevisionExactRouteReadServices.getSynthesisRevisionExactRouteSequences");
    expect(synthesis).toContain("withLosslessSequence({");
    expect(synthesis).toContain("const sequence = exactSequences.extractionRevisionSequences[support.extractionRevisionId]");
    expect(synthesis).toContain("displaySequenceLabel(support.extractionRevision.sequence)");
  });

  it("keeps the exact SynthesisRevision page off all-interpretation projections", () => {
    const exact = source(files.synthesisExact);
    expect(exact).toContain("getSynthesisInterpretationHistoryPage");
    expect(exact).toContain("getCurrentSynthesisInterpretationSnapshot");
    expect(exact).toContain("history.current.id");
    expect(exact).not.toContain("getSynthesisInterpretationProjection");
    expect(exact).toContain("history.items.map");
    expect(exact).toContain("snap.summaryPreview");
    expect(exact).toContain("snap.contradictionCount");
    expect(exact).toContain("getSynthesisRevisionExactRouteSequences(projectId, statementId, revisionId)");
  });

  it("validates exact Synthesis ownership before starting preparation or history reads", () => {
    const exact = source(files.synthesisExact);
    const ownershipCheck = exact.indexOf("const legacyRevision = await reviewServices.getSynthesisProvenance(projectId, statementId, revisionId)");
    const parallelReads = exact.indexOf("const [exactSequences, prepContext, history] = await Promise.all([");
    expect(ownershipCheck).toBeGreaterThanOrEqual(0);
    expect(parallelReads).toBeGreaterThan(ownershipCheck);
    expect(exact.indexOf("getSynthesisPreparationContextForRevision(projectId, revisionId)")).toBeGreaterThan(ownershipCheck);
    expect(exact.indexOf("getSynthesisInterpretationHistoryPage(projectId, statementId, revisionId")).toBeGreaterThan(ownershipCheck);
  });

  it("skips only a previously completed project lookup for exact Claim revision ownership", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const requireProject = vi.fn(async (requestedProjectId: string) => ({ id: requestedProjectId }));
    const claim = { id: "00000000-0000-4000-8000-000000000002" };
    const findById = vi.fn(async (requestedProjectId: string, requestedClaimId: string) => {
      expect([requestedProjectId, requestedClaimId]).toEqual([projectId, claim.id]);
      return claim;
    });
    const requireClaim = createRequireClaim(requireProject, { findById });

    await requireProject(projectId);
    await requireClaim(projectId, claim.id, { projectAlreadyValidated: true });
    expect(requireProject).toHaveBeenCalledTimes(1);
    expect(requireProject).toHaveBeenCalledWith(projectId);
    expect(findById).toHaveBeenCalledWith(projectId, claim.id);

    await requireClaim(projectId, claim.id);
    expect(requireProject).toHaveBeenCalledTimes(2);

    const claimServices = source("src/application/review-services/claim-services.ts");
    expect(claimServices).toContain("async getClaimRevision(projectId: string, claimId: string, revisionId: string)");
    expect(claimServices).toContain("await requireProject(projectId); ensureId(claimId); ensureId(revisionId);\n      const claim = await requireClaim(projectId, claimId, { projectAlreadyValidated: true });");
  });

  it("scopes exact pages and continuation routes to one parent chain and one stream", () => {
    const exactClaim = source(files.claimExact);
    expect(exactClaim).toContain("getClaimRevisionForExactAudit(projectId, claimId, revisionId)");
    expect(exactClaim).toContain("claimRevisionExactAuditReadServices.getClaimRevisionForExactAudit");
    const exactInterpretation = source(files.interpretationExact);
    expect(exactInterpretation).toContain("getExactSynthesisInterpretation(projectId, statementId, revisionId, interpretationId)");
    for (const [path, expected, forbidden] of [
      [files.claimHistory, "getClaimRevisionHistoryPage", "getSynthesisRevisionHistoryPage"],
      [files.synthesisHistory, "getSynthesisRevisionHistoryPage", "getClaimRevisionHistoryPage"],
      [files.interpretationHistory, "getSynthesisInterpretationHistoryPage", "getSynthesisRevisionHistoryPage"],
    ]) {
      const route = source(path);
      expect(route).toContain(expected);
      expect(route).not.toContain(forbidden);
      expect(route).toContain("withReviewReadTransaction");
      expect(route).toContain("cursor: query.cursor");
    }
    const interpretationHistory = source(files.interpretationHistory);
    expect(interpretationHistory).not.toContain("getCurrentSynthesisInterpretationSummary");
    expect(interpretationHistory).toContain("claimSynthesisHistoryReadServices.getSynthesisInterpretationHistoryPage");
  });

  it("aggregates Synthesis metrics and preparation only after selecting visible history rows", () => {
    const readers = source(files.readers);
    expect(readers).toContain("visible_page as materialized");
    expect(readers).toContain("from visible_page v\n      cross join lateral (\n        select count(distinct s.extraction_revision_id)");
    expect(readers).toContain("synthesisPreparationHistoryQuery(scope.projectId, baseItems.map((item) => item.id))");
    expect(readers).toContain("left(r.statement_text, 320)");
    expect(readers).toContain("sequence::text as sequence");
  });
});
