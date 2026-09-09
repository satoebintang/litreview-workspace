import type {
  FinalEligibility,
  FullTextDecisionState,
  FullTextRetrievalState,
  PaperReviewStatus,
  PaperReviewWarning,
  ScreeningDecisionValue,
  ScreeningState,
} from "./types";

export type PaperReviewInputs = {
  titleAbstractDecision: ScreeningDecisionValue | null;
  fullTextDecision: ScreeningDecisionValue | null;
  fullTextRetrievalState?: FullTextRetrievalState;
  everRetrieved?: boolean;
  hasFullTextRetrievalAttempts?: boolean;
  hasAnalyticalHistory?: boolean;
};

function titleAbstractState(decision: ScreeningDecisionValue | null): ScreeningState {
  if (decision === "include") return "included";
  if (decision === "exclude") return "excluded";
  if (decision === "maybe") return "maybe";
  return "unscreened";
}

function fullTextState(decision: ScreeningDecisionValue | null): FullTextDecisionState {
  if (decision === "include") return "included";
  if (decision === "exclude") return "excluded";
  if (decision === "maybe") return "maybe";
  return "not_started";
}

export function derivePaperReviewStatus(input: PaperReviewInputs): PaperReviewStatus {
  const titleState = titleAbstractState(input.titleAbstractDecision);
  const fullState = fullTextState(input.fullTextDecision);
  const fullTextRetrievalState = input.fullTextRetrievalState ?? "not_sought";
  const everRetrieved = input.everRetrieved ?? false;
  const crossStageConflict = input.fullTextDecision !== null && input.titleAbstractDecision !== "include";
  let finalEligibility: FinalEligibility;

  if (input.titleAbstractDecision === "include") {
    if (input.fullTextDecision === null) finalEligibility = "pending_full_text";
    else if (input.fullTextDecision === "include") finalEligibility = "included";
    else if (input.fullTextDecision === "exclude") finalEligibility = "excluded";
    else finalEligibility = "unresolved_full_text";
  } else if (input.titleAbstractDecision === "exclude") {
    finalEligibility = "not_eligible";
  } else {
    finalEligibility = input.titleAbstractDecision === "maybe" ? "title_abstract_unresolved" : "title_abstract_pending";
  }

  const warnings: PaperReviewWarning[] = [];
  if (crossStageConflict) warnings.push("cross_stage_conflict");
  if (input.fullTextDecision === null && input.hasAnalyticalHistory) warnings.push("legacy_analysis_precedes_full_text_screening");
  if (input.fullTextDecision !== null && !input.hasFullTextRetrievalAttempts) warnings.push("legacy_full_text_decision_without_retrieval_record");
  if (input.hasFullTextRetrievalAttempts && input.titleAbstractDecision !== "include") warnings.push("retrieval_history_without_current_title_abstract_inclusion");

  return { titleAbstractState: titleState, fullTextState: fullState, fullTextRetrievalState, everRetrieved, finalEligibility, crossStageConflict, warnings };
}

export function isFinallyIncluded(status: PaperReviewStatus): boolean {
  return status.finalEligibility === "included";
}
