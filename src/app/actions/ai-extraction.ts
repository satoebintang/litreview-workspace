"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { parseAiReasoningEffort } from "@/application/ai/reasoning-effort";
import { aiExtractionBatchServices, aiExtractionServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

export async function beginAiExtractionSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  let began: { requestId: string };
  try {
    began = await aiExtractionServices.beginAiExtractionSuggestion({
      projectId,
      paperId,
      fieldId: text(form, "fieldId"),
      fullTextDocumentId: text(form, "fullTextDocumentId"),
      documentTextExtractionId: text(form, "documentTextExtractionId"),
      pageNumbers: form.getAll("pageNumbers").map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
      idempotencyKey: text(form, "idempotencyKey") || randomUUID(),
      model: optional(form, "model"),
      reasoningEffort: parseAiReasoningEffort(optional(form, "reasoningEffort")),
      externalTransmissionAcknowledged: form.get("externalTransmissionAcknowledged") === "on",
      disclosureVersion: text(form, "disclosureVersion") || "openai-extraction-transmission-v1",
    }) as { requestId: string };
  } catch (error) {
    fail(`/projects/${projectId}/extraction/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/extraction/${paperId}/suggestions/${began.requestId}`);
}

export async function executeAiExtractionSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const requestId = text(form, "requestId");
  try { await aiExtractionServices.executeAiExtractionSuggestion(requestId, projectId); }
  catch (error) { fail(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`, error); }
  redirect(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`);
}

export async function expireAiExtractionSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const requestId = text(form, "requestId");
  try { await aiExtractionServices.expireAiExtractionSuggestion(requestId, projectId); }
  catch (error) { fail(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`, error); }
  redirect(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`);
}

export async function rejectAiExtractionSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const requestId = text(form, "requestId");
  try { await aiExtractionServices.rejectAiExtractionSuggestion(projectId, requestId); }
  catch (error) { fail(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`, error); }
  redirect(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}?saved=rejected`);
}

export async function acceptAiExtractionSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const requestId = text(form, "requestId");
  const mode = text(form, "mode") === "edit_and_accept" ? "edit_and_accept" : "accept";
  const state = text(form, "state") as "present" | "not_reported" | "not_applicable" | "cleared" | "";
  const kind = text(form, "valueKind");
  const rawValue = form.get("value");
  let value: string | boolean | undefined;
  if (state === "present" && typeof rawValue === "string" && rawValue !== "") {
    // Keep decimal input as text through the server boundary so numeric(30,10)
    // validation never loses precision through a JavaScript Number conversion.
    value = kind === "boolean"
      ? rawValue === "true" ? true : rawValue === "false" ? false : rawValue
      : rawValue;
  }
  let reusedEvidenceByGroundingId: Record<string, string> | undefined;
  const reused = optional(form, "reusedEvidenceByGroundingId");
  if (reused) {
    try { reusedEvidenceByGroundingId = JSON.parse(reused) as Record<string, string>; } catch { reusedEvidenceByGroundingId = undefined; }
  }
  try {
    await aiExtractionServices.acceptAiExtractionSuggestion({
      projectId,
      requestId,
      mode,
      expectedCurrentRevisionId: optional(form, "expectedCurrentRevisionId") ?? null,
      state: state || undefined,
      value,
      researcherNote: optional(form, "researcherNote") ?? null,
      groundingIds: form.getAll("groundingIds").filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0),
      reusedEvidenceByGroundingId,
    });
  } catch (error) {
    fail(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`, error);
  }
  redirect(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}?saved=accepted`);
}

function batchItems(form: FormData) {
  const raw = verbatimText(form, "itemsJson");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("itemsJson must be an array");
    return parsed.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Every batch item must be an object");
      const value = item as Record<string, unknown>;
      return {
        paperId: String(value.paperId ?? ""),
        fieldId: String(value.fieldId ?? ""),
        fullTextDocumentId: value.fullTextDocumentId == null ? undefined : String(value.fullTextDocumentId),
        documentTextExtractionId: value.documentTextExtractionId == null ? undefined : String(value.documentTextExtractionId),
        idempotencyKey: value.idempotencyKey == null ? undefined : String(value.idempotencyKey),
      };
    });
  } catch (error) {
    throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Batch item JSON is invalid");
  }
}

export async function previewAiExtractionBatchAction(form: FormData) {
  const projectId = text(form, "projectId");
  let preview: Awaited<ReturnType<typeof aiExtractionBatchServices.previewAiExtractionBatch>>;
  try {
    preview = await aiExtractionBatchServices.previewAiExtractionBatch({
      projectId,
      items: batchItems(form),
      model: optional(form, "model"),
      reasoningEffort: "low",
      externalTransmissionAcknowledged: form.get("externalTransmissionAcknowledged") === "on",
    });
  } catch (error) {
    fail(`/projects/${projectId}/extraction/batches/new`, error);
  }
  redirect(`/projects/${projectId}/extraction/batches/new?previewHash=${encodeURIComponent(preview.confirmationHash)}&cells=${preview.counts.cells}&executable=${preview.counts.executable}&reusable=${preview.counts.reusable}`);
}

export async function createAiExtractionBatchAction(form: FormData) {
  const projectId = text(form, "projectId");
  let batch: Awaited<ReturnType<typeof aiExtractionBatchServices.createAiExtractionBatch>>;
  try {
    const confirmationHash = optional(form, "confirmationHash");
    if (!confirmationHash) throw new DomainError("VALIDATION_ERROR", "Review the batch preview before creating it");
    const preview = await aiExtractionBatchServices.previewAiExtractionBatch({
      projectId,
      items: batchItems(form),
      model: optional(form, "model"),
      reasoningEffort: "low",
      externalTransmissionAcknowledged: form.get("externalTransmissionAcknowledged") === "on",
    });
    batch = await aiExtractionBatchServices.createAiExtractionBatch(preview, confirmationHash);
  } catch (error) {
    fail(`/projects/${projectId}/extraction/batches/new`, error);
  }
  redirect(`/projects/${projectId}/extraction/batches/${batch.batchId}`);
}

export async function processAiExtractionBatchAction(form: FormData) {
  const projectId = text(form, "projectId");
  const batchId = text(form, "batchId");
  try { await aiExtractionBatchServices.executeAiExtractionBatch(projectId, batchId); }
  catch (error) { fail(`/projects/${projectId}/extraction/batches/${batchId}`, error); }
  redirect(`/projects/${projectId}/extraction/batches/${batchId}`);
}

export async function cancelAiExtractionBatchAction(form: FormData) {
  const projectId = text(form, "projectId");
  const batchId = text(form, "batchId");
  try { await aiExtractionBatchServices.cancelAiExtractionBatch(batchId, projectId); }
  catch (error) { fail(`/projects/${projectId}/extraction/batches/${batchId}`, error); }
  redirect(`/projects/${projectId}/extraction/batches/${batchId}`);
}
