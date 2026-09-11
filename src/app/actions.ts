"use server";

import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import type { FullTextRetrievalMethod } from "@/domain/types";
import { reviewServices } from "./server";

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function verbatimText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function optional(form: FormData, key: string) {
  const value = text(form, key);
  return value || undefined;
}

function errorMessage(error: unknown) {
  return error instanceof DomainError ? error.message : "Something went wrong. Please try again.";
}

function fail(path: string, error: unknown): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(errorMessage(error))}`);
}

export async function createProjectAction(form: FormData) {
  let project;
  try {
    project = await reviewServices.createProject({
      title: text(form, "title"),
      description: optional(form, "description"),
      researchQuestion: optional(form, "researchQuestion"),
    });
  } catch (error) {
    fail("/", error);
  }
  redirect(`/projects/${project.id}`);
}

export async function addPaperAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    const authorText = text(form, "authors");
    await reviewServices.addPaper(projectId, {
      title: text(form, "title"),
      authors: authorText ? authorText.split(",").map((author) => author.trim()).filter(Boolean) : [],
      publicationYear: text(form, "publicationYear") ? Number(text(form, "publicationYear")) : undefined,
      venue: optional(form, "venue"),
      doi: optional(form, "doi"),
      abstract: optional(form, "abstract"),
      bibliographicNote: optional(form, "bibliographicNote"),
    });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
  }
  redirect(`/projects/${projectId}?saved=paper`);
}

export async function recordEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.recordEvidence(projectId, {
      paperId: text(form, "paperId"),
      fullTextDocumentId: optional(form, "fullTextDocumentId") || null,
      sourceText: verbatimText(form, "sourceText"),
      pageNumber: Number(text(form, "pageNumber")),
      note: optional(form, "note"),
    });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
  }
  redirect(`/projects/${projectId}?saved=evidence`);
}

export async function setPreferredFullTextDocumentAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try { await reviewServices.setPreferredFullTextDocument(projectId, paperId, text(form, "documentId")); }
  catch (error) { fail(`/projects/${projectId}/papers/${paperId}/documents`, error); }
  redirect(`/projects/${projectId}/papers/${paperId}/documents?saved=preferred`);
}

export async function clearPreferredFullTextDocumentAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try { await reviewServices.clearPreferredFullTextDocument(projectId, paperId); }
  catch (error) { fail(`/projects/${projectId}/papers/${paperId}/documents`, error); }
  redirect(`/projects/${projectId}/papers/${paperId}/documents?saved=preference-cleared`);
}

export async function archiveFullTextDocumentAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try { await reviewServices.archiveFullTextDocument(projectId, text(form, "documentId")); }
  catch (error) { fail(`/projects/${projectId}/papers/${paperId}/documents`, error); }
  redirect(`/projects/${projectId}/papers/${paperId}/documents?saved=archived`);
}

export async function extractDocumentTextAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const documentId = text(form, "documentId");
  let extraction;
  try {
    extraction = await reviewServices.extractDocumentText(projectId, documentId);
  } catch (error) {
    fail(`/projects/${projectId}/papers/${paperId}/documents/${documentId}`, error);
  }
  redirect(`/projects/${projectId}/papers/${paperId}/documents/${documentId}/extractions/${extraction.id}?saved=extracted`);
}

export async function recordExtractedEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const documentId = text(form, "documentId");
  const extractionId = text(form, "extractionId");
  try {
    await reviewServices.recordEvidenceFromExtractedPage(projectId, {
      paperId,
      fullTextDocumentId: documentId,
      documentTextExtractionId: extractionId,
      pageNumber: Number(text(form, "pageNumber")),
      startOffset: Number(text(form, "startOffset")),
      endOffset: Number(text(form, "endOffset")),
      note: optional(form, "note"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/papers/${paperId}/documents/${documentId}/extractions/${extractionId}`, error);
  }
  redirect(`/projects/${projectId}/papers/${paperId}/documents/${documentId}/extractions/${extractionId}?saved=evidence`);
}

export async function appendEvidenceReviewDecisionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceId = text(form, "evidenceId");
  try {
    await reviewServices.appendEvidenceReviewDecision(projectId, evidenceId, {
      decision: text(form, "decision") as "needs_review" | "accepted" | "rejected",
      note: optional(form, "note"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/evidence/${evidenceId}`, error);
  }
  redirect(`/projects/${projectId}/evidence/${evidenceId}?saved=review`);
}

export async function appendEvidenceAnnotationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceId = text(form, "evidenceId");
  try { await reviewServices.appendEvidenceAnnotation(projectId, evidenceId, { body: verbatimText(form, "body") }); }
  catch (error) { fail(`/projects/${projectId}/evidence/${evidenceId}`, error); }
  redirect(`/projects/${projectId}/evidence/${evidenceId}?saved=annotation`);
}

export async function createEvidenceLabelAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createEvidenceLabel(projectId, { name: text(form, "name"), description: optional(form, "description") }); }
  catch (error) { fail(`/projects/${projectId}/evidence`, error); }
  redirect(`/projects/${projectId}/evidence?saved=label`);
}

export async function archiveEvidenceLabelAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.archiveEvidenceLabel(projectId, text(form, "labelId")); }
  catch (error) { fail(`/projects/${projectId}/evidence`, error); }
  redirect(`/projects/${projectId}/evidence?saved=label-archived`);
}

export async function assignEvidenceLabelAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceId = text(form, "evidenceId");
  try { await reviewServices.assignEvidenceLabel(projectId, evidenceId, text(form, "labelId")); }
  catch (error) { fail(`/projects/${projectId}/evidence/${evidenceId}`, error); }
  redirect(`/projects/${projectId}/evidence/${evidenceId}?saved=label`);
}

export async function removeEvidenceLabelAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceId = text(form, "evidenceId");
  try { await reviewServices.removeEvidenceLabel(projectId, evidenceId, text(form, "labelId")); }
  catch (error) { fail(`/projects/${projectId}/evidence/${evidenceId}`, error); }
  redirect(`/projects/${projectId}/evidence/${evidenceId}?saved=label`);
}

export async function createEvidenceSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  let set;
  try {
    set = await reviewServices.createEvidenceSet(projectId, { name: text(form, "name"), description: optional(form, "description") });
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${set.set.id}?saved=created`);
}

export async function updateEvidenceSetMetadataAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  const description = form.get("description");
  try {
    await reviewServices.updateEvidenceSetMetadata(projectId, evidenceSetId, { name: text(form, "name"), description: typeof description === "string" ? description : undefined });
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${evidenceSetId}?saved=metadata`);
}

export async function archiveEvidenceSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  try {
    await reviewServices.archiveEvidenceSet(projectId, evidenceSetId);
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${evidenceSetId}?saved=archived`);
}

export async function addEvidenceToSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  try {
    await reviewServices.addEvidenceToSet(projectId, evidenceSetId, { evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${evidenceSetId}?saved=member`);
}

export async function removeEvidenceFromSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  try {
    await reviewServices.removeEvidenceFromSet(projectId, evidenceSetId, text(form, "evidenceId"));
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${evidenceSetId}?saved=member`);
}

export async function reorderEvidenceSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  try {
    await reviewServices.reorderEvidenceSet(projectId, evidenceSetId, { evidenceIds: form.getAll("evidenceIds").filter((value): value is string => typeof value === "string").map((value) => value.trim()) });
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${evidenceSetId}?saved=reordered`);
}

export async function appendEvidenceSetAnnotationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  try {
    await reviewServices.appendEvidenceSetAnnotation(projectId, evidenceSetId, { body: verbatimText(form, "body") });
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/evidence-sets/${evidenceSetId}?saved=annotation`);
}

export async function createClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  let claim;
  try {
    claim = await reviewServices.createClaim(projectId, { claimText: text(form, "claimText") });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
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

export async function createScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createScreeningCriterion(projectId, {
      type: text(form, "type") as "inclusion" | "exclusion",
      text: text(form, "text"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/screening`, error);
  }
  redirect(`/projects/${projectId}/screening?saved=criterion`);
}

export async function archiveScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.archiveScreeningCriterion(projectId, text(form, "criterionId"));
  } catch (error) {
    fail(`/projects/${projectId}/screening`, error);
  }
  redirect(`/projects/${projectId}/screening?saved=criterion`);
}

export async function recordScreeningDecisionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const decision = text(form, "decision");
  try {
    await reviewServices.recordScreeningDecision(projectId, paperId,
      decision === "exclude"
        ? { decision: "exclude", exclusionCriterionId: text(form, "exclusionCriterionId"), note: optional(form, "note") }
        : { decision: decision as "include" | "maybe", note: optional(form, "note") },
    );
  } catch (error) {
    fail(`/projects/${projectId}/screening/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/screening/${paperId}?saved=decision`);
}

export async function createFullTextScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createFullTextScreeningCriterion(projectId, { text: text(form, "text") });
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text?saved=criterion`);
}

export async function archiveFullTextScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.archiveFullTextScreeningCriterion(projectId, text(form, "criterionId"));
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text?saved=criterion`);
}

export async function recordFullTextScreeningDecisionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const decision = text(form, "decision");
  try {
    await reviewServices.recordFullTextScreeningDecision(projectId, paperId,
      decision === "exclude"
        ? { decision: "exclude", exclusionCriterionId: text(form, "exclusionCriterionId"), note: optional(form, "note") }
        : { decision: decision as "include" | "maybe", note: optional(form, "note") },
    );
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text/${paperId}?saved=decision`);
}

export async function recordFullTextRetrievalAttemptAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try {
    await reviewServices.recordFullTextRetrievalAttempt(projectId, paperId, {
      outcome: text(form, "outcome") as "pending" | "unavailable" | "retrieved",
      method: (optional(form, "method") ?? null) as FullTextRetrievalMethod | null,
      sourceReference: optional(form, "sourceReference"),
      note: optional(form, "note"),
      attemptedAt: text(form, "attemptedAt") || new Date().toISOString(),
    });
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text/retrieval/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text/retrieval/${paperId}?saved=attempt`);
}

export async function createExtractionFieldAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createExtractionField(projectId, {
      name: text(form, "name"),
      description: optional(form, "description"),
      fieldType: text(form, "fieldType") as "short_text" | "long_text" | "number" | "boolean" | "single_select",
      required: form.get("required") === "on",
    });
  } catch (error) {
    fail(`/projects/${projectId}/extraction`, error);
  }
  redirect(`/projects/${projectId}/extraction?saved=field`);
}

export async function archiveExtractionFieldAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.archiveExtractionField(projectId, text(form, "fieldId"));
  } catch (error) {
    fail(`/projects/${projectId}/extraction`, error);
  }
  redirect(`/projects/${projectId}/extraction?saved=field`);
}

export async function createExtractionOptionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createExtractionOption(projectId, { fieldId: text(form, "fieldId"), label: text(form, "label") });
  } catch (error) {
    fail(`/projects/${projectId}/extraction`, error);
  }
  redirect(`/projects/${projectId}/extraction?saved=option`);
}

export async function archiveExtractionOptionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.archiveExtractionOption(projectId, text(form, "optionId"));
  } catch (error) {
    fail(`/projects/${projectId}/extraction`, error);
  }
  redirect(`/projects/${projectId}/extraction?saved=option`);
}

function extractionValue(form: FormData) {
  const state = text(form, "state") || "present";
  if (state !== "present") return { state: state as "not_reported" | "not_applicable" | "cleared", evidenceIds: form.getAll("evidenceIds").filter((id): id is string => typeof id === "string") };
  const kind = text(form, "valueKind");
  const raw = form.get("value");
  let value: unknown = typeof raw === "string" ? raw : undefined;
  if (kind === "number") value = typeof raw === "string" && raw !== "" ? Number(raw) : undefined;
  if (kind === "boolean") value = raw === "true";
  return {
    state: "present" as const,
    value,
    researcherNote: optional(form, "researcherNote"),
    evidenceIds: form.getAll("evidenceIds").filter((id): id is string => typeof id === "string"),
  };
}

export async function reviseExtractionValueAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try {
    await reviewServices.reviseExtractionValue(projectId, paperId, text(form, "fieldId"), extractionValue(form));
  } catch (error) {
    fail(`/projects/${projectId}/extraction/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/extraction/${paperId}?saved=value`);
}

export async function linkExtractionEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try {
    await reviewServices.linkEvidenceToExtractionValue(projectId, { paperId, fieldId: text(form, "fieldId"), evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/extraction/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/extraction/${paperId}?saved=evidence`);
}

export async function unlinkExtractionEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try {
    await reviewServices.unlinkEvidenceFromExtractionValue(projectId, { paperId, fieldId: text(form, "fieldId"), evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/extraction/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/extraction/${paperId}?saved=evidence`);
}

function synthesisRevisionInput(form: FormData) {
  return {
    title: optional(form, "title"),
    statementText: text(form, "statementText"),
    researcherNote: optional(form, "researcherNote"),
    extractionRevisionIds: form.getAll("extractionRevisionIds").filter((id): id is string => typeof id === "string" && id.length > 0),
  };
}

export async function createSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  let result;
  try {
    result = await reviewServices.createSynthesisStatement(projectId, synthesisRevisionInput(form));
  } catch (error) {
    fail(`/projects/${projectId}/synthesis`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${result.statement.id}?saved=created`);
}

export async function reviseSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  const statementId = text(form, "statementId");
  let result;
  try {
    result = await reviewServices.reviseSynthesisStatement(projectId, statementId, synthesisRevisionInput(form));
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/${statementId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${statementId}?saved=revised&revision=${result.revision.id}`);
}

export async function withdrawSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  const statementId = text(form, "statementId");
  try {
    await reviewServices.withdrawSynthesisStatement(projectId, statementId, { researcherNote: optional(form, "researcherNote") });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/${statementId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${statementId}?saved=withdrawn`);
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

const manuscriptServices = reviewServices as typeof reviewServices & {
  createSection: (projectId: string, manuscriptId: string, input: { title: string; sectionType?: string }) => Promise<unknown>;
  renameSection: (projectId: string, manuscriptId: string, sectionId: string, title: string) => Promise<unknown>;
  reorderSections: (projectId: string, manuscriptId: string, ids: string[]) => Promise<unknown>;
  archiveSection: (projectId: string, manuscriptId: string, sectionId: string) => Promise<unknown>;
  placeClaimRevision: (projectId: string, manuscriptId: string, sectionId: string, revisionId: string, position?: number) => Promise<unknown>;
  replacePlacedClaimRevision: (projectId: string, manuscriptId: string, placementId: string, revisionId: string, expected?: string) => Promise<unknown>;
  removeClaimPlacement: (projectId: string, manuscriptId: string, placementId: string) => Promise<unknown>;
  createProseBlock: (projectId: string, manuscriptId: string, sectionId: string, input: { text: string; position?: number }) => Promise<unknown>;
  updateProseBlock: (projectId: string, manuscriptId: string, proseBlockId: string, input: { text: string }) => Promise<unknown>;
  removeProseBlock: (projectId: string, manuscriptId: string, proseBlockId: string) => Promise<unknown>;
  reorderSectionItems: (projectId: string, manuscriptId: string, sectionId: string, ids: string[]) => Promise<unknown>;
};

function many(form: FormData, key: string) { return form.getAll(key).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()); }

export async function createManuscriptSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  try { await manuscriptServices.createSection(projectId, manuscriptId, { title: text(form, "title"), sectionType: optional(form, "sectionType") }); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=section`);
}

export async function renameManuscriptSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  try { await manuscriptServices.renameSection(projectId, manuscriptId, sectionId, text(form, "title")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=section`);
}

export async function reorderManuscriptSectionsAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  try { await manuscriptServices.reorderSections(projectId, manuscriptId, many(form, "sectionIds")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=reordered`);
}

export async function archiveManuscriptSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  try { await manuscriptServices.archiveSection(projectId, manuscriptId, sectionId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=archived`);
}

export async function placeClaimRevisionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  const rawPosition = text(form, "position");
  const position = rawPosition === "" ? undefined : Number(rawPosition);
  try { await manuscriptServices.placeClaimRevision(projectId, manuscriptId, sectionId, text(form, "claimRevisionId"), position); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=placed`);
}

export async function replacePlacedClaimRevisionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const placementId = text(form, "placementId");
  try { await manuscriptServices.replacePlacedClaimRevision(projectId, manuscriptId, placementId, text(form, "claimRevisionId"), optional(form, "expectedCurrentClaimRevisionId")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=replaced`);
}

export async function removeClaimPlacementAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const placementId = text(form, "placementId");
  try { await manuscriptServices.removeClaimPlacement(projectId, manuscriptId, placementId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=removed`);
}

export async function createManuscriptProseBlockAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  const rawPosition = text(form, "position");
  const position = rawPosition === "" ? undefined : Number(rawPosition);
  try { await manuscriptServices.createProseBlock(projectId, manuscriptId, sectionId, { text: verbatimText(form, "text"), position }); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=prose`);
}

export async function updateManuscriptProseBlockAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const proseBlockId = text(form, "proseBlockId");
  try { await manuscriptServices.updateProseBlock(projectId, manuscriptId, proseBlockId, { text: verbatimText(form, "text") }); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=prose`);
}

export async function removeManuscriptProseBlockAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const proseBlockId = text(form, "proseBlockId");
  try { await manuscriptServices.removeProseBlock(projectId, manuscriptId, proseBlockId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=removed-prose`);
}

export async function reorderManuscriptSectionItemsAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  try { await manuscriptServices.reorderSectionItems(projectId, manuscriptId, sectionId, many(form, "itemIds")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=reordered`);
}

export async function setManuscriptCitationStyleAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  try { await manuscriptServices.setManuscriptCitationStyle(projectId, manuscriptId, text(form, "citationStyle")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=citation-style`);
}

// Slice 9 acquisition actions intentionally stay thin: validation, project
// ownership, and immutable history are owned by reviewServices.
export async function createResearchQuestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createResearchQuestion(projectId, { identifier: text(form, "identifier"), label: text(form, "label") }); }
  catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=question`);
}

export async function createSearchSourceAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createSearchSource(projectId, { sourceKey: text(form, "sourceKey"), displayName: text(form, "displayName"), baseUrl: optional(form, "baseUrl"), notes: optional(form, "notes") }); }
  catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=source`);
}

export async function createSearchStrategyAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createSearchStrategy(projectId, { searchSourceId: text(form, "searchSourceId"), name: text(form, "name"), queryText: verbatimText(form, "queryText"), filtersText: optional(form, "filtersText"), notes: optional(form, "notes") }); }
  catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=strategy`);
}

export async function createSearchRunAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createSearchRun(projectId, {
      searchSourceId: text(form, "searchSourceId"), sourceKeySnapshot: text(form, "sourceKeySnapshot"), sourceDisplayNameSnapshot: text(form, "sourceDisplayNameSnapshot"), strategyId: text(form, "strategyId"),
      queryText: verbatimText(form, "queryText"), filtersTextSnapshot: optional(form, "filtersTextSnapshot"), reportedResultCount: Number(text(form, "reportedResultCount")), executedAt: text(form, "executedAt"), notes: optional(form, "notes"),
    });
  } catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=run`);
}

export async function createRetrievedRecordAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    const authorText = text(form, "authors");
    await reviewServices.createRetrievedRecord(projectId, {
      searchRunId: text(form, "searchRunId"), searchSourceId: text(form, "searchSourceId"), sourceRecordId: optional(form, "sourceRecordId"), title: text(form, "title"),
      authors: authorText ? authorText.split(",").map((author) => author.trim()).filter(Boolean) : [], abstract: optional(form, "abstract"), doi: optional(form, "doi"), url: optional(form, "url"), publicationYear: text(form, "publicationYear") ? Number(text(form, "publicationYear")) : undefined,
      venue: optional(form, "venue"), rawCitation: optional(form, "rawCitation"), retrievedAt: text(form, "retrievedAt") || new Date().toISOString(),
    });
  } catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=record`);
}

export async function createPaperFromRetrievedRecordAction(form: FormData) {
  const projectId = text(form, "projectId"); const recordId = text(form, "recordId");
  let result;
  try { result = await reviewServices.createPaperFromRetrievedRecord(projectId, recordId, { title: optional(form, "title"), bibliographicNote: optional(form, "bibliographicNote") }); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${text(form, "runId")}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${text(form, "runId")}?saved=paper&paperId=${encodeURIComponent(result.paper.id)}`);
}

export async function linkRetrievedRecordToPaperAction(form: FormData) {
  const projectId = text(form, "projectId"); const runId = text(form, "runId");
  try { await reviewServices.linkRetrievedRecordToPaper(projectId, text(form, "recordId"), text(form, "paperId")); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${runId}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${runId}?saved=linked`);
}

export async function unlinkRetrievedRecordFromPaperAction(form: FormData) {
  const projectId = text(form, "projectId"); const runId = text(form, "runId");
  try { await reviewServices.unlinkRetrievedRecordFromPaper(projectId, text(form, "recordId"), text(form, "paperId")); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${runId}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${runId}?saved=unlinked`);
}

export async function relinkRetrievedRecordAction(form: FormData) {
  const projectId = text(form, "projectId"); const runId = text(form, "runId");
  try { await reviewServices.relinkRetrievedRecord(projectId, text(form, "recordId"), text(form, "fromPaperId"), text(form, "toPaperId")); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${runId}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${runId}?saved=relinked`);
}

function deduplicationPairPath(projectId: string, leftRecordId: string, rightRecordId: string) {
  return `/projects/${projectId}/deduplication/${encodeURIComponent(leftRecordId)}/${encodeURIComponent(rightRecordId)}`;
}

export async function confirmSameWorkAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  try {
    await reviewServices.confirmSameWork(projectId, leftRecordId, rightRecordId, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=same_work`);
}

export async function confirmSameWorkAndResolveAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  const resolutionType = text(form, "resolutionType");
  const resolution = resolutionType === "existing"
    ? { paperId: text(form, "paperId") }
    : { createFromRecordId: text(form, "createFromRecordId"), overrides: { title: optional(form, "title") } };
  try {
    await reviewServices.confirmSameWorkAndResolve(projectId, leftRecordId, rightRecordId, resolution, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=same_work_resolved`);
}

export async function decideDifferentWorkAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  try {
    await reviewServices.decideDifferentWork(projectId, leftRecordId, rightRecordId, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=different_work`);
}

export async function correctDifferentWorkAndResolveAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  try {
    await reviewServices.correctDifferentWorkAndResolve(projectId, leftRecordId, rightRecordId, {
      relinkRecordId: text(form, "relinkRecordId"),
      toPaperId: text(form, "toPaperId"),
    }, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=different_work_resolved`);
}
