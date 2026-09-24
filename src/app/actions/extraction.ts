"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text } from "../action-helpers";

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
