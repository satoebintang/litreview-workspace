import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("Slice 47 synthesis preparation route contracts", () => {
  const ledger = source("src/app/projects/[projectId]/synthesis/preparations/page.tsx");
  const workspace = source("src/app/projects/[projectId]/synthesis/preparations/[preparationId]/page.tsx");
  const candidate = source("src/app/projects/[projectId]/synthesis/preparations/[preparationId]/candidates/[extractionRevisionId]/page.tsx");
  const aiDetail = source("src/app/projects/[projectId]/synthesis/preparations/[preparationId]/ai-requests/[requestId]/page.tsx");
  const synthesisActions = source("src/app/actions/synthesis.ts");
  const aiActions = source("src/app/actions/ai-synthesis.ts");

  it("uses bounded preparation reads on the ledger and exact detail", () => {
    expect(ledger).toContain("listSynthesisPreparationLedger");
    expect(ledger).not.toContain("listSynthesisPreparations(");
    expect(ledger).toContain("pageSize: 50");
    expect(ledger).toContain("prep.sourceSetChanged");
    expect(ledger).not.toContain("statusFilter");
    expect(workspace).toContain("getSynthesisPreparationHeader");
    expect(workspace).toContain("listSynthesisPreparationCandidates");
    expect(workspace).toContain("pageSize: 50");
    expect(workspace).toContain("candidate.connectingEvidenceCount");
    expect(workspace).toContain("candidate.directEvidenceCount");
    expect(workspace).toContain("listAiSynthesisSuggestionHistoryPage");
    expect(workspace).toContain("pageSize: 25");
    expect(workspace).not.toContain("getSynthesisPreparationWorkspace(");
    expect(workspace).not.toContain("listProjectSynthesis(");
    expect(workspace).not.toContain("listAiSynthesisSuggestions(");
    expect(workspace).not.toContain("Promise.all(");
  });

  it("keeps selection intents one-item and provides exact candidate provenance", () => {
    expect(workspace).toContain("selectSynthesisPreparationRevisionAction");
    expect(workspace).toContain("deselectSynthesisPreparationRevisionAction");
    expect(workspace).toContain("candidateCursor: null");
    expect(workspace).toContain("returnCandidateCursor");
    expect(workspace).not.toContain("replaceSynthesisPreparationSelectionsAction");
    expect(workspace).not.toContain("extractionRevisionIds");
    expect(synthesisActions).toContain("selectSynthesisPreparationRevision(projectId, preparationId");
    expect(synthesisActions).toContain("deselectSynthesisPreparationRevision(projectId, preparationId");
    expect(candidate).toContain("getSynthesisPreparationCandidate(projectId, preparationId, extractionRevisionId)");
    expect(candidate).not.toContain("getSynthesisPreparationHeader");
    expect(candidate).toContain("candidate.connectingEvidenceCount");
    expect(candidate).toContain("candidate.directEvidenceCount");
    expect(candidate).toContain("returnCandidateFilter");
    expect(candidate).toContain("listSynthesisPreparationConnectingEvidence");
    expect(candidate).toContain("listSynthesisPreparationDirectEvidence");
    expect(candidate).toContain("pageSize: 25");
    expect(candidate).not.toContain("resolveEvidenceSetCompositionRevisionMembers(");
  });

  it("loads target options only after explicit Browse/Search and binds AI detail to its nested preparation", () => {
    expect(workspace).toContain("const targetBrowse = query.targetBrowse === \"1\"");
    expect(workspace).toContain("if (targetBrowse)");
    expect(workspace).toContain("listSynthesisTargetStatementOptions");
    expect(aiDetail).toContain("getAiSynthesisSuggestion(requestId, projectId, preparationId)");
    expect(aiActions).toContain("executeAiSynthesisSuggestion(requestId, projectId, preparationId)");
    expect(aiActions).toContain("expireAiSynthesisSuggestion(requestId, projectId, preparationId)");
    expect(aiActions).toContain("rejectAiSynthesisSuggestion(projectId, requestId, preparationId)");
    expect(aiActions).toContain("preparationId,");
  });
});
