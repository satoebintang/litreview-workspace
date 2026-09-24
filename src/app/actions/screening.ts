"use server";

import { redirect } from "next/navigation";
import type { FullTextRetrievalMethod } from "@/domain/types";
import { reviewServices } from "../server";
import { fail, optional, text } from "../action-helpers";

export async function createScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createScreeningCriterion(projectId, {
      type: text(form, "type") as "inclusion" | "exclusion",
      text: text(form, "text"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/screening`, error);
  }
  redirect(`/projects/${projectId}/screening?saved=criterion`);
}

export async function archiveScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.archiveScreeningCriterion(projectId, text(form, "criterionId"));
  } catch (error) {
    fail(`/projects/${projectId}/screening`, error);
  }
  redirect(`/projects/${projectId}/screening?saved=criterion`);
}

export async function recordScreeningDecisionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const decision = text(form, "decision");
  try {
    await reviewServices.recordScreeningDecision(projectId, paperId,
      decision === "exclude"
        ? { decision: "exclude", exclusionCriterionId: text(form, "exclusionCriterionId"), note: optional(form, "note") }
        : { decision: decision as "include" | "maybe", note: optional(form, "note") },
    );
  } catch (error) {
    fail(`/projects/${projectId}/screening/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/screening/${paperId}?saved=decision`);
}

export async function createFullTextScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createFullTextScreeningCriterion(projectId, { text: text(form, "text") });
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text?saved=criterion`);
}

export async function archiveFullTextScreeningCriterionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.archiveFullTextScreeningCriterion(projectId, text(form, "criterionId"));
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text?saved=criterion`);
}

export async function recordFullTextScreeningDecisionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  const decision = text(form, "decision");
  try {
    await reviewServices.recordFullTextScreeningDecision(projectId, paperId,
      decision === "exclude"
        ? { decision: "exclude", exclusionCriterionId: text(form, "exclusionCriterionId"), note: optional(form, "note") }
        : { decision: decision as "include" | "maybe", note: optional(form, "note") },
    );
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text/${paperId}?saved=decision`);
}

export async function recordFullTextRetrievalAttemptAction(form: FormData) {
  const projectId = text(form, "projectId");
  const paperId = text(form, "paperId");
  try {
    await reviewServices.recordFullTextRetrievalAttempt(projectId, paperId, {
      outcome: text(form, "outcome") as "pending" | "unavailable" | "retrieved",
      method: (optional(form, "method") ?? null) as FullTextRetrievalMethod | null,
      sourceReference: optional(form, "sourceReference"),
      note: optional(form, "note"),
      attemptedAt: text(form, "attemptedAt") || new Date().toISOString(),
    });
  } catch (error) {
    fail(`/projects/${projectId}/screening/full-text/retrieval/${paperId}`, error);
  }
  redirect(`/projects/${projectId}/screening/full-text/retrieval/${paperId}?saved=attempt`);
}
