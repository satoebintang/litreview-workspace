"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

function many(form: FormData, key: string) { return form.getAll(key).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()); }

export async function linkExtractionFieldAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const fieldId = text(form, "fieldId") || text(form, "extractionFieldId");
  const note = optional(form, "note");
  try {
    await reviewServices.linkExtractionField({ projectId, questionId, fieldId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=field_linked`);
}

export async function unlinkExtractionFieldAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const fieldId = text(form, "fieldId") || text(form, "extractionFieldId");
  const note = optional(form, "note");
  try {
    await reviewServices.unlinkExtractionField({ projectId, questionId, fieldId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=field_unlinked`);
}

export async function linkEvidenceSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const evidenceSetId = text(form, "evidenceSetId");
  const note = optional(form, "note");
  try {
    await reviewServices.linkEvidenceSet({ projectId, questionId, evidenceSetId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=evidence_set_linked`);
}

export async function unlinkEvidenceSetAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const evidenceSetId = text(form, "evidenceSetId");
  const note = optional(form, "note");
  try {
    await reviewServices.unlinkEvidenceSet({ projectId, questionId, evidenceSetId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=evidence_set_unlinked`);
}

export async function linkSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const statementId = text(form, "statementId") || text(form, "synthesisStatementId");
  const note = optional(form, "note");
  try {
    await reviewServices.linkSynthesisStatement({ projectId, questionId, statementId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=synthesis_linked`);
}

export async function unlinkSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const statementId = text(form, "statementId") || text(form, "synthesisStatementId");
  const note = optional(form, "note");
  try {
    await reviewServices.unlinkSynthesisStatement({ projectId, questionId, statementId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=synthesis_unlinked`);
}

export async function linkClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const claimId = text(form, "claimId");
  const note = optional(form, "note");
  try {
    await reviewServices.linkClaim({ projectId, questionId, claimId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=claim_linked`);
}

export async function unlinkClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const claimId = text(form, "claimId");
  const note = optional(form, "note");
  try {
    await reviewServices.unlinkClaim({ projectId, questionId, claimId, note });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}?saved=claim_unlinked`);
}

export async function appendResearchQuestionAnswerAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const claimRevisionIds = form
    .getAll("claimRevisionIds")
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const synthesisRevisionIds = form
    .getAll("synthesisRevisionIds")
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  let answer;
  try {
    answer = await reviewServices.appendResearchQuestionAnswer(projectId, questionId, {
      answerText: verbatimText(form, "answerText"),
      researcherNote: optional(form, "researcherNote"),
      claimRevisionIds,
      synthesisRevisionIds,
    });
  } catch (error) {
    // The write service deliberately rejects exact revision conflicts instead
    // of floating to a newer revision. Redirecting back to the detail page
    // causes Server Components to refresh candidates before another attempt.
    fail(`/projects/${projectId}/research-questions/${questionId}`, error);
  }
  redirect(`/projects/${projectId}/research-questions/${questionId}/answers/${answer.id}?saved=answer`);
}

const answerManuscriptServices = reviewServices as typeof reviewServices & {
  applyResearchQuestionAnswerToSection: (
    projectId: string,
    questionId: string,
    answerId: string,
    input: {
      manuscriptId: string;
      sectionId: string;
      proseText?: string | null;
      claimRevisionIds: string[];
      insertion: { kind: "append" } | { kind: "before"; sectionItemId: string };
    },
  ) => Promise<unknown>;
};

export async function applyResearchQuestionAnswerToSectionAction(form: FormData) {
  const projectId = text(form, "projectId");
  const questionId = text(form, "questionId");
  const answerId = text(form, "answerId");
  const manuscriptId = text(form, "manuscriptId");
  const sectionId = text(form, "sectionId");
  const claimRevisionIds = many(form, "claimRevisionIds");
  const insertion = text(form, "insertionKind") === "before"
    ? { kind: "before" as const, sectionItemId: text(form, "sectionItemId") }
    : { kind: "append" as const };

  try {
    await answerManuscriptServices.applyResearchQuestionAnswerToSection(projectId, questionId, answerId, {
      manuscriptId,
      sectionId,
      proseText: verbatimText(form, "proseText"),
      claimRevisionIds,
      insertion,
    });
  } catch (error) {
    fail(`/projects/${projectId}/research-questions/${questionId}/answers/${answerId}/manuscript`, error);
  }
  redirect(`/projects/${projectId}/manuscript?saved=answer`);
}
