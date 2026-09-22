import { describe, expect, it } from "vitest";
import { deriveProjectGuidance, type ProjectGuidanceFacts } from "@/application/project-workspace-read-services";

const baseFacts = (): ProjectGuidanceFacts => ({
  projectId: "project-123",
  researchQuestionCount: 1,
  canonicalPaperCount: 1,
  unresolvedDuplicatePairCount: 0,
  unscreenedPaperCount: 0,
  maybePaperCount: 0,
  retrievalNotSoughtCount: 0,
  retrievalPendingCount: 0,
  retrievalUnavailableCount: 0,
  awaitingFullTextAssessmentCount: 0,
  fullTextMaybeCount: 0,
  fullTextConflictCount: 0,
  finallyIncludedPaperCount: 0,
  requiredFieldCount: 1,
  aiExtractionSuggestionCount: 0,
  missingRequiredExtractionPaperCount: 0,
  evidenceCount: 0,
  evidenceSetCount: 0,
  aiSynthesisSuggestionCount: 0,
  activePreparationCount: 0,
  activeUnsupportedClaimCount: 0,
  openEditorialThreadCount: 0,
  manuscriptWorkExists: false,
});

describe("deriveProjectGuidance", () => {
  it.each([
    ["research question", { researchQuestionCount: 0 }, "Define a research question", "/projects/project-123/research-questions"],
    ["papers", { canonicalPaperCount: 0 }, "Add or import Papers", "/projects/project-123/papers"],
    ["duplicates", { unresolvedDuplicatePairCount: 1 }, "Review possible duplicates", "/projects/project-123/deduplication"],
    ["title abstract screening", { unscreenedPaperCount: 1 }, "Continue title/abstract screening", "/projects/project-123/screening"],
    ["retrieval", { retrievalPendingCount: 1 }, "Continue full-text retrieval", "/projects/project-123/screening/full-text/retrieval"],
    ["full text screening", { fullTextMaybeCount: 1 }, "Continue full-text screening", "/projects/project-123/screening/full-text"],
    ["extraction protocol", { finallyIncludedPaperCount: 1, requiredFieldCount: 0 }, "Define the extraction protocol", "/projects/project-123/extraction"],
    ["AI extraction", { aiExtractionSuggestionCount: 1, nextAiExtractionHref: "/projects/project-123/extraction/paper/suggestions/request" }, "Review the next AI extraction suggestion", "/projects/project-123/extraction/paper/suggestions/request"],
    ["extraction", { missingRequiredExtractionPaperCount: 1 }, "Continue extraction", "/projects/project-123/extraction"],
    ["evidence set", { evidenceCount: 1 }, "Create an Evidence Set", "/projects/project-123/evidence-sets"],
    ["AI synthesis", { aiSynthesisSuggestionCount: 1, nextAiSynthesisHref: "/projects/project-123/synthesis/preparations/prep" }, "Review the next AI synthesis suggestion", "/projects/project-123/synthesis/preparations/prep"],
    ["preparation", { activePreparationCount: 1, nextPreparationHref: "/projects/project-123/synthesis/preparations/prep" }, "Continue synthesis preparation", "/projects/project-123/synthesis/preparations/prep"],
    ["claims", { activeUnsupportedClaimCount: 1 }, "Strengthen Claims", "/projects/project-123/claims"],
    ["review", { openEditorialThreadCount: 1 }, "Continue manuscript review", "/projects/project-123/manuscript/review"],
    ["writing", { manuscriptWorkExists: true }, "Continue writing", "/projects/project-123/manuscript"],
  ])("emits the %s rule", (_name, override, label, href) => {
    const actions = deriveProjectGuidance({ ...baseFacts(), ...override });
    expect(actions[0]).toEqual({ key: expect.any(String), label, href });
  });

  it("preserves the complete priority order for the read model", () => {
    const actions = deriveProjectGuidance({
      ...baseFacts(),
      researchQuestionCount: 0,
      canonicalPaperCount: 0,
      unresolvedDuplicatePairCount: 2,
      unscreenedPaperCount: 1,
      retrievalPendingCount: 1,
      manuscriptWorkExists: true,
    });
    expect(actions.map((action) => action.key)).toEqual([
      "research-question",
      "papers",
      "duplicates",
      "title-abstract-screening",
      "full-text-retrieval",
      "writing",
    ]);
  });
});
