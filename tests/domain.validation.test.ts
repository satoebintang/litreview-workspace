import { describe, expect, it } from "vitest";
import {
  createClaimSchema,
  createEvidenceSetSchema,
  createPaperSchema,
  recordEvidenceSchema,
  reorderEvidenceSetSchema,
  updateEvidenceSetMetadataSchema,
  appendSynthesisInterpretationSchema,
} from "@/domain/validation";

describe("Slice 1 input validation", () => {
  it("preserves the ordered author array", () => {
    const result = createPaperSchema.parse({ title: "Study", authors: ["Zed", "Ada"] });
    expect(result.authors).toEqual(["Zed", "Ada"]);
  });

  it("rejects blank source text and non-positive pages", () => {
    expect(recordEvidenceSchema.safeParse({ paperId: "not-a-uuid", sourceText: "", pageNumber: 0 }).success).toBe(false);
    expect(recordEvidenceSchema.safeParse({ paperId: "00000000-0000-4000-8000-000000000000", sourceText: " \n\t ", pageNumber: 1 }).success).toBe(false);
  });

  it("preserves substantive whitespace in source quotations", () => {
    const result = recordEvidenceSchema.parse({ paperId: "00000000-0000-4000-8000-000000000000", sourceText: "  Exact passage  ", pageNumber: 2 });
    expect(result.sourceText).toBe("  Exact passage  ");
  });

  it("rejects blank claim text", () => {
    expect(createClaimSchema.safeParse({ claimText: "  " }).success).toBe(false);
  });

  it("normalizes Evidence Set metadata and rejects duplicate order entries", () => {
    expect(createEvidenceSetSchema.parse({ name: "  Outcomes  ", description: "  Compare effects  " })).toEqual({ name: "Outcomes", description: "Compare effects" });
    expect(createEvidenceSetSchema.parse({ name: "Outcomes", description: "   " })).toEqual({ name: "Outcomes", description: null });
    expect(updateEvidenceSetMetadataSchema.safeParse({}).success).toBe(false);
    expect(reorderEvidenceSetSchema.safeParse({ evidenceIds: ["00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000"] }).success).toBe(false);
  });
});

describe("Slice 19 input validation", () => {
  const idA = "10000000-0000-4000-8000-000000000001";
  const idB = "20000000-0000-4000-8000-000000000002";
  const idC = "30000000-0000-4000-8000-000000000003";

  it("validates all 4 convergence states and matrix consistency", () => {
    // convergent requires exactly 0 contradiction pairs
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        contradictions: [],
      }).success,
    ).toBe(true);

    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idB }],
      }).success,
    ).toBe(false);

    // contradictory requires at least 1 pair
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [],
      }).success,
    ).toBe(false);

    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idB }],
      }).success,
    ).toBe(true);

    // mixed allows 0 or more pairs
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "mixed",
        summary: "Valid summary",
        contradictions: [],
      }).success,
    ).toBe(true);

    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "mixed",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idB }],
      }).success,
    ).toBe(true);

    // inconclusive allows 0 or more pairs
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "inconclusive",
        summary: "Valid summary",
        contradictions: [],
      }).success,
    ).toBe(true);

    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "inconclusive",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idB }],
      }).success,
    ).toBe(true);
  });

  it("enforces array ceilings: 100/100/500 accepted, 101/101/501 rejected", () => {
    const lim100 = Array.from({ length: 100 }, (_, i) => ({
      category: "methodological" as const,
      body: `Limitation ${i}`,
    }));
    const q100 = Array.from({ length: 100 }, (_, i) => ({
      body: `Question ${i}`,
    }));

    // 100 limitations & 100 questions accepted
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        limitations: lim100,
        questions: q100,
      }).success,
    ).toBe(true);

    // 101 limitations rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        limitations: [...lim100, { category: "other", body: "Limitation 101" }],
      }).success,
    ).toBe(false);

    // 101 questions rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        questions: [...q100, { body: "Question 101" }],
      }).success,
    ).toBe(false);

    // 500 contradictions
    const cont500 = Array.from({ length: 500 }, (_, i) => {
      const left = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const right = `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      return { leftExtractionRevisionId: left, rightExtractionRevisionId: right };
    });

    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: cont500,
      }).success,
    ).toBe(true);

    const cont501 = [
      ...cont500,
      {
        leftExtractionRevisionId: "00000000-0000-4000-8000-999999999999",
        rightExtractionRevisionId: "10000000-0000-4000-8000-999999999999",
      },
    ];

    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: cont501,
      }).success,
    ).toBe(false);
  });

  it("enforces text limits, blank checks, and category vocabulary", () => {
    // Blank summary
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "   ",
      }).success,
    ).toBe(false);

    // Summary 20,000 accepted, 20,001 rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "a".repeat(20000),
      }).success,
    ).toBe(true);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "a".repeat(20001),
      }).success,
    ).toBe(false);

    // Researcher note 10,000 accepted, 10,001 rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        researcherNote: "a".repeat(10000),
      }).success,
    ).toBe(true);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        researcherNote: "a".repeat(10001),
      }).success,
    ).toBe(false);

    // Whitespace researcher note transforms to null
    const parsed = appendSynthesisInterpretationSchema.parse({
      convergenceState: "convergent",
      summary: "Valid summary",
      researcherNote: "   ",
    });
    expect(parsed.researcherNote).toBeNull();

    // Limitation categories
    const validCategories = [
      "methodological",
      "population",
      "measurement",
      "generalizability",
      "missing_data",
      "heterogeneity",
      "reporting",
      "other",
    ] as const;
    for (const cat of validCategories) {
      expect(
        appendSynthesisInterpretationSchema.safeParse({
          convergenceState: "convergent",
          summary: "Valid summary",
          limitations: [{ category: cat, body: "Valid body" }],
        }).success,
      ).toBe(true);
    }
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        limitations: [{ category: "invalid_category", body: "Valid body" }],
      }).success,
    ).toBe(false);

    // Limitation body 5,000 accepted, 5,001 rejected, blank rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        limitations: [{ category: "methodological", body: "a".repeat(5000) }],
      }).success,
    ).toBe(true);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        limitations: [{ category: "methodological", body: "a".repeat(5001) }],
      }).success,
    ).toBe(false);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        limitations: [{ category: "methodological", body: "   " }],
      }).success,
    ).toBe(false);

    // Question body 5,000 accepted, 5,001 rejected, blank rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        questions: [{ body: "a".repeat(5000) }],
      }).success,
    ).toBe(true);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        questions: [{ body: "a".repeat(5001) }],
      }).success,
    ).toBe(false);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "convergent",
        summary: "Valid summary",
        questions: [{ body: "   " }],
      }).success,
    ).toBe(false);

    // Contradiction note 5,000 accepted, 5,001 rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idB, note: "a".repeat(5000) }],
      }).success,
    ).toBe(true);
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idB, note: "a".repeat(5001) }],
      }).success,
    ).toBe(false);
  });

  it("canonicalizes pairs, rejects self-pairs and unordered duplicate pairs", () => {
    // Self-pair rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [{ leftExtractionRevisionId: idA, rightExtractionRevisionId: idA }],
      }).success,
    ).toBe(false);

    // Canonicalization: idB > idA
    const parsed = appendSynthesisInterpretationSchema.parse({
      convergenceState: "contradictory",
      summary: "Valid summary",
      contradictions: [{ leftExtractionRevisionId: idB, rightExtractionRevisionId: idA }],
    });
    expect(parsed.contradictions[0].leftExtractionRevisionId).toBe(idA);
    expect(parsed.contradictions[0].rightExtractionRevisionId).toBe(idB);

    // Unordered duplicates: [(A, B), (B, A)] rejected
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [
          { leftExtractionRevisionId: idA, rightExtractionRevisionId: idB },
          { leftExtractionRevisionId: idB, rightExtractionRevisionId: idA },
        ],
      }).success,
    ).toBe(false);

    // Distinct pairs accepted
    expect(
      appendSynthesisInterpretationSchema.safeParse({
        convergenceState: "contradictory",
        summary: "Valid summary",
        contradictions: [
          { leftExtractionRevisionId: idA, rightExtractionRevisionId: idB },
          { leftExtractionRevisionId: idA, rightExtractionRevisionId: idC },
        ],
      }).success,
    ).toBe(true);
  });
});
