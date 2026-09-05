"use server";

import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
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
      sourceText: verbatimText(form, "sourceText"),
      pageNumber: Number(text(form, "pageNumber")),
      note: optional(form, "note"),
    });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
  }
  redirect(`/projects/${projectId}?saved=evidence`);
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
