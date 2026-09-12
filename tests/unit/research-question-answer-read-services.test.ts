import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { createResearchQuestionAnswerReadServices } from "@/application/research-question-answer-read-services";
import type {
  ClaimRevisionView,
  CurrentQuestionLinks,
  SynthesisProvenance,
} from "@/domain/types";

const projectId = "00000000-0000-4000-8000-000000000001";
const questionId = "00000000-0000-4000-8000-000000000002";
const claimId = "00000000-0000-4000-8000-000000000003";
const claimRevision1Id = "00000000-0000-4000-8000-000000000004";
const claimRevision2Id = "00000000-0000-4000-8000-000000000005";
const synthesisId = "00000000-0000-4000-8000-000000000006";
const synthesisRevision1Id = "00000000-0000-4000-8000-000000000007";
const synthesisRevision2Id = "00000000-0000-4000-8000-000000000008";
const answerId = "00000000-0000-4000-8000-000000000009";

const links = (overrides: Partial<CurrentQuestionLinks> = {}): CurrentQuestionLinks => ({
  extractionFieldIds: [],
  evidenceSetIds: [],
  synthesisStatementIds: [],
  claimIds: [],
  ...overrides,
});

function claimRevision(id: string, sequence: number, lifecycle: "active" | "withdrawn" = "active", supportStatus: "supported" | "unsupported" = "supported"): ClaimRevisionView {
  return {
    id,
    sequence,
    projectId,
    claimId,
    lifecycle,
    claimText: lifecycle === "withdrawn" ? null : `Claim ${sequence}`,
    researcherNote: null,
    createdAt: new Date(`2026-09-0${sequence}T00:00:00Z`),
    finalizedAt: new Date(`2026-09-0${sequence}T00:00:00Z`),
    supportStatus,
    supports: { evidence: [], extractionRevisions: [], synthesisRevisions: [] },
    totalSupportCount: supportStatus === "supported" ? 1 : 0,
    directEvidenceCount: 0,
    extractionRevisionCount: 0,
    synthesisRevisionCount: 0,
    distinctPaperCount: 0,
    citationCandidateCount: 0,
    citationCandidates: [],
  };
}

function synthesisRevision(id: string, sequence: number, state: "active" | "withdrawn" = "active", supportStatus: "supported" | "unsupported" = "supported"): SynthesisProvenance {
  return {
    id,
    sequence,
    projectId,
    synthesisStatementId: synthesisId,
    state,
    title: `Synthesis ${sequence}`,
    statementText: `Synthesis text ${sequence}`,
    researcherNote: null,
    createdAt: new Date(`2026-09-0${sequence}T00:00:00Z`),
    finalizedAt: new Date(`2026-09-0${sequence}T00:00:00Z`),
    statement: { id: synthesisId, projectId, createdAt: new Date("2026-09-01T00:00:00Z") },
    supports: [],
    supportStatus,
    supportingRevisionCount: supportStatus === "supported" ? 1 : 0,
    supportingPaperCount: 0,
    supportingFieldCount: 0,
  };
}

function dbWithRows(...responses: unknown[]): Database {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  return { execute } as unknown as Database;
}

function answerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: answerId,
    sequence: "10",
    project_id: projectId,
    research_question_id: questionId,
    answer_text: "Researcher-authored answer",
    researcher_note: null,
    created_at: new Date("2026-09-10T00:00:00Z"),
    finalized_at: new Date("2026-09-10T00:00:00Z"),
    ...overrides,
  };
}

function claimContextRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project_id: projectId,
    research_question_id: questionId,
    answer_id: answerId,
    claim_id: claimId,
    claim_revision_id: claimRevision1Id,
    sort_order: 0,
    created_at: new Date("2026-09-10T00:00:00Z"),
    ...overrides,
  };
}

function synthesisContextRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project_id: projectId,
    research_question_id: questionId,
    answer_id: answerId,
    synthesis_statement_id: synthesisId,
    synthesis_revision_id: synthesisRevision1Id,
    sort_order: 0,
    created_at: new Date("2026-09-10T00:00:00Z"),
    ...overrides,
  };
}

function dependencies(overrides: Partial<Parameters<typeof createResearchQuestionAnswerReadServices>[1]> = {}) {
  return {
    getCurrentLinksForQuestion: vi.fn(async () => links({ claimIds: [claimId], synthesisStatementIds: [synthesisId] })),
    getCurrentLinksForProject: vi.fn(async () => new Map([[questionId, links({ claimIds: [claimId], synthesisStatementIds: [synthesisId] })]])),
    getCurrentClaim: vi.fn(async (): Promise<{ claim: { id: string; projectId: string }; currentRevision: ClaimRevisionView }> => ({
      claim: { id: claimId, projectId },
      currentRevision: claimRevision(claimRevision2Id, 2),
    })),
    getClaimRevision: vi.fn(async (): Promise<{ claim: { id: string; projectId: string }; revision: ClaimRevisionView }> => ({
      claim: { id: claimId, projectId },
      revision: claimRevision(claimRevision1Id, 1),
    })),
    getCurrentSynthesis: vi.fn(async (): Promise<SynthesisProvenance> => synthesisRevision(synthesisRevision2Id, 2)),
    getSynthesisProvenance: vi.fn(async (): Promise<SynthesisProvenance> => synthesisRevision(synthesisRevision1Id, 1)),
    ...overrides,
  };
}

describe("Slice 21 Answer read models", () => {
  it("reads immutable exact history and derives current-vs-historical drift", async () => {
    const db = dbWithRows(
      [{ id: questionId }],
      [answerRow()],
      [claimContextRow()],
      [],
    );
    const deps = dependencies();
    const services = createResearchQuestionAnswerReadServices(db, deps);

    const projection = await services.getResearchQuestionAnswerProjection(projectId, questionId);
    expect(projection.finalizedAnswerCount).toBe(1);
    expect(projection.latestAnswer?.answerText).toBe("Researcher-authored answer");
    expect(projection.latestAnswer?.claimContexts[0]).toMatchObject({
      claimRevisionId: claimRevision1Id,
      claimRevisionSequence: 1,
      currentRevisionId: claimRevision2Id,
      currentRevisionSequence: 2,
      isCurrentRevision: false,
      supportStatus: "supported",
      driftFlags: ["referenced_claim_revision_superseded"],
    });
    expect(deps.getClaimRevision).toHaveBeenCalledTimes(1);
  });

  it("derives all six approved drift flags after unlink, withdrawal, and newer revisions", async () => {
    const db = dbWithRows(
      [{ id: questionId }],
      [answerRow()],
      [claimContextRow()],
      [synthesisContextRow()],
      [],
    );
    const deps = dependencies({
      getCurrentLinksForQuestion: vi.fn(async () => links()),
      getCurrentClaim: vi.fn(async () => ({
        claim: { id: claimId, projectId },
        currentRevision: claimRevision("00000000-0000-4000-8000-000000000010", 3, "withdrawn", "unsupported"),
      })),
      getCurrentSynthesis: vi.fn(async () => synthesisRevision("00000000-0000-4000-8000-000000000011", 3, "withdrawn", "unsupported")),
    });
    const services = createResearchQuestionAnswerReadServices(db, deps);

    const snapshot = await services.getResearchQuestionAnswerSnapshot(projectId, questionId, answerId);
    expect(snapshot.claimContexts[0].driftFlags).toEqual([
      "referenced_claim_revision_superseded",
      "referenced_claim_now_withdrawn",
      "referenced_claim_no_longer_linked_to_rq",
    ]);
    expect(snapshot.synthesisContexts[0].driftFlags).toEqual([
      "referenced_synthesis_revision_superseded",
      "referenced_synthesis_now_withdrawn",
      "referenced_synthesis_no_longer_linked_to_rq",
    ]);
    expect(snapshot.claimContexts[0].claimRevisionId).toBe(claimRevision1Id);
    expect(snapshot.synthesisContexts[0].synthesisRevisionId).toBe(synthesisRevision1Id);
  });

  it("uses candidate links supplied by the latest-event-first reducer and emits explicit reasons", async () => {
    const noRevisionClaimId = "00000000-0000-4000-8000-000000000012";
    const unsupportedClaimId = "00000000-0000-4000-8000-000000000013";
    const withdrawnClaimId = "00000000-0000-4000-8000-000000000014";
    const linkedIds = [withdrawnClaimId, noRevisionClaimId, unsupportedClaimId, claimId];
    const db = dbWithRows([{ id: questionId }], []);
    const deps = dependencies({
      getCurrentLinksForQuestion: vi.fn(async () => links({ claimIds: linkedIds, synthesisStatementIds: [] })),
      getCurrentClaim: vi.fn(async (_project: string, id: string) => {
        if (id === noRevisionClaimId) throw new DomainError("NOT_FOUND", "Claim has no finalized revision");
        const revision = id === unsupportedClaimId
          ? claimRevision(`${id.slice(0, -1)}5`, 5, "active", "unsupported")
          : id === withdrawnClaimId
            ? claimRevision(`${id.slice(0, -1)}6`, 6, "withdrawn", "unsupported")
            : claimRevision(claimRevision2Id, 2);
        return { claim: { id, projectId }, currentRevision: revision };
      }),
    });
    const services = createResearchQuestionAnswerReadServices(db, deps);

    const candidates = await services.listResearchQuestionAnswerCandidates(projectId, questionId);
    expect(candidates.claims.map((candidate) => candidate.targetId)).toEqual([...linkedIds].sort());
    expect(candidates.claims.find((candidate) => candidate.targetId === noRevisionClaimId)?.reason).toBe("no_finalized_revision");
    expect(candidates.claims.find((candidate) => candidate.targetId === unsupportedClaimId)?.reason).toBe("unsupported");
    expect(candidates.claims.find((candidate) => candidate.targetId === withdrawnClaimId)?.reason).toBe("withdrawn");
    expect(candidates.claims.find((candidate) => candidate.targetId === claimId)?.isSelectable).toBe(true);
    expect(deps.getCurrentLinksForQuestion).toHaveBeenCalledTimes(1);
  });

  it("returns deterministic project facts with one drifted-context count per affected context", async () => {
    const secondQuestionId = "00000000-0000-4000-8000-000000000015";
    const db = dbWithRows(
      [{ id: projectId }],
      [{ id: secondQuestionId, sort_order: 0 }, { id: questionId, sort_order: 1 }],
      [answerRow({ research_question_id: questionId })],
      [claimContextRow()],
      [],
    );
    const deps = dependencies({
      getCurrentLinksForProject: vi.fn(async () => new Map([[questionId, links()]])),
    });
    const services = createResearchQuestionAnswerReadServices(db, deps);

    const facts = await services.getProjectResearchQuestionAnswerFacts(projectId);
    expect(facts.rows).toEqual([
      {
        researchQuestionId: secondQuestionId,
        finalizedAnswerCount: 0,
        latestAnswerSequence: null,
        claimContextCount: 0,
        synthesisContextCount: 0,
        derivedDriftCount: 0,
      },
      {
        researchQuestionId: questionId,
        finalizedAnswerCount: 1,
        latestAnswerSequence: 10,
        claimContextCount: 1,
        synthesisContextCount: 0,
        derivedDriftCount: 1,
      },
    ]);
  });
});
