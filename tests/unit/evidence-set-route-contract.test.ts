import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const collectionPath = "src/app/projects/[projectId]/evidence-sets/page.tsx";
const detailPath = "src/app/projects/[projectId]/evidence-sets/[setId]/page.tsx";
const historyPath = "src/app/projects/[projectId]/evidence-sets/[setId]/history/[revisionId]/page.tsx";
const annotationPath = "src/app/projects/[projectId]/evidence-sets/[setId]/annotations/[annotationId]/page.tsx";
const evidencePath = "src/app/projects/[projectId]/evidence/[evidenceId]/page.tsx";
const readServicePath = "src/application/evidence-set-workspace-read-services.ts";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Slice 45 Evidence Set bounded route contract", () => {
  it("keeps collection, detail, history, annotation, and Evidence routes off full materializers", () => {
    for (const path of [collectionPath, detailPath, historyPath, annotationPath, evidencePath]) {
      const route = source(path);
      for (const forbidden of [
        "listEvidenceSets(", "getEvidenceSet(", "listCandidateEvidenceForSet(",
        "listEvidenceSetCompositionHistory(", "listEvidenceSetAnnotations(",
        "listRelatedExtractionRevisionsForEvidenceSet(", "listEvidenceSetSynthesisFields(",
      ]) expect(route, `${path} uses ${forbidden}`).not.toContain(forbidden);
    }
    expect(source(collectionPath)).toContain("listEvidenceSetCollectionPage");
    expect(source(detailPath)).toContain("listCurrentMembersPage");
    expect(source(detailPath)).toContain("listCompositionHistoryPage");
    expect(source(evidencePath)).toContain("listActiveEvidenceSetOptions");
    expect(source(evidencePath)).toContain("evidenceSets.totals.active");
  });

  it("gates candidate SQL behind explicit Browse/Search and removes full reorder controls", () => {
    const detail = source(detailPath);
    expect(detail).toContain('query.candidateBrowse === "1"');
    expect(detail).toMatch(/candidateBrowse \? readPage\(query\.candidateCursor,[\s\S]*?searchEvidenceSetCandidates/);
    expect(detail).toContain("expectedRevisionId: revisionId");
    expect(detail).toContain("moveEvidenceSetMembershipAction");
    expect(detail).toContain('name="membershipId"');
    expect(detail).toContain('name="direction" value="up"');
    expect(detail).toContain('name="direction" value="down"');
    expect(detail).not.toContain("EvidenceSetOrderForm");
    expect(detail).not.toContain("reorderEvidenceSetAction");
    expect(detail).toContain('name="expectedRevisionId"');
  });

  it("binds candidate and collection/selector cursors to their query and revision scope", () => {
    const reads = source(readServicePath);
    expect(reads).toContain('scope: "candidates", projectId, evidenceSetId, revisionId: expectedRevisionId');
    expect(reads).toContain("cursor.query !== query");
    expect(reads).toContain('scope: "collection", projectId');
    expect(reads).toContain('scope: "selector", projectId');
    expect(reads).toContain('scope: "historical-members"');
    expect(reads).toContain('scope: "history"');
  });

  it("projects fixed text caps in SQL and limits each composition page", () => {
    const reads = source(readServicePath);
    expect(reads).toContain("memberSourcePreview: 300");
    expect(reads).toContain("candidateExcerpt: 80");
    expect(reads).toContain("labelCount: 5");
    expect(reads).toContain("char_length(body)::integer as body_codepoint_length");
    expect(reads).toContain("left(e.source_text");
    expect(reads).toContain("left(p.title");
    expect(reads).toContain("left(f.name");
    expect(reads).toContain("left(a.body");
    expect(reads).toContain("EVIDENCE_SET_MEMBER_MAX_PAGE_SIZE = 100");
    expect(reads).toContain("EVIDENCE_SET_CANDIDATE_MAX_PAGE_SIZE = 50");
  });
});
