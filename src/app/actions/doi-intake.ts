"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { doiLookupServices, doiResolutionServices } from "../server";
import { fail, optional, text } from "../action-helpers";

export async function beginDoiLookupAction(form: FormData) {
  const projectId = text(form, "projectId");
  if (!doiLookupServices) fail(`/projects/${projectId}/papers/doi-intake`, new DomainError("VALIDATION_ERROR", "DOI lookup is not configured"));
  let requestId = "";
  try {
    const began = await doiLookupServices.beginDoiLookup({
      projectId,
      submittedDoi: text(form, "submittedDoi") || text(form, "doi"),
      idempotencyKey: text(form, "idempotencyKey") || randomUUID(),
    });
    requestId = String(began.request.id);
  } catch (error) {
    fail(`/projects/${projectId}/papers/doi-intake`, error);
  }
  redirect(`/projects/${projectId}/papers/doi-intake/${requestId}`);
}

export async function executeDoiLookupAction(form: FormData) {
  const projectId = text(form, "projectId");
  const requestId = text(form, "requestId");
  if (!doiLookupServices) fail(`/projects/${projectId}/papers/doi-intake`, new DomainError("VALIDATION_ERROR", "DOI lookup is not configured"));
  try { await doiLookupServices.executeDoiLookup(requestId, projectId); }
  catch (error) { fail(`/projects/${projectId}/papers/doi-intake/${requestId}`, error); }
  redirect(`/projects/${projectId}/papers/doi-intake/${requestId}`);
}

function doiResolutionCreation(form: FormData) {
  const rawAuthors = text(form, "authors");
  return {
    title: text(form, "title"),
    authors: rawAuthors ? rawAuthors.split(",").map((value) => value.trim()).filter(Boolean) : [],
    publicationYear: text(form, "publicationYear") ? Number(text(form, "publicationYear")) : null,
    venue: text(form, "venue") || null,
    doi: text(form, "doi") || null,
    abstract: null,
    bibliographicNote: text(form, "bibliographicNote") || null,
  };
}

export async function createPaperFromDoiLookupAction(form: FormData) {
  const projectId = text(form, "projectId");
  const requestId = text(form, "requestId");
  const resultId = text(form, "resultId");
  try {
    await doiResolutionServices.resolveResolution(projectId, requestId, {
      action: "created_paper",
      resultId,
      expectedPreviousResolutionId: optional(form, "expectedPreviousResolutionId") ?? null,
      previewFingerprint: text(form, "previewFingerprint"),
      acknowledgedCandidateIds: form.getAll("candidatePaperIds").filter((value): value is string => typeof value === "string" && value.trim().length > 0),
      creation: doiResolutionCreation(form),
      note: optional(form, "note") ?? null,
    });
  } catch (error) {
    fail(`/projects/${projectId}/papers/doi-intake/${requestId}`, error);
  }
  redirect(`/projects/${projectId}/papers/doi-intake/${requestId}?saved=created`);
}

export async function matchDoiLookupAction(form: FormData) {
  const projectId = text(form, "projectId");
  const requestId = text(form, "requestId");
  const resultId = text(form, "resultId");
  try {
    await doiResolutionServices.resolveResolution(projectId, requestId, {
      action: "matched_paper",
      resultId,
      paperId: text(form, "paperId"),
      expectedPreviousResolutionId: optional(form, "expectedPreviousResolutionId") ?? null,
      previewFingerprint: optional(form, "previewFingerprint") ?? null,
      note: optional(form, "note") ?? null,
    });
  } catch (error) {
    fail(`/projects/${projectId}/papers/doi-intake/${requestId}`, error);
  }
  redirect(`/projects/${projectId}/papers/doi-intake/${requestId}?saved=matched`);
}

export async function clearDoiLookupResolutionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const requestId = text(form, "requestId");
  try {
    await doiResolutionServices.resolveResolution(projectId, requestId, {
      action: "cleared",
      resultId: text(form, "resultId"),
      expectedPreviousResolutionId: optional(form, "expectedPreviousResolutionId") ?? null,
      note: optional(form, "note") ?? null,
    });
  } catch (error) {
    fail(`/projects/${projectId}/papers/doi-intake/${requestId}`, error);
  }
  redirect(`/projects/${projectId}/papers/doi-intake/${requestId}?saved=cleared`);
}
