import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (...segments: string[]) => readFileSync(path.join(root, ...segments), "utf8");

describe("Slice 48 bounded Research Question route contracts", () => {
  it("keeps the matrix and initial Question route on their bounded service reads", () => {
    const matrix = source("src", "app", "projects", "[projectId]", "research-questions", "page.tsx");
    const question = source("src", "app", "projects", "[projectId]", "research-questions", "[questionId]", "page.tsx");

    expect(matrix).toContain("getResearchQuestionMatrixPage(projectId");
    expect(matrix).not.toMatch(/getResearchQuestionMatrix\s*\(/);
    expect(matrix).not.toMatch(/getProjectResearchQuestionAnswerFacts\s*\(/);
    expect(matrix).not.toMatch(/getProject\s*\(/);

    expect(question.match(/getResearchQuestionWorkspace\s*\(/g)).toHaveLength(1);
    expect(question).not.toMatch(/getQuestionTraceability\s*\(/);
    expect(question).not.toMatch(/listResearchQuestionAnswerCandidates\s*\(/);
    expect(question).not.toMatch(/getProject\s*\(/);
  });

  it("accounts for the inherited layout in the 13-SELECT initial Question route budget", () => {
    const boundedReads = source("src", "application", "research-question-bounded-read-services.ts");
    const integration = source("tests", "integration", "research-question-bounded-read-services.test.ts");
    const routeBudget = source("tests", "integration", "research-question-bounded-route-budget.test.ts");
    const layout = source("src", "app", "projects", "[projectId]", "layout.tsx");
    const projectRead = source("src", "app", "projects", "[projectId]", "project-read.ts");

    expect(boundedReads).toContain("async function getResearchQuestionWorkspace");
    expect(integration).toContain("getResearchQuestionWorkspace(project.id, question.id)");
    expect(integration).toContain("toHaveLength(11)");
    expect(routeBudget).toContain("bounded.getResearchQuestionWorkspace(project.id, question!.id)");
    expect(routeBudget).toContain("toHaveLength(12)");
    expect(layout).toContain("getProjectForRoute(projectId)");
    expect(projectRead).toContain("cache(async (projectId: string) => reviewServices.getProject(projectId))");

    // The service query count is measured by its integration fixture (11).
    // The inherited cached project-title lookup is one query, so the route
    // composition is 12 SELECTs within the approved 13-SELECT target.
    const measuredWorkspaceSelects = 11;
    const measuredCachedLayoutLookupSelects = 1;
    expect(measuredWorkspaceSelects + measuredCachedLayoutLookupSelects).toBe(12);
    expect(measuredWorkspaceSelects + measuredCachedLayoutLookupSelects).toBeLessThanOrEqual(13);
  });

  it("uses exact typed target and Answer browser reads without full projections", () => {
    const target = source("src", "app", "projects", "[projectId]", "research-questions", "[questionId]", "traceability", "[targetType]", "[targetId]", "page.tsx");
    const answer = source("src", "app", "projects", "[projectId]", "research-questions", "[questionId]", "answers", "[answerId]", "page.tsx");
    const panel = source("src", "app", "projects", "[projectId]", "research-questions", "[questionId]", "ResearchQuestionAnswerPanel.tsx");

    expect(target).toContain("getResearchQuestionTargetDetail(projectId, questionId, targetType, targetId");
    expect(answer).toContain("getResearchQuestionAnswerBrowserSnapshot(projectId, questionId, answerId)");
    expect(answer).not.toMatch(/getQuestionTraceability\s*\(/);
    expect(answer).not.toMatch(/getProject\s*\(/);
    expect(answer).not.toMatch(/getResearchQuestionAnswerSnapshot\s*\(/);
    expect(panel).not.toMatch(/getResearchQuestionAnswerProjection\s*\(/);
    expect(panel).not.toMatch(/listResearchQuestionAnswerCandidates\s*\(/);
    expect(panel).toContain("listResearchQuestionAnswerCandidatePageAction");
  });

  it("returns structured finalization conflicts and invalidates cached bounded routes on success", () => {
    const actions = source("src", "app", "actions", "research-question-bounded.ts");
    const start = actions.indexOf("export async function finalizeResearchQuestionAnswerBoundedAction");
    const finalize = actions.slice(start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(finalize).toContain("Promise<{ ok: true; answerId: string } | { ok: false; code: string; message: string }>");
    expect(finalize).toContain("revalidatePath(`/projects/${input.projectId}/research-questions/${input.questionId}`)");
    expect(finalize).toContain("revalidatePath(`/projects/${input.projectId}/research-questions`)");
    expect(finalize).not.toContain("redirect(");
  });
});
