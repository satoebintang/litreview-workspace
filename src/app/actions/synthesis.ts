"use server";

import { redirect } from "next/navigation";
import type { ConvergenceState, LimitationCategory } from "@/domain/types";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

function synthesisRevisionInput(form: FormData) {
  return {
    title: optional(form, "title"),
    statementText: text(form, "statementText"),
    researcherNote: optional(form, "researcherNote"),
    extractionRevisionIds: form.getAll("extractionRevisionIds").filter((id): id is string => typeof id === "string" && id.length > 0),
  };
}

export async function createSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  let result;
  try {
    result = await reviewServices.createSynthesisStatement(projectId, synthesisRevisionInput(form));
  } catch (error) {
    fail(`/projects/${projectId}/synthesis`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${result.statement.id}?saved=created`);
}

export async function reviseSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  const statementId = text(form, "statementId");
  let result;
  try {
    result = await reviewServices.reviseSynthesisStatement(projectId, statementId, synthesisRevisionInput(form));
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/${statementId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${statementId}?saved=revised&revision=${result.revision.id}`);
}

export async function withdrawSynthesisStatementAction(form: FormData) {
  const projectId = text(form, "projectId");
  const statementId = text(form, "statementId");
  try {
    await reviewServices.withdrawSynthesisStatement(projectId, statementId, { researcherNote: optional(form, "researcherNote") });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/${statementId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${statementId}?saved=withdrawn`);
}

export async function createSynthesisPreparationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const evidenceSetId = text(form, "evidenceSetId");
  const extractionFieldId = text(form, "extractionFieldId");
  let preparation;
  try {
    preparation = await reviewServices.createSynthesisPreparation(projectId, {
      evidenceSetId,
      extractionFieldId,
      workingTitle: optional(form, "workingTitle"),
      workingNote: optional(form, "workingNote"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/evidence-sets/${evidenceSetId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/preparations/${preparation.id}`);
}

export async function updateSynthesisPreparationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  try {
    const rawTarget = form.get("targetSynthesisStatementId");
    await reviewServices.updateSynthesisPreparation(projectId, preparationId, {
      workingTitle: optional(form, "workingTitle"),
      workingNote: optional(form, "workingNote"),
      targetSynthesisStatementId: rawTarget !== null ? (optional(form, "targetSynthesisStatementId") ?? null) : undefined,
    });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/preparations/${preparationId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/preparations/${preparationId}?saved=updated`);
}

export async function replaceSynthesisPreparationSelectionsAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  try {
    const extractionRevisionIds = form
      .getAll("extractionRevisionIds")
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    await reviewServices.replaceSynthesisPreparationSelections(projectId, preparationId, {
      extractionRevisionIds,
    });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/preparations/${preparationId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/preparations/${preparationId}?saved=selections`);
}

export async function abandonSynthesisPreparationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  try {
    await reviewServices.abandonSynthesisPreparation(projectId, preparationId);
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/preparations/${preparationId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/preparations/${preparationId}?saved=abandoned`);
}

export async function finalizeSynthesisPreparationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const preparationId = text(form, "preparationId");
  let result;
  try {
    result = await reviewServices.finalizeSynthesisPreparation(projectId, preparationId, {
      statementText: verbatimText(form, "statementText"),
      title: optional(form, "title"),
      researcherNote: optional(form, "researcherNote"),
    });
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/preparations/${preparationId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${result.statement.id}?saved=finalized_from_preparation`);
}

export async function appendSynthesisInterpretationAction(form: FormData) {
  const projectId = text(form, "projectId");
  const synthesisStatementId = text(form, "synthesisStatementId");
  const synthesisRevisionId = text(form, "synthesisRevisionId");
  try {
    let limitations: { category: LimitationCategory; body: string }[] = [];
    if (form.get("limitationsJson")) {
      limitations = JSON.parse(text(form, "limitationsJson"));
    } else {
      const categories = form.getAll("limitationCategory").map((c) => String(c).trim());
      const bodies = form.getAll("limitationBody").map((b) => String(b).trim());
      limitations = categories
        .map((category, index) => ({
          category: category as LimitationCategory,
          body: bodies[index] ?? "",
        }))
        .filter((item) => item.body.length > 0);
    }

    let questions: { body: string }[] = [];
    if (form.get("questionsJson")) {
      questions = JSON.parse(text(form, "questionsJson"));
    } else {
      const bodies = form.getAll("questionBody").map((b) => String(b).trim());
      questions = bodies.map((body) => ({ body })).filter((item) => item.body.length > 0);
    }

    let contradictions: { leftExtractionRevisionId: string; rightExtractionRevisionId: string; note?: string | null }[] = [];
    if (form.get("contradictionsJson")) {
      contradictions = JSON.parse(text(form, "contradictionsJson"));
    } else if (form.getAll("contradictionPairs").length > 0) {
      contradictions = form
        .getAll("contradictionPairs")
        .map((pair) => String(pair).split(":"))
        .filter((parts) => parts.length === 2)
        .map(([left, right]) => ({
          leftExtractionRevisionId: left.trim(),
          rightExtractionRevisionId: right.trim(),
        }));
    } else {
      const lefts = form.getAll("contradictionLeftId").map((id) => String(id).trim());
      const rights = form.getAll("contradictionRightId").map((id) => String(id).trim());
      const notes = form.getAll("contradictionNote").map((n) => String(n).trim());
      contradictions = lefts
        .map((left, index) => ({
          leftExtractionRevisionId: left,
          rightExtractionRevisionId: rights[index] ?? "",
          note: notes[index] || null,
        }))
        .filter((item) => item.leftExtractionRevisionId && item.rightExtractionRevisionId);
    }

    await reviewServices.appendSynthesisInterpretation(
      projectId,
      synthesisStatementId,
      synthesisRevisionId,
      {
        convergenceState: text(form, "convergenceState") as ConvergenceState,
        summary: verbatimText(form, "summary"),
        researcherNote: optional(form, "researcherNote"),
        limitations,
        questions,
        contradictions,
      },
    );
  } catch (error) {
    fail(`/projects/${projectId}/synthesis/${synthesisStatementId}/revisions/${synthesisRevisionId}`, error);
  }
  redirect(`/projects/${projectId}/synthesis/${synthesisStatementId}/revisions/${synthesisRevisionId}?saved=interpretation`);
}
