import { describe, expect, it } from "vitest";
import * as repositories from "@/application/repositories";

const releasedRepositoryExports = [
  "ProjectRepository",
  "PaperRepository",
  "EvidenceRepository",
  "FullTextDocumentRepository",
  "DocumentTextExtractionRepository",
  "ClaimRepository",
  "ClaimRevisionRepository",
  "ClaimRevisionSupportRepository",
  "ScreeningCriterionRepository",
  "ScreeningDecisionRepository",
  "FullTextScreeningCriterionRepository",
  "FullTextScreeningDecisionRepository",
  "FullTextRetrievalAttemptRepository",
  "PaperReviewRepository",
  "ExtractionFieldRepository",
  "ExtractionOptionRepository",
  "ExtractionValueRepository",
  "ExtractionRevisionRepository",
  "ExtractionRevisionEvidenceRepository",
  "SynthesisStatementRepository",
  "SynthesisRevisionRepository",
  "SynthesisRevisionSupportRepository",
];

describe("repository compatibility API", () => {
  it("preserves the released 22-class export list and order", () => {
    expect(Object.keys(repositories)).toEqual(releasedRepositoryExports);
    expect(Object.values(repositories).every((repository) => typeof repository === "function")).toBe(true);
  });
});
