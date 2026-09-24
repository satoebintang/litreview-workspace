"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import type { ManualPaperActionState, ManualPaperDraft, ManualPaperReviewCandidate } from "@/app/manual-paper-form-state";
import { reviewServices } from "../server";
import { errorMessage, fail, optional, text, verbatimText } from "../action-helpers";

export async function createProjectAction(form: FormData) {
  let project;
  try {
    project = await reviewServices.createProject({
      title: text(form, "title"),
      description: optional(form, "description"),
    });
  } catch (error) {
    fail("/", error);
  }
  redirect(`/projects/${project.id}`);
}

function manualPaperDraftFrom(form: FormData): ManualPaperDraft {
  return {
    title: verbatimText(form, "title"),
    authors: verbatimText(form, "authors"),
    publicationYear: verbatimText(form, "publicationYear"),
    venue: verbatimText(form, "venue"),
    doi: verbatimText(form, "doi"),
    abstract: verbatimText(form, "abstract"),
    bibliographicNote: verbatimText(form, "bibliographicNote"),
  };
}

function manualPaperInputFrom(draft: ManualPaperDraft) {
  const publicationYear = draft.publicationYear.trim();
  const authors = draft.authors.split(",").map((author) => author.trim()).filter(Boolean);
  return {
    title: draft.title,
    authors,
    publicationYear: publicationYear ? Number(publicationYear) : undefined,
    venue: draft.venue.trim() || undefined,
    doi: draft.doi.trim() || undefined,
    abstract: draft.abstract.trim() ? draft.abstract : undefined,
    bibliographicNote: draft.bibliographicNote.trim() ? draft.bibliographicNote : undefined,
  };
}

function manualPaperCandidateSummaries(candidates: Awaited<ReturnType<typeof reviewServices.findManualPaperCandidates>>): ManualPaperReviewCandidate[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    authors: candidate.authors,
    publicationYear: candidate.publicationYear,
    venue: candidate.venue,
    doi: candidate.doi,
    candidateReason: candidate.candidateReason,
  }));
}

function manualPaperActionResult(
  status: ManualPaperActionState["status"],
  draft: ManualPaperDraft,
  candidates: ManualPaperReviewCandidate[] = [],
  error: string | null = null,
): ManualPaperActionState {
  return { version: randomUUID(), status, draft, candidates, error };
}

export async function addPaperAction(_previousState: ManualPaperActionState, form: FormData): Promise<ManualPaperActionState> {
  const projectId = text(form, "projectId");
  const draft = manualPaperDraftFrom(form);
  const intent = text(form, "manualPaperIntent");
  if (!projectId) return manualPaperActionResult("error", draft, [], "Select a project before adding a Paper.");
  if (intent !== "review" && intent !== "confirm") return manualPaperActionResult("error", draft, [], "Review possible duplicates before adding a Paper.");

  if (intent === "review") {
    try {
      const candidates = await reviewServices.findManualPaperCandidates(projectId, manualPaperInputFrom(draft));
      return manualPaperActionResult("reviewed", draft, manualPaperCandidateSummaries(candidates));
    } catch (error) {
      return manualPaperActionResult("error", draft, [], errorMessage(error));
    }
  }

  try {
    const candidatePaperIds = form.getAll("candidatePaperIds").filter((value): value is string => typeof value === "string" && value.length > 0);
    await reviewServices.addPaper(projectId, {
      ...manualPaperInputFrom(draft),
      distinctPaperAcknowledged: form.get("distinctPaperAcknowledged") === "on",
      candidatePaperIds,
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === "DUPLICATE_REVIEW_REQUIRED") {
      try {
        const candidates = await reviewServices.findManualPaperCandidates(projectId, manualPaperInputFrom(draft));
        return manualPaperActionResult("reviewed", draft, manualPaperCandidateSummaries(candidates), "The candidate list changed or still needs your acknowledgement. Review the current candidates before confirming.");
      } catch (reviewError) {
        return manualPaperActionResult("error", draft, [], errorMessage(reviewError));
      }
    }
    return manualPaperActionResult("error", draft, [], errorMessage(error));
  }

  redirect(`/projects/${projectId}/papers`);
}
