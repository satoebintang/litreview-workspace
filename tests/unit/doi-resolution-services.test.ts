import { describe, expect, it } from "vitest";
import { computeDoiResolutionFingerprint, type DoiResolutionCandidate } from "@/application/doi-resolution-services";

const candidate: DoiResolutionCandidate = {
  id: "00000000-0000-4000-8000-000000000001",
  paperId: "00000000-0000-4000-8000-000000000001",
  rank: 1,
  reason: "doi",
  candidateReason: "doi",
  candidatePriority: 1,
  title: "Existing study",
  authors: ["Ada Lovelace"],
  publicationYear: 2024,
  venue: "Journal",
  doi: "10.1000/existing",
  abstract: null,
  selected: false,
};

describe("DOI resolution preview fingerprints", () => {
  it("is deterministic for the same request, payload, and candidate context", () => {
    const input = {
      requestId: "00000000-0000-4000-8000-000000000002",
      resultId: "00000000-0000-4000-8000-000000000003",
      action: "created_paper" as const,
      expectedPreviousResolutionId: null,
      payload: { title: "New study", authors: [], publicationYear: 2024, venue: null, doi: "10.1000/new", abstract: null, bibliographicNote: null },
      selectedPaperId: null,
      candidates: [candidate],
    };
    expect(computeDoiResolutionFingerprint(input)).toBe(computeDoiResolutionFingerprint({ ...input, candidates: [{ ...candidate }] }));
  });

  it("changes when a candidate or expected previous resolution changes", () => {
    const input = {
      requestId: "00000000-0000-4000-8000-000000000002",
      resultId: "00000000-0000-4000-8000-000000000003",
      action: "created_paper" as const,
      expectedPreviousResolutionId: null,
      payload: { title: "New study", authors: [], publicationYear: 2024, venue: null, doi: "10.1000/new", abstract: null, bibliographicNote: null },
      selectedPaperId: null,
      candidates: [candidate],
    };
    const fingerprint = computeDoiResolutionFingerprint(input);
    expect(computeDoiResolutionFingerprint({ ...input, expectedPreviousResolutionId: candidate.paperId })).not.toBe(fingerprint);
    expect(computeDoiResolutionFingerprint({ ...input, candidates: [{ ...candidate, title: "Changed study" }] })).not.toBe(fingerprint);
  });
});
