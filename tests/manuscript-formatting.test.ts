import { describe, expect, it } from "vitest";
import {
  buildFormattedManuscript,
  serializeManuscriptMarkdown,
  type ManuscriptFormattingSource,
} from "@/application/manuscript-formatting";

const ids = {
  manuscript: "00000000-0000-4000-8000-000000000001",
  section: "00000000-0000-4000-8000-000000000002",
  prose: "00000000-0000-4000-8000-000000000003",
  claimItem: "00000000-0000-4000-8000-000000000004",
  placement: "00000000-0000-4000-8000-000000000005",
  claim: "00000000-0000-4000-8000-000000000006",
  revision: "00000000-0000-4000-8000-000000000007",
  paperA: "00000000-0000-4000-8000-000000000008",
  paperB: "00000000-0000-4000-8000-000000000009",
};

function view(): ManuscriptFormattingSource {
  return {
    manuscript: {
      id: ids.manuscript,
      projectId: "00000000-0000-4000-8000-000000000010",
      title: "Exact draft",
      isDefault: true,
      citationStyle: "author_year",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    sections: [{
      id: ids.section,
      projectId: "00000000-0000-4000-8000-000000000010",
      manuscriptId: ids.manuscript,
      title: "Introduction",
      sectionType: "introduction",
      sortOrder: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      archivedAt: null,
      items: [
        {
          id: ids.prose,
          projectId: "00000000-0000-4000-8000-000000000010",
          manuscriptId: ids.manuscript,
          sectionId: ids.section,
          itemType: "prose",
          sortOrder: 0,
          createdAt: new Date(0),
          removedAt: null,
          text: "Prose\r\nkept exactly.",
          updatedAt: new Date(0),
        },
        {
          id: ids.claimItem,
          projectId: "00000000-0000-4000-8000-000000000010",
          manuscriptId: ids.manuscript,
          sectionId: ids.section,
          itemType: "claim",
          sortOrder: 1,
          createdAt: new Date(0),
          removedAt: null,
          placement: {
            id: ids.placement,
            projectId: "00000000-0000-4000-8000-000000000010",
            manuscriptId: ids.manuscript,
            sectionId: ids.section,
            claimId: ids.claim,
            claimRevisionId: ids.revision,
            createdAt: new Date(0),
            removedAt: null,
            claim: { id: ids.claim, projectId: "00000000-0000-4000-8000-000000000010", createdAt: new Date(0) },
            claimRevision: { id: ids.revision, sequence: 1, projectId: "00000000-0000-4000-8000-000000000010", claimId: ids.claim, lifecycle: "active", claimText: "Claim text", researcherNote: null, createdAt: new Date(0), finalizedAt: new Date(0) },
            latestClaimRevisionId: ids.revision,
            claimLifecycle: "active",
            supportStatus: "supported",
            isCurrentClaimRevision: true,
            isSuperseded: false,
            citationCandidates: [],
            citationNumbers: [],
          },
          citationCandidates: [],
          citationNumbers: [],
        },
      ],
    }],
    bibliographyCandidates: [
      {
        paper: { id: ids.paperA, projectId: "00000000-0000-4000-8000-000000000010", title: "Zeta", authors: ["Alice Smith"], publicationYear: 2024, venue: "Venue", doi: null, abstract: null, bibliographicNote: null, createdAt: new Date(0), updatedAt: new Date(0) },
        citationNumber: 1,
        firstOccurrence: { sectionId: ids.section, sectionItemId: ids.claimItem, placementId: ids.placement, claimRevisionId: ids.revision },
      },
      {
        paper: { id: ids.paperB, projectId: "00000000-0000-4000-8000-000000000010", title: "Alpha", authors: ["Bob Jones"], publicationYear: 2024, venue: "Venue", doi: null, abstract: null, bibliographicNote: null, createdAt: new Date(0), updatedAt: new Date(0) },
        citationNumber: 2,
        firstOccurrence: { sectionId: ids.section, sectionItemId: ids.claimItem, placementId: ids.placement, claimRevisionId: ids.revision },
      },
    ],
    warnings: [],
    counts: { sectionCount: 1, activeItemCount: 2, proseBlockCount: 1, claimItemCount: 1, placedClaimCount: 1, unsupportedPlacedClaimCount: 0, supersededPlacedClaimCount: 0, withdrawnParentClaimCount: 0, distinctCitationCandidatePaperCount: 2 },
  };
}

describe("manuscript formatting projection", () => {
  it("keeps canonical numbers while allowing formatter bibliography ordering", () => {
    const projection = buildFormattedManuscript(view());
    expect(projection.bibliography.map((entry) => [entry.paperId, entry.citationNumber])).toEqual([[ids.paperA, 1], [ids.paperB, 2]]);
    expect(projection.manuscript.citationStyle).toBe("author_year");
  });

  it("renders unsupported claims without a visible empty marker or trailing space", () => {
    const projection = buildFormattedManuscript(view());
    const claim = projection.sections[0].items[1];
    expect(claim.itemType === "claim" ? claim.renderedCitationMarker : "unexpected").toBe("");
    expect(serializeManuscriptMarkdown(projection)).toContain("Claim text\n\n## References");
  });

  it("preserves active item order and normalizes Markdown line endings", () => {
    const projection = buildFormattedManuscript(view());
    expect(serializeManuscriptMarkdown(projection)).toBe("# Exact draft\n\n## Introduction\n\nProse\nkept exactly.\n\nClaim text\n\n## References\n\n- Alice Smith (2024). Zeta. Venue\n\n- Bob Jones (2024). Alpha. Venue\n");
  });
});
