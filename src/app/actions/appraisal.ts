"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AppraisalWorksheetActionState } from "@/app/appraisal-form-state";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

function expectedDraftRevisionFromForm(form: FormData): number {
  const value = text(form, "expectedDraftRevision");
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "The current framework draft revision is required. Reload the definition before editing.");
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new DomainError("VALIDATION_ERROR", "The current framework draft revision is invalid. Reload the definition before editing.");
  }
  return revision;
}

function many(form: FormData, key: string) { return form.getAll(key).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()); }

function frameworkDraftRedirect(path: string, saved: string, form: FormData): never {
  revalidatePath(path);
  const focusTarget = text(form, "focusTarget");
  const focusQuery = /^draft-(section|item|response-option|overall-option)-[0-9a-f-]{36}$/i.test(focusTarget)
    ? `&focus=${encodeURIComponent(focusTarget)}`
    : "";
  redirect(`${path}?saved=${encodeURIComponent(saved)}${focusQuery}`);
}

export async function createAppraisalFrameworkAction(form: FormData) {
  const projectId = text(form, "projectId");
  let result: Awaited<ReturnType<typeof reviewServices.createAppraisalFramework>>;
  try { result = await reviewServices.createAppraisalFramework(projectId, { name: text(form, "name") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/new`, error); }
  redirect(`/projects/${projectId}/appraisal/frameworks/${result.framework.id}`);
}

export async function updateFrameworkDraftMetadataAction(form: FormData) {
  const projectId = text(form, "projectId");
  const versionId = text(form, "versionId");
  try {
    await reviewServices.updateFrameworkDraftMetadata(projectId, {
      versionId,
      expectedDraftRevision: expectedDraftRevisionFromForm(form),
      versionLabel: text(form, "versionLabel"),
      description: optional(form, "description") ?? null,
      citation: optional(form, "citation") ?? null,
      externalReferenceUrl: optional(form, "externalReferenceUrl") ?? null,
      rightsNote: optional(form, "rightsNote") ?? null,
      instructions: optional(form, "instructions") ?? null,
      intendedStudyDesign: optional(form, "intendedStudyDesign") ?? null,
      applicabilityNote: optional(form, "applicabilityNote") ?? null,
      overallJudgementRequired: form.get("overallJudgementRequired") === "on",
    });
  } catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${text(form, "frameworkId")}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${text(form, "frameworkId")}/versions/${versionId}`, "metadata", form);
}

export async function addAppraisalFrameworkSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.addFrameworkSection(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), label: text(form, "label"), description: optional(form, "description") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "section", form);
}

export async function updateAppraisalFrameworkSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.updateFrameworkSection(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), sectionId: text(form, "sectionId"), label: text(form, "label"), description: optional(form, "description") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "section", form);
}

export async function reorderAppraisalFrameworkSectionsAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.reorderFrameworkSections(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), ids: many(form, "ids") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "reordered", form);
}

export async function removeAppraisalFrameworkSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.removeFrameworkSection(projectId, { versionId, sectionId: text(form, "sectionId"), expectedDraftRevision: expectedDraftRevisionFromForm(form) }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "section-removed", form);
}

export async function addAppraisalFrameworkItemAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.addFrameworkItem(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), sectionId: text(form, "sectionId"), prompt: verbatimText(form, "prompt"), guidance: optional(form, "guidance"), required: form.get("required") === "on" }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "item", form);
}

export async function updateAppraisalFrameworkItemAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.updateFrameworkItem(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), itemId: text(form, "itemId"), sectionId: text(form, "sectionId"), prompt: verbatimText(form, "prompt"), guidance: optional(form, "guidance"), required: form.get("required") === "on" }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "item", form);
}

export async function reorderAppraisalFrameworkItemsAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.reorderFrameworkItems(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), sectionId: text(form, "sectionId"), ids: many(form, "ids") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "reordered", form);
}

export async function removeAppraisalFrameworkItemAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.removeFrameworkItem(projectId, { versionId, itemId: text(form, "itemId"), expectedDraftRevision: expectedDraftRevisionFromForm(form) }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "item-removed", form);
}

export async function addAppraisalFrameworkResponseOptionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.addFrameworkResponseOption(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), itemId: text(form, "itemId"), optionKey: text(form, "optionKey"), label: text(form, "label") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "option", form);
}

export async function updateAppraisalFrameworkResponseOptionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.updateFrameworkResponseOption(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), itemId: text(form, "itemId"), optionId: text(form, "optionId"), optionKey: text(form, "optionKey"), label: text(form, "label") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "option", form);
}

export async function reorderAppraisalFrameworkResponseOptionsAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.reorderFrameworkResponseOptions(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), itemId: text(form, "itemId"), ids: many(form, "ids") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "reordered", form);
}

export async function removeAppraisalFrameworkResponseOptionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.removeFrameworkResponseOption(projectId, { versionId, itemId: text(form, "itemId"), optionId: text(form, "optionId"), expectedDraftRevision: expectedDraftRevisionFromForm(form) }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "option-removed", form);
}

export async function setAppraisalFrameworkOverallOptionsAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try {
    const parsed = form.getAll("optionKey").map((key, index) => ({ optionKey: String(key), label: String(form.getAll("optionLabel")[index] ?? "") })).filter((option) => option.optionKey.trim() || option.label.trim());
    await reviewServices.setFrameworkOverallJudgementOptions(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), required: form.get("required") === "on", options: parsed });
  } catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "overall", form);
}

export async function reorderAppraisalFrameworkOverallOptionsAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.reorderFrameworkOverallJudgementOptions(projectId, { versionId, expectedDraftRevision: expectedDraftRevisionFromForm(form), ids: many(form, "ids") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "reordered", form);
}

export async function finalizeAppraisalFrameworkVersionAction(form: FormData) {
  const projectId = text(form, "projectId"); const versionId = text(form, "versionId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.finalizeFrameworkVersion(projectId, versionId, expectedDraftRevisionFromForm(form)); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, error); }
  frameworkDraftRedirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionId}`, "finalized", form);
}

export async function createAppraisalFrameworkVersionAction(form: FormData) {
  const projectId = text(form, "projectId"); const frameworkId = text(form, "frameworkId");
  let version: Awaited<ReturnType<typeof reviewServices.createNewFrameworkVersion>>;
  try { version = await reviewServices.createNewFrameworkVersion(projectId, frameworkId, { versionLabel: optional(form, "versionLabel") }); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}`, error); }
  redirect(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${version.version.id}`);
}

export async function archiveAppraisalFrameworkAction(form: FormData) {
  const projectId = text(form, "projectId"); const frameworkId = text(form, "frameworkId");
  try { await reviewServices.archiveAppraisalFramework(projectId, frameworkId); }
  catch (error) { fail(`/projects/${projectId}/appraisal/frameworks/${frameworkId}`, error); }
  redirect(`/projects/${projectId}/appraisal/frameworks?archived=1`);
}

export async function saveAppraisalRevisionAction(_previousState: AppraisalWorksheetActionState, form: FormData): Promise<AppraisalWorksheetActionState> {
  const projectId = text(form, "projectId"); const paperId = text(form, "paperId"); const frameworkId = text(form, "frameworkId");
  const submittedValues: Record<string, string[]> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") (submittedValues[key] ??= []).push(value);
  }
  const failure = (formError: string | null, fieldErrors: AppraisalWorksheetActionState["fieldErrors"] = []): AppraisalWorksheetActionState => ({ formError, fieldErrors, submittedValues });
  try {
    const frameworkVersionId = text(form, "frameworkVersionId");
    const detail = await reviewServices.readFrameworkVersion(projectId, frameworkVersionId);
    if (detail.framework.id !== frameworkId) return failure("This custom framework version is no longer available. Reload the current worksheet before saving.");
    const responses = many(form, "itemIds").map((itemId) => ({
      itemId,
      selectedOptionId: optional(form, `selectedOption_${itemId}`) ?? null,
      rationale: verbatimText(form, `rationale_${itemId}`) || null,
      evidenceIds: form.getAll(`evidenceIds_${itemId}`)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    }));
    const responseByItemId = new Map(responses.map((response) => [response.itemId, response]));
    const fieldErrors: AppraisalWorksheetActionState["fieldErrors"] = detail.items
      .filter((item) => item.required && !responseByItemId.get(item.id)?.selectedOptionId)
      .map((item) => ({
        controlName: `selectedOption_${item.id}`,
        fieldId: `response-group-${item.id}`,
        label: item.prompt,
        message: `Item “${item.prompt}” requires a response.`,
      }));
    const overallJudgementOptionId = optional(form, "overallJudgementOptionId") ?? null;
    if (detail.version.overallJudgementRequired && !overallJudgementOptionId) {
      fieldErrors.push({ controlName: "overallJudgementOptionId", fieldId: "overall-judgement", label: "Overall judgement", message: "Overall judgement is required." });
    }
    if (fieldErrors.length) return failure(null, fieldErrors);

    await reviewServices.saveAppraisalRevision(projectId, {
      paperId,
      frameworkId,
      frameworkVersionId,
      expectedCurrentRevisionId: optional(form, "expectedCurrentRevisionId") ?? null,
      overallJudgementOptionId,
      overallRationale: verbatimText(form, "overallRationale") || null,
      responses,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "CONCURRENT_MODIFICATION") return failure("This appraisal changed in another session. Reload the current worksheet before saving again.");
      if (error.code === "CROSS_PROJECT_REFERENCE" || error.code === "INELIGIBLE_REFERENCE") return failure("One or more selections are no longer available. Review the available choices and try again.");
      if (error.code === "DATABASE_CONSTRAINT") return failure("The appraisal could not be saved with these selections. Review the available choices and try again.");
      return failure(error.message);
    }
    return failure("The appraisal could not be saved. Review the form and try again.");
  }
  redirect(`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}?saved=revision`);
}
