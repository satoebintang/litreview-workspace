import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeReviewFlowMarkdown } from "@/application/review-reporting";
import { slice49BaselineProjectionBeyondInteractiveLimits } from "../fixtures/slice50-review-report-export-projection";

describe("complete Review Flow Markdown export", () => {
  // Expected bytes were generated with the released v0.49.0-slice49 serializer at 81fb52c9ebb7cbd7ed3c60b68aa8238712c1a445.
  it("matches retained v0.49.0-slice49 bytes when context and history exceed interactive page limits", () => {
    const projection = slice49BaselineProjectionBeyondInteractiveLimits();
    const markdown = serializeReviewFlowMarkdown(projection);
    expect(projection.activeResearchQuestions).toHaveLength(27);
    expect(projection.activeCriteria).toHaveLength(27);
    expect(projection.activeFullTextCriteria).toHaveLength(27);
    expect(projection.identification.bySource).toHaveLength(27);
    expect(projection.identification.runs).toHaveLength(28);
    expect(projection.screening.exclusionReasons).toHaveLength(15);
    expect(projection.fullTextEligibility.exclusionReasons).toHaveLength(15);
    const expected = readFileSync(path.resolve(process.cwd(), "tests/fixtures/slice49-review-report-export-over-limit.md"), "utf8");
    expect(Buffer.from(markdown, "utf8")).toEqual(Buffer.from(expected, "utf8"));
  });
});
