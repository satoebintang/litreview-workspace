"use server";

import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "./server";

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function verbatimText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function optional(form: FormData, key: string) {
  const value = text(form, key);
  return value || undefined;
}

function errorMessage(error: unknown) {
  return error instanceof DomainError ? error.message : "Something went wrong. Please try again.";
}

function fail(path: string, error: unknown): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(errorMessage(error))}`);
}

export async function createProjectAction(form: FormData) {
  let project;
  try {
    project = await reviewServices.createProject({
      title: text(form, "title"),
      description: optional(form, "description"),
      researchQuestion: optional(form, "researchQuestion"),
    });
  } catch (error) {
    fail("/", error);
  }
  redirect(`/projects/${project.id}`);
}

export async function addPaperAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    const authorText = text(form, "authors");
    await reviewServices.addPaper(projectId, {
      title: text(form, "title"),
      authors: authorText ? authorText.split(",").map((author) => author.trim()).filter(Boolean) : [],
      publicationYear: text(form, "publicationYear") ? Number(text(form, "publicationYear")) : undefined,
      venue: optional(form, "venue"),
      doi: optional(form, "doi"),
      abstract: optional(form, "abstract"),
      bibliographicNote: optional(form, "bibliographicNote"),
    });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
  }
  redirect(`/projects/${projectId}?saved=paper`);
}

export async function recordEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.recordEvidence(projectId, {
      paperId: text(form, "paperId"),
      sourceText: verbatimText(form, "sourceText"),
      pageNumber: Number(text(form, "pageNumber")),
      note: optional(form, "note"),
    });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
  }
  redirect(`/projects/${projectId}?saved=evidence`);
}

export async function createClaimAction(form: FormData) {
  const projectId = text(form, "projectId");
  let claim;
  try {
    claim = await reviewServices.createClaim(projectId, { claimText: text(form, "claimText") });
  } catch (error) {
    fail(`/projects/${projectId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claim.id}`);
}

export async function linkEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await reviewServices.linkEvidenceToClaim(projectId, { claimId, evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}`);
}

export async function unlinkEvidenceAction(form: FormData) {
  const projectId = text(form, "projectId");
  const claimId = text(form, "claimId");
  try {
    await reviewServices.unlinkEvidenceFromClaim(projectId, { claimId, evidenceId: text(form, "evidenceId") });
  } catch (error) {
    fail(`/projects/${projectId}/claims/${claimId}`, error);
  }
  redirect(`/projects/${projectId}/claims/${claimId}`);
}

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
