import { describe, expect, it, vi } from "vitest";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";

const projectId = "00000000-0000-4000-8000-000000000001";
const paperId = "00000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";
const evidenceId = "00000000-0000-4000-8000-000000000004";
const claimId = "00000000-0000-4000-8000-000000000005";
const interpretationId = "00000000-0000-4000-8000-000000000006";
const synthesisStatementId = "00000000-0000-4000-8000-000000000007";
const revisionId = "00000000-0000-4000-8000-000000000008";
const existingEvidenceId = "00000000-0000-4000-8000-000000000009";
const extractionRevisionId = "00000000-0000-4000-8000-000000000010";
const synthesisRevisionId = "00000000-0000-4000-8000-000000000011";
const now = new Date("2026-09-23T00:00:00.000Z");

const projectRow = { id: projectId, title: "Receiver test", description: null, createdAt: now, updatedAt: now };
const paperRow = {
  id: paperId,
  projectId,
  title: "Receiver test paper",
  authors: [],
  publicationYear: null,
  venue: null,
  doi: null,
  abstract: null,
  bibliographicNote: null,
  createdAt: now,
  updatedAt: now,
};
const fieldRow = {
  id: fieldId,
  projectId,
  name: "Field",
  description: null,
  fieldType: "short_text",
  required: false,
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};
const evidenceRow = {
  id: evidenceId,
  projectId,
  paperId,
  fullTextDocumentId: null,
  documentTextExtractionId: null,
  extractionStartOffset: null,
  extractionEndOffset: null,
  sourceText: "Evidence",
  pageNumber: 1,
  note: null,
  createdAt: now,
  updatedAt: now,
};
const interpretationRow = {
  id: interpretationId,
  sequence: 1,
  projectId,
  synthesisStatementId,
  synthesisRevisionId: revisionId,
  convergenceState: "convergent",
  summary: "Interpretation",
  researcherNote: null,
  createdAt: now,
  finalizedAt: now,
};
const paperReviewRow = {
  id: paperId,
  paper_id: paperId,
  project_id: projectId,
  title: paperRow.title,
  authors: [],
  publication_year: null,
  venue: null,
  doi: null,
  abstract: null,
  bibliographic_note: null,
  created_at: now,
  updated_at: now,
  decision_id: null,
  title_abstract_decision: "include",
  full_text_decision: "include",
  full_text_retrieval_state: "retrieved",
  has_full_text_retrieval_attempts: true,
  ever_retrieved: true,
  has_analytical_history: false,
};

function rowsFor(table: unknown): unknown[] {
  const name = (table as Record<PropertyKey, unknown> | null)?.[Symbol.for("drizzle:Name")];
  if (name === "projects") return [projectRow];
  if (name === "papers") return [paperRow];
  if (name === "extraction_fields") return [fieldRow];
  if (name === "evidence") return [evidenceRow];
  if (name === "synthesis_interpretations") return [interpretationRow];
  return [];
}

function fakeDatabase(executeRows: unknown[] = [paperReviewRow]) {
  const execute = vi.fn(async () => executeRows);
  const transaction = vi.fn(async () => ({ id: revisionId }));
  const db = {
    execute,
    transaction,
    select: vi.fn(() => ({
      from(table: unknown) {
        const rows = rowsFor(table);
        const query = {
          where: () => query,
          orderBy: async () => rows,
          limit: async () => rows,
          for: () => query,
          then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
        };
        return query;
      },
    })),
  };
  return db as unknown as Database;
}

function receiverSpy<T extends (...args: never[]) => unknown>(
  services: ReturnType<typeof createReviewServices>,
  result: unknown,
) {
  return vi.fn(function (this: unknown) {
    expect(this).toBe(services);
    return result;
  }) as unknown as T;
}

function replaceServiceMethod<K extends keyof ReturnType<typeof createReviewServices>>(
  services: ReturnType<typeof createReviewServices>,
  method: K,
  replacement: ReturnType<typeof createReviewServices>[K],
) {
  Object.defineProperty(services, method, { configurable: true, writable: true, value: replacement });
}

function currentClaim(evidence: Array<{ evidenceId: string; evidence: unknown }> = []) {
  return {
    claim: { id: claimId, projectId, claimText: "Claim" },
    currentRevision: {
      id: revisionId,
      lifecycle: "active",
      claimText: "Claim",
      researcherNote: null,
      supportStatus: "supported",
      supports: { evidence, extractionRevisions: [], synthesisRevisions: [] },
    },
  };
}

describe("review service sibling calls retain the final composition receiver", () => {
  it.each([
    ["setExtractionValue", { state: "present", value: "x" }, [projectId, paperId, fieldId, { state: "present", value: "x" }]],
    ["clearExtractionValue", "note", [projectId, paperId, fieldId, { state: "cleared", researcherNote: "note", evidenceIds: [] }]],
  ] as const)("routes %s through the composed receiver to reviseExtractionValue", async (owner, input, expectedArgs) => {
    const services = createReviewServices(fakeDatabase());
    const revise = receiverSpy<typeof services.reviseExtractionValue>(services, { id: revisionId });
    replaceServiceMethod(services, "reviseExtractionValue", revise);

    if (owner === "setExtractionValue") await services.setExtractionValue(projectId, paperId, fieldId, input);
    else await services.clearExtractionValue(projectId, paperId, fieldId, input);

    expect(revise).toHaveBeenCalledWith(...expectedArgs);
  });

  it.each([
    ["linkEvidenceToExtractionValue", [evidenceId], [evidenceId, "next-evidence"]],
    ["unlinkEvidenceFromExtractionValue", [evidenceId, "next-evidence"], [evidenceId]],
  ] as const)("routes %s through getPaperExtraction and reviseExtractionValue on the composed receiver", async (owner, existingIds, expectedIds) => {
    const services = createReviewServices(fakeDatabase());
    const getPaperExtraction = receiverSpy<typeof services.getPaperExtraction>(services, {
      values: [{
        field: { id: fieldId },
        currentRevision: {
          evidence: existingIds.map((id) => ({ id })),
          valueState: "present",
          optionId: null,
          textValue: "value",
          numberValue: null,
          booleanValue: null,
          researcherNote: null,
        },
      }],
    });
    const revise = receiverSpy<typeof services.reviseExtractionValue>(services, { id: revisionId });
    replaceServiceMethod(services, "getPaperExtraction", getPaperExtraction);
    replaceServiceMethod(services, "reviseExtractionValue", revise);

    if (owner === "linkEvidenceToExtractionValue") {
      await services.linkEvidenceToExtractionValue(projectId, { paperId, fieldId, evidenceId: "next-evidence" });
    } else {
      await services.unlinkEvidenceFromExtractionValue(projectId, { paperId, fieldId, evidenceId: "next-evidence" });
    }

    expect(getPaperExtraction).toHaveBeenCalledWith(projectId, paperId);
    expect(revise).toHaveBeenCalledWith(projectId, paperId, fieldId, expect.objectContaining({ evidenceIds: expectedIds }));
  });

  it("routes extraction progress and field summary lookups through the composed receiver", async () => {
    const services = createReviewServices(fakeDatabase());
    const getPaperExtraction = receiverSpy<typeof services.getPaperExtraction>(services, { values: [] });
    const listExtractionComparison = receiverSpy<typeof services.listExtractionComparison>(services, [{ valueState: "present" }, { valueState: "cleared" }]);
    replaceServiceMethod(services, "getPaperExtraction", getPaperExtraction);
    replaceServiceMethod(services, "listExtractionComparison", listExtractionComparison);

    await services.getProjectExtractionProgress(projectId);
    const summary = await services.getExtractionFieldSummary(projectId, fieldId);

    expect(getPaperExtraction).toHaveBeenCalledWith(projectId, paperId);
    expect(listExtractionComparison).toHaveBeenCalledWith(projectId, fieldId);
    expect(summary.counts).toEqual({ present: 1, cleared: 1 });
  });

  it("routes claim-from-interpretation and revision chains through the composed receiver", async () => {
    const services = createReviewServices(fakeDatabase());
    const createWithSynthesis = receiverSpy<typeof services.createClaimWithSynthesisSupport>(services, { id: claimId });
    const getClaimRevision = receiverSpy<typeof services.getClaimRevision>(services, { id: revisionId });
    const createClaimRevision = receiverSpy<typeof services.createClaimRevision>(services, { id: revisionId });
    replaceServiceMethod(services, "createClaimWithSynthesisSupport", createWithSynthesis);
    replaceServiceMethod(services, "getClaimRevision", getClaimRevision);

    await services.createClaimFromInterpretation(projectId, { interpretationId, claimText: "Claim from interpretation" });
    await services.createClaimRevision(projectId, claimId, { claimText: "Revised claim", supports: [] });
    await services.withdrawClaim(projectId, claimId, {});
    replaceServiceMethod(services, "createClaimRevision", createClaimRevision);
    await services.reactivateClaim(projectId, claimId, { claimText: "Reactivated claim", supports: [] });

    expect(createWithSynthesis).toHaveBeenCalledWith(projectId, {
      claimText: "Claim from interpretation",
      researcherNote: null,
      synthesisRevisionId: revisionId,
    });
    expect(getClaimRevision).toHaveBeenNthCalledWith(1, projectId, claimId, revisionId);
    expect(getClaimRevision).toHaveBeenNthCalledWith(2, projectId, claimId, revisionId);
    expect(createClaimRevision).toHaveBeenCalledWith(projectId, claimId, expect.objectContaining({ lifecycle: "active" }));
  });

  it.each([
    [
      "linkEvidenceToClaim",
      {
        claim_id: claimId,
        revision_id: revisionId,
        state: "active",
        claim_text: "Current claim text",
        researcher_note: "Current note",
        evidence_ids: [existingEvidenceId],
        extraction_revision_ids: [extractionRevisionId],
        synthesis_revision_ids: [synthesisRevisionId],
      },
      {
        lifecycle: "active",
        claimText: "Current claim text",
        researcherNote: "Current note",
        supports: [
          { kind: "evidence", evidenceId: existingEvidenceId },
          { kind: "extractionRevision", extractionRevisionId },
          { kind: "synthesisRevision", synthesisRevisionId },
          { kind: "evidence", evidenceId },
        ],
        expectedCurrentRevisionId: revisionId,
      },
    ],
    [
      "unlinkEvidenceFromClaim",
      {
        claim_id: claimId,
        revision_id: revisionId,
        state: "withdrawn",
        claim_text: "Withdrawn claim text",
        researcher_note: "Withdrawn note",
        evidence_ids: [evidenceId, existingEvidenceId],
        extraction_revision_ids: [extractionRevisionId],
        synthesis_revision_ids: [synthesisRevisionId],
      },
      {
        lifecycle: "withdrawn",
        claimText: "Withdrawn claim text",
        researcherNote: "Withdrawn note",
        supports: [
          { kind: "evidence", evidenceId: existingEvidenceId },
          { kind: "extractionRevision", extractionRevisionId },
          { kind: "synthesisRevision", synthesisRevisionId },
        ],
        expectedCurrentRevisionId: revisionId,
      },
    ],
  ] as const)("routes %s through the targeted support snapshot and createClaimRevision on the composed receiver", async (owner, snapshot, expectedDraft) => {
    const services = createReviewServices(fakeDatabase([snapshot]));
    const getCurrentClaim = receiverSpy<typeof services.getCurrentClaim>(services, currentClaim());
    const createClaimRevision = receiverSpy<typeof services.createClaimRevision>(services, { id: revisionId });
    replaceServiceMethod(services, "getCurrentClaim", getCurrentClaim);
    replaceServiceMethod(services, "createClaimRevision", createClaimRevision);

    if (owner === "linkEvidenceToClaim") await services.linkEvidenceToClaim(projectId, { claimId, evidenceId });
    else await services.unlinkEvidenceFromClaim(projectId, { claimId, evidenceId });

    expect(getCurrentClaim).not.toHaveBeenCalled();
    expect(createClaimRevision).toHaveBeenCalledWith(projectId, claimId, expectedDraft);
  });

  it("routes claim provenance through getCurrentClaim on the composed receiver", async () => {
    const services = createReviewServices(fakeDatabase());
    const result = currentClaim([{ evidenceId, evidence: evidenceRow }]);
    const getCurrentClaim = receiverSpy<typeof services.getCurrentClaim>(services, result);
    replaceServiceMethod(services, "getCurrentClaim", getCurrentClaim);

    const provenance = await services.getClaimProvenance(projectId, claimId);

    expect(getCurrentClaim).toHaveBeenCalledWith(projectId, claimId);
    expect(provenance).toEqual({
      claim: result.claim,
      supportStatus: result.currentRevision.supportStatus,
      evidence: [evidenceRow],
    });
  });
});
