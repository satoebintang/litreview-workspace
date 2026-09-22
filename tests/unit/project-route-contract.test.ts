import { describe, expect, it } from "vitest";
import {
  getProjectBreadcrumbs,
  matchProjectRoute,
  projectPrimaryHref,
  PROJECT_PRIMARY_ROUTES,
} from "@/app/projects/route-contract";

const projectId = "project-123";

describe("project route contract", () => {
  it("keeps the exact primary workspace hrefs", () => {
    expect(PROJECT_PRIMARY_ROUTES.map((route) => projectPrimaryHref(projectId, route.key))).toEqual([
      "/projects/project-123",
      "/projects/project-123/protocol",
      "/projects/project-123/papers",
      "/projects/project-123/screening",
      "/projects/project-123/extraction",
      "/projects/project-123/synthesis",
      "/projects/project-123/manuscript",
      "/projects/project-123/review-flow",
    ]);
  });

  it("uses the most-specific workflow mapping", () => {
    const cases: Array<[string, string]> = [
      [`/projects/${projectId}`, "overview"],
      [`/projects/${projectId}/protocol`, "plan"],
      [`/projects/${projectId}/research-questions`, "plan"],
      [`/projects/${projectId}/research-questions/q1`, "plan"],
      [`/projects/${projectId}/research-questions/q1/answers/a1`, "synthesize"],
      [`/projects/${projectId}/research-questions/q1/answers/a1/manuscript`, "write"],
      [`/projects/${projectId}/papers`, "papers"],
      [`/projects/${projectId}/papers/p1/documents/d1/extractions/e1`, "extract"],
      [`/projects/${projectId}/papers/doi-intake/r1`, "papers"],
      [`/projects/${projectId}/papers/imports/i1`, "papers"],
      [`/projects/${projectId}/papers/pdf-intake/p1`, "papers"],
      [`/projects/${projectId}/screening/full-text/retrieval`, "screen"],
      [`/projects/${projectId}/deduplication`, "screen"],
      [`/projects/${projectId}/extraction/batches/b1`, "extract"],
      [`/projects/${projectId}/evidence`, "extract"],
      [`/projects/${projectId}/evidence-sets`, "synthesize"],
      [`/projects/${projectId}/claims/c1`, "synthesize"],
      [`/projects/${projectId}/synthesis/preparations/p1`, "synthesize"],
      [`/projects/${projectId}/manuscript/review`, "write"],
      [`/projects/${projectId}/review-flow`, "reports"],
      [`/projects/${projectId}/review-report`, "reports"],
    ];
    for (const [path, key] of cases) expect(matchProjectRoute(path, projectId)?.key, path).toBe(key);
    expect(matchProjectRoute(`/projects/${projectId}/papers/imports/i1?tab=history#latest`, projectId)?.key).toBe("papers");
    expect(matchProjectRoute(`/projects/other/papers`, projectId)).toBeNull();
  });

  it("builds breadcrumbs from the same matched primary route", () => {
    expect(getProjectBreadcrumbs(projectId, `/projects/${projectId}/research-questions/q1/answers/a1/manuscript`, "My review")).toEqual([
      { label: "Projects", href: "/", current: false },
      { label: "My review", href: `/projects/${projectId}`, current: false },
      { label: "Write", current: false, href: `/projects/${projectId}/manuscript` },
      { label: "Answer", current: false },
      { label: "Manuscript drafting", current: true },
    ]);
    const breadcrumbs = getProjectBreadcrumbs(projectId, `/projects/${projectId}/papers/p1/documents/d1/extractions/e1`, "My review");
    expect(breadcrumbs.map((crumb) => crumb.label)).toEqual(["Projects", "My review", "Extract", "Paper", "Text extraction"]);
    expect(breadcrumbs.every((crumb) => !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(crumb.label))).toBe(true);
  });
});
