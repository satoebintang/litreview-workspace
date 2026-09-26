"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

export async function recordEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const capturePaperId = text(form, "capturePaperId");
  try {
    await reviewServices.recordEvidence(projectId, {
      paperId: capturePaperId,
      fullTextDocumentId: optional(form, "fullTextDocumentId") || null,
      sourceText: verbatimText(form, "sourceText"),
      pageNumber: Number(text(form, "pageNumber")),
      note: optional(form, "note"),
    });
  } catch (error) {
    const captureState = capturePaperId ? `?capturePaperId=${encodeURIComponent(capturePaperId)}` : "";
    fail(`/projects/${projectId}/evidence${captureState}`, error);
  }
  const captureState = capturePaperId ? `&capturePaperId=${encodeURIComponent(capturePaperId)}` : "";
  redirect(`/projects/${projectId}/evidence?saved=evidence${captureState}`);
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
