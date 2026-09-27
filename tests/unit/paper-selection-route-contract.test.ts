import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routeFiles = [
  "src/app/projects/[projectId]/deduplication/[leftRecordId]/[rightRecordId]/page.tsx",
  "src/app/projects/[projectId]/papers/pdf-intake/[intakeId]/page.tsx",
  "src/app/projects/[projectId]/protocol/runs/[runId]/page.tsx",
  "src/app/projects/[projectId]/papers/imports/[importId]/page.tsx",
];

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Slice 43 Paper selection route query guards", () => {
  it("keeps all migrated interactive routes free of the project-wide Paper reader", () => {
    for (const path of routeFiles) {
      expect(source(path), path).not.toContain("listPapers");
    }
  });

  it("keeps ordinary unresolved bibliographic choices candidate-restricted", () => {
    const importPage = source(routeFiles[3]);
    expect(importPage).toMatch(/resolution\?\.eventType === "cleared"\s*\?\s*<PaperPicker/);
    expect(importPage).toMatch(/: <div className="field"><label htmlFor=\{`paper-\$\{record\.id\}`\}>Candidate Paper<\/label><select[\s\S]*?candidates\.map\(\(candidate\)/);
    expect(importPage).not.toMatch(/retargetOptions|projectPapers/);
  });

  it("keeps the legacy shared-mapping correction Project-wide, excludes the shared Paper, and requires a target", () => {
    const dedupPage = source(routeFiles[0]);
    expect(dedupPage).toMatch(/pair\.decision === "different_work" && samePaper[\s\S]*?<PaperPicker[\s\S]*?excludePaperId=\{samePaper\}[\s\S]*?required/);
  });

  it("preserves exact Project-scoped titles and the defensive fallback on protocol history", () => {
    const protocolPage = source(routeFiles[2]);
    expect(protocolPage).toContain("getPaperOptionsByIds(projectId, referencedPaperIds)");
    expect(protocolPage).toMatch(/paperById\.get\(event\.paperId\)\?\.title \?\? "Paper"/);
    expect(protocolPage).toMatch(/paperById\.get\(match\.paperId\)\?\.title \?\? "Paper"/);
  });
});
