"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

export async function createClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  let claim;
  try {
    claim = await reviewServices.createClaim(projectId, { claimText: text(form, "claimText") });
  } catch (error) {
    fail(`/projects/${projectId}/claims`, error);
  }
  redirect(`/projects/${projectId}/claims/${claim.id}`);
}

export async function linkEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await reviewServices.linkEvidenceToClaim(projectId, { claimId, evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}`);
}

export async function unlinkEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await reviewServices.unlinkEvidenceFromClaim(projectId, { claimId, evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}`);
}

// Slice 5 Claim actions keep the complete support snapshot in the form payload.
// The service owns validation, locking, and immutable revision construction.
type ClaimRevisionServices = {
  createClaim: (projectId: string, input: Record<string, unknown>) => Promise<{ id: string }>;
  createClaimRevision: (projectId: string, claimId: string, input: Record<string, unknown>) => Promise<unknown>;
  withdrawClaim: (projectId: string, claimId: string, input: Record<string, unknown>) => Promise<unknown>;
  reactivateClaim: (projectId: string, claimId: string, input: Record<string, unknown>) => Promise<unknown>;
};

const revisionClaimServices = reviewServices as unknown as ClaimRevisionServices;

function ids(form: FormData, key: string) {
  return form.getAll(key).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function claimSnapshot(form: FormData) {
  const supports = [
    ...ids(form, "evidenceIds").map((evidenceId) => ({ kind: "evidence" as const, evidenceId })),
    ...ids(form, "extractionRevisionIds").map((extractionRevisionId) => ({ kind: "extractionRevision" as const, extractionRevisionId })),
    ...ids(form, "synthesisRevisionIds").map((synthesisRevisionId) => ({ kind: "synthesisRevision" as const, synthesisRevisionId })),
  ];
  return {
    claimText: text(form, "claimText"),
    researcherNote: optional(form, "researcherNote"),
    lifecycle: (text(form, "state") || "active") as "active" | "withdrawn",
    supports,
  };
}

export async function createClaimRevisionAction(form: FormData) {
  const projectId = text(form, "projectId");
  let claim;
  try {
    claim = await revisionClaimServices.createClaim(projectId, claimSnapshot(form));
  } catch (error) {
    fail(`/projects/${projectId}/claims`, error);
  }
  redirect(`/projects/${projectId}/claims/${claim.id}?saved=created`);
}

export async function reviseClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await revisionClaimServices.createClaimRevision(projectId, claimId, {
      ...claimSnapshot(form),
      expectedCurrentRevisionId: optional(form, "expectedCurrentRevisionId"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}?saved=revised`);
}

export async function withdrawClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await revisionClaimServices.withdrawClaim(projectId, claimId, {
      expectedCurrentRevisionId: optional(form, "expectedCurrentRevisionId"),
      researcherNote: optional(form, "researcherNote"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}?saved=withdrawn`);
}

export async function reactivateClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await revisionClaimServices.reactivateClaim(projectId, claimId, {
      ...claimSnapshot(form),
      lifecycle: "active",
      expectedCurrentRevisionId: optional(form, "expectedCurrentRevisionId"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}?saved=reactivated`);
}

export async function createClaimFromInterpretationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const interpretationId = text(form, "interpretationId");
  const synthesisRevisionId = optional(form, "synthesisRevisionId");
  let claim;
  try {
    claim = await reviewServices.createClaimFromInterpretation(projectId, {
      interpretationId,
      synthesisRevisionId,
      claimText: verbatimText(form, "claimText"),
      researcherNote: optional(form, "researcherNote"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/claims?interpretationId=${interpretationId}${synthesisRevisionId ? `&synthesisRevisionId=${synthesisRevisionId}` : ""}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claim.id}?saved=created_from_interpretation`);
}
