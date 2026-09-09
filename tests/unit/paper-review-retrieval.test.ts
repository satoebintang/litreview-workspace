import { describe, expect, it } from "vitest";
import { derivePaperReviewStatus } from "@/domain/paper-review";

describe("full-text retrieval status derivation", () => {
  it("keeps current state and historical success separate", () => {
    const status = derivePaperReviewStatus({
      titleAbstractDecision: "include",
      fullTextDecision: null,
      fullTextRetrievalState: "unavailable",
      everRetrieved: true,
      hasFullTextRetrievalAttempts: true,
    });
    expect(status.fullTextRetrievalState).toBe("unavailable");
    expect(status.everRetrieved).toBe(true);
  });

  it("does not infer retrieval readiness from a legacy full-text decision", () => {
    const status = derivePaperReviewStatus({
      titleAbstractDecision: "include",
      fullTextDecision: "include",
      hasFullTextRetrievalAttempts: false,
    });
    expect(status.fullTextRetrievalState).toBe("not_sought");
    expect(status.everRetrieved).toBe(false);
    expect(status.warnings).toContain("legacy_full_text_decision_without_retrieval_record");
    expect(status.finalEligibility).toBe("included");
  });

  it("uses retrieval history conflict independently of final eligibility", () => {
    const status = derivePaperReviewStatus({
      titleAbstractDecision: "exclude",
      fullTextDecision: "include",
      fullTextRetrievalState: "retrieved",
      everRetrieved: true,
      hasFullTextRetrievalAttempts: true,
    });
    expect(status.warnings).toContain("retrieval_history_without_current_title_abstract_inclusion");
    expect(status.finalEligibility).toBe("not_eligible");
  });
});
