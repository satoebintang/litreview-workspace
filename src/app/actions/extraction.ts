"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text } from "../action-helpers";
import { extractionReadServices } from "../server";
import { nextExtractionWorksheetResponseVersion, parseExtractionValueFormData, type ExtractionWorksheetActionState } from "../extraction-form-state";
import { DomainError } from "@/domain/errors";
import type { ExtractionEvidencePreview } from "@/application/extraction-evidence-selection-read-services";

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
  return parseExtractionValueFormData(form);
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

function rawFormText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function safeExtractionErrorMessage(error: unknown): string {
  return error instanceof DomainError
    ? error.message
    : "The extraction revision could not be saved. Your draft is still available.";
}

export async function saveExtractionWorksheetRevisionAction(
  previousState: ExtractionWorksheetActionState,
  form: FormData,
): Promise<ExtractionWorksheetActionState> {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const fieldId = text(form, "fieldId");
  const rawState = rawFormText(form, "state") || "present";
  const rawValue = rawFormText(form, "value");
  const rawResearcherNote = rawFormText(form, "researcherNote");
  const submittedEvidenceIds = form.getAll("evidenceIds").filter((id): id is string => typeof id === "string");
  const responseVersion = nextExtractionWorksheetResponseVersion(previousState?.responseVersion ?? 0);

  try {
    await reviewServices.reviseExtractionValue(projectId, paperId, fieldId, parseExtractionValueFormData(form));
  } catch (error) {
    let supportMetadata: ExtractionEvidencePreview[] = [];
    try {
      supportMetadata = await extractionReadServices.getPaperExtractionEvidenceSupportMetadata(projectId, paperId, submittedEvidenceIds);
    } catch {
      // Preserve the attempted IDs even when the submitted scope cannot be refreshed.
    }
    return {
      response: "failed",
      fieldId,
      responseVersion,
      rawState,
      rawValue,
      rawResearcherNote,
      submittedEvidenceIds,
      supportMetadata,
      safeErrorMessage: safeExtractionErrorMessage(error),
    };
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
