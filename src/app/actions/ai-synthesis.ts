"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { parseAiReasoningEffort } from "@/application/ai/reasoning-effort";
import { aiSynthesisServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

export async function beginAiSynthesisSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  try {
    await aiSynthesisServices.beginAiSynthesisSuggestion({
      projectId,
      preparationId,
      idempotencyKey: text(form, "idempotencyKey") || randomUUID(),
      model: optional(form, "model"),
      reasoningEffort: parseAiReasoningEffort(optional(form, "reasoningEffort")),
      externalTransmissionAcknowledged: form.get("externalTransmissionAcknowledged") === "on",
      disclosureVersion: text(form, "disclosureVersion") || "openai-synthesis-transmission-v1",
    });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/preparations/${preparationId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/preparations/${preparationId}?saved=ai-requested`);
}

export async function executeAiSynthesisSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  const requestId = text(form, "requestId");
  const detailPath = `/projects/${projectId}/synthesis/preparations/${preparationId}/ai-requests/${requestId}`;
  try { await aiSynthesisServices.executeAiSynthesisSuggestion(requestId, projectId, preparationId); }
  catch (error) { fail(detailPath, error); }
  redirect(detailPath);
}

export async function expireAiSynthesisSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  const requestId = text(form, "requestId");
  const detailPath = `/projects/${projectId}/synthesis/preparations/${preparationId}/ai-requests/${requestId}`;
  try { await aiSynthesisServices.expireAiSynthesisSuggestion(requestId, projectId, preparationId); }
  catch (error) { fail(detailPath, error); }
  redirect(detailPath);
}

export async function rejectAiSynthesisSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  const requestId = text(form, "requestId");
  const detailPath = `/projects/${projectId}/synthesis/preparations/${preparationId}/ai-requests/${requestId}`;
  try { await aiSynthesisServices.rejectAiSynthesisSuggestion(projectId, requestId, preparationId); }
  catch (error) { fail(detailPath, error); }
  redirect(`${detailPath}?saved=ai-rejected`);
}

export async function acceptAiSynthesisSuggestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  const requestId = text(form, "requestId");
  const mode = text(form, "mode") === "edit_and_accept" ? "edit_and_accept" : "accept";
  try {
    await aiSynthesisServices.acceptAiSynthesisSuggestion({
      projectId,
      requestId,
      preparationId,
      mode,
      title: optional(form, "title") ?? null,
      statementText: verbatimText(form, "statementText"),
      researcherNote: optional(form, "researcherNote") ?? null,
    });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/preparations/${preparationId}/ai-requests/${requestId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/preparations/${preparationId}/ai-requests/${requestId}?saved=ai-accepted`);
}
