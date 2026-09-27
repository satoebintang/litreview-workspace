import { describe, expect, it, vi } from "vitest";
import { resolveEvidenceSetCompositionRevisionMembers } from "@/application/evidence-set-composition-resolver";

const projectId = "11111111-1111-4111-8111-111111111111";
const evidenceSetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const membershipA = "44444444-4444-4444-8444-444444444444";
const membershipB = "55555555-5555-4555-8555-555555555555";
const evidenceA = "66666666-6666-4666-8666-666666666666";
const evidenceB = "77777777-7777-4777-8777-777777777777";
const paperId = "88888888-8888-4888-8888-888888888888";

function memberRow(input: {
  membershipId: string;
  nextMembershipId: string | null;
  evidenceId: string;
  position: number;
}) {
  return {
    revision_id: revisionId,
    project_id: projectId,
    evidence_set_id: evidenceSetId,
    member_count: 2,
    head_membership_id: membershipA,
    tail_membership_id: membershipB,
    membership_id: input.membershipId,
    next_membership_id: input.nextMembershipId,
    evidence_id: input.evidenceId,
    paper_id: paperId,
    position: input.position,
  };
}

function executorReturning(rows: Record<string, unknown>[]) {
  return { execute: vi.fn().mockResolvedValue(rows) } as unknown as Parameters<typeof resolveEvidenceSetCompositionRevisionMembers>[0];
}

describe("exact Evidence Set composition resolver", () => {
  it("returns the exact revision's bounded linked order and validates its terminal tail", async () => {
    const executor = executorReturning([
      memberRow({ membershipId: membershipA, nextMembershipId: membershipB, evidenceId: evidenceA, position: 1 }),
      memberRow({ membershipId: membershipB, nextMembershipId: null, evidenceId: evidenceB, position: 2 }),
    ]);

    await expect(resolveEvidenceSetCompositionRevisionMembers(executor, projectId, evidenceSetId, revisionId))
      .resolves.toEqual([
        { membershipId: membershipA, evidenceId: evidenceA, paperId, position: 1 },
        { membershipId: membershipB, evidenceId: evidenceB, paperId, position: 2 },
      ]);
  });

  it("rejects a repeated membership in the count-bounded walk", async () => {
    const repeatedRows = [
      memberRow({ membershipId: membershipA, nextMembershipId: membershipB, evidenceId: evidenceA, position: 1 }),
      memberRow({ membershipId: membershipB, nextMembershipId: membershipA, evidenceId: evidenceB, position: 2 }),
      memberRow({ membershipId: membershipA, nextMembershipId: membershipB, evidenceId: evidenceA, position: 3 }),
    ].map((row) => ({ ...row, member_count: 3, tail_membership_id: membershipA }));
    const executor = executorReturning(repeatedRows);

    await expect(resolveEvidenceSetCompositionRevisionMembers(executor, projectId, evidenceSetId, revisionId))
      .rejects.toThrow(/root, tail, or member-count invariant/i);
  });

  it("rejects a tail that still has a successor", async () => {
    const executor = executorReturning([
      memberRow({ membershipId: membershipA, nextMembershipId: membershipB, evidenceId: evidenceA, position: 1 }),
      memberRow({ membershipId: membershipB, nextMembershipId: membershipA, evidenceId: evidenceB, position: 2 }),
    ]);

    await expect(resolveEvidenceSetCompositionRevisionMembers(executor, projectId, evidenceSetId, revisionId))
      .rejects.toThrow(/root, tail, or member-count invariant/i);
  });

  it("rejects an inexact revision identity even when a mocked executor returns rows", async () => {
    const rows = [memberRow({ membershipId: membershipA, nextMembershipId: null, evidenceId: evidenceA, position: 1 })];
    rows[0].revision_id = "99999999-9999-4999-8999-999999999999";
    rows[0].member_count = 1;
    rows[0].tail_membership_id = membershipA;
    const executor = executorReturning(rows);

    await expect(resolveEvidenceSetCompositionRevisionMembers(executor, projectId, evidenceSetId, revisionId))
      .rejects.toThrow(/does not belong to the requested Project and Set/i);
  });
});
