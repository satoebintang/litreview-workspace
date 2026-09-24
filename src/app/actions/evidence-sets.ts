"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

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
