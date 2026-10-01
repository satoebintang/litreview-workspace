"use server";

import { DomainError } from "@/domain/errors";
import { revalidatePath } from "next/cache";
import { reviewServices } from "../server";
import type {
  ResearchQuestionAnswerBoundedCandidateType,
  ResearchQuestionMatrixPageOptions,
  ResearchQuestionPageOptions,
  ResearchQuestionSearchPageOptions,
  ResearchQuestionTraceabilityTargetType,
} from "@/application/research-question-bounded-read-types";

type ReadResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

async function read<T>(operation: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "READ_FAILED", message: "The requested page could not be loaded. Refresh and try again." };
  }
}

export async function getResearchQuestionMatrixPageAction(
  projectId: string,
  options: ResearchQuestionMatrixPageOptions = {},
) {
  return read(() => reviewServices.getResearchQuestionMatrixPage(projectId, options));
}

export async function listResearchQuestionLinkPageAction(
  projectId: string,
  questionId: string,
  targetType: ResearchQuestionTraceabilityTargetType,
  options: ResearchQuestionPageOptions = {},
) {
  return read(() => reviewServices.listResearchQuestionLinkPage(projectId, questionId, targetType, options));
}

export async function getResearchQuestionTargetPickerPageAction(
  projectId: string,
  questionId: string,
  targetType: ResearchQuestionTraceabilityTargetType,
  options: ResearchQuestionSearchPageOptions = {},
) {
  return read(() => reviewServices.getResearchQuestionTargetPickerPage(projectId, questionId, targetType, options));
}

export async function getResearchQuestionTargetDetailPageAction(
  projectId: string,
  questionId: string,
  targetType: ResearchQuestionTraceabilityTargetType,
  targetId: string,
  options: ResearchQuestionPageOptions = {},
) {
  return read(() => reviewServices.getResearchQuestionTargetDetail(projectId, questionId, targetType, targetId, options));
}

export async function getResearchQuestionExtractionCoveragePageAction(
  projectId: string,
  questionId: string,
  fieldId: string,
  options: ResearchQuestionPageOptions = {},
) {
  return read(() => reviewServices.getResearchQuestionExtractionCoveragePage(projectId, questionId, fieldId, options));
}

export async function listResearchQuestionAnswerCandidatePageAction(
  projectId: string,
  questionId: string,
  targetType: ResearchQuestionAnswerBoundedCandidateType,
  options: ResearchQuestionSearchPageOptions = {},
) {
  return read(() => reviewServices.listResearchQuestionAnswerCandidatePage(projectId, questionId, targetType, options));
}

export async function listResearchQuestionAnswerHistoryPageAction(
  projectId: string,
  questionId: string,
  options: ResearchQuestionPageOptions = {},
) {
  return read(() => reviewServices.listResearchQuestionAnswerHistoryPage(projectId, questionId, options));
}

export async function finalizeResearchQuestionAnswerBoundedAction(input: {
  projectId: string;
  questionId: string;
  answerText: string;
  researcherNote: string;
  claimRevisionIds: string[];
  synthesisRevisionIds: string[];
}): Promise<{ ok: true; answerId: string } | { ok: false; code: string; message: string }> {
  try {
    const answer = await reviewServices.appendResearchQuestionAnswer(input.projectId, input.questionId, {
      answerText: input.answerText,
      researcherNote: input.researcherNote || null,
      claimRevisionIds: input.claimRevisionIds,
      synthesisRevisionIds: input.synthesisRevisionIds,
    });
    revalidatePath(`/projects/${input.projectId}/research-questions/${input.questionId}`);
    revalidatePath(`/projects/${input.projectId}/research-questions`);
    revalidatePath(`/projects/${input.projectId}/research-questions/${input.questionId}/answers/${answer.id}`);
    return { ok: true, answerId: answer.id };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "FINALIZATION_FAILED", message: "The Answer could not be finalized. Your text and selected contexts are still available for review." };
  }
}
