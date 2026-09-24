"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

export async function inspectPdfIntakeAction(form: FormData) {
  const projectId = text(form, "projectId");
  const intakeId = text(form, "intakeId");
  try {
    await reviewServices.ensureInitialPdfMetadataResult(projectId, intakeId);
  } catch (error) {
    fail(`/projects/${projectId}/papers/pdf-intake/${intakeId}`, error);
  }
  redirect(`/projects/${projectId}/papers/pdf-intake/${intakeId}?saved=inspected`);
}

export async function resolvePdfIntakeAction(form: FormData) {
  const projectId = text(form, "projectId");
  const intakeId = text(form, "intakeId");
  const kind = text(form, "resolutionKind") === "match_paper" ? "match_paper" as const : "create_paper" as const;
  const authors = form.getAll("authors")
    .flatMap((value) => String(value).split(/\r?\n/))
    .map((value) => value.trim())
    .filter(Boolean);
  const payload = {
    title: text(form, "title"),
    authors,
    publicationYear: text(form, "publicationYear") ? Number(text(form, "publicationYear")) : null,
    venue: optional(form, "venue") ?? null,
    doi: optional(form, "doi") ?? null,
    abstract: form.get("abstract") == null ? null : verbatimText(form, "abstract") || null,
    bibliographicNote: optional(form, "bibliographicNote") ?? null,
  };
  let result;
  try {
    const preview = await reviewServices.previewPdfIntakeResolution(projectId, intakeId, kind === "create_paper"
      ? { kind, payload, distinctPaperAcknowledged: form.get("distinctPaperAcknowledged") === "on" }
      : { kind, paperId: text(form, "paperId") });
    result = await reviewServices.resolvePdfIntake(projectId, intakeId, {
      kind,
      paperId: kind === "match_paper" ? text(form, "paperId") : null,
      payload: kind === "create_paper" ? payload : undefined,
      previewFingerprint: preview.fingerprint,
      distinctPaperAcknowledged: form.get("distinctPaperAcknowledged") === "on",
      acknowledgedCandidateIds: preview.candidates.map((candidate) => candidate.id),
      metadataResultId: preview.metadataResultId,
    });
  } catch (error) {
    fail(`/projects/${projectId}/papers/pdf-intake/${intakeId}`, error);
  }
  redirect(`/projects/${projectId}/papers/${result.paperId}/documents/${result.fullTextDocumentId}?saved=pdf-intake`);
}
