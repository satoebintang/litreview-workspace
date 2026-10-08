import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const paths = {
  worksheet: "src/application/extraction-worksheet-read-services.ts",
  history: "src/application/extraction-history-read-services.ts",
  historyPage: "src/app/projects/[projectId]/extraction/[paperId]/fields/[fieldId]/history/page.tsx",
  exactPage: "src/app/projects/[projectId]/extraction/[paperId]/fields/[fieldId]/revisions/[revisionId]/page.tsx",
  worksheetPage: "src/app/projects/[projectId]/extraction/[paperId]/page.tsx",
  worksheetClient: "src/app/projects/[projectId]/extraction/[paperId]/ExtractionWorksheet.tsx",
  revisionForm: "src/app/projects/[projectId]/extraction/[paperId]/ExtractionRevisionForm.tsx",
};

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Slice 53 extraction history route contracts", () => {
  it("keeps complete history and historical Evidence hydration out of the normal worksheet", () => {
    const worksheet = source(paths.worksheet);
    for (const forbidden of ["getExtractionValueHistory", "historyByFieldId", "history.at(-1)", "ExtractionRevisionRepository.list", "listForRevisions"]) {
      expect(worksheet).not.toContain(forbidden);
    }
    expect(worksheet).toContain("currentRevisionIds");
    expect(worksheet).toContain("link.revision_id in (");
    expect(worksheet).toContain("left(e.source_text, 1200)");
    expect(worksheet).toContain("left(e.note, 600)");
    expect(worksheet).toContain("order by r.sequence desc\n            limit 1");
    expect(worksheet).not.toMatch(/order by r\.sequence desc\s*,\s*r\.id/i);
  });

  it("keeps candidate browsing lazy and separate from the exact selected-support projection", () => {
    const worksheet = source(paths.worksheet);
    const page = source(paths.worksheetPage);
    const client = source(paths.worksheetClient);
    const form = source(paths.revisionForm);
    expect(worksheet).not.toContain("evidenceRepo.listForPaper");
    expect(worksheet).not.toContain("getPaperExtractionEvidenceCandidatePage");
    expect(page).not.toContain("extraction.evidence.map");
    expect(client).toContain("<ExtractionWorksheetEvidencePicker");
    expect(form).toContain('name="evidenceIds"');
  });

  it("selects stop-early history keys before visible-only hydration and Evidence counting", () => {
    const history = source(paths.history);
    expect(history).toContain("with page_keys as materialized");
    expect(history).toContain("order by r.sequence desc, r.id desc");
    expect(history).toContain("(r.sequence, r.id) < (${cursor.lastSequence}::bigint, ${cursor.lastRevisionId}::uuid)");
    expect(history).toContain("visible_page as materialized");
    expect(history).toContain("join visible_page visible on visible.id=link.revision_id");
    expect(history).toContain("left(revision.text_value, 448)");
    expect(history).toContain("left(revision.researcher_note, 192)");
    expect(history).toContain("left(option.label, 500)");
    expect(history).toContain("left(f.name, 500)");
    expect(history).not.toContain("count(*) as total_count");
  });

  it("binds exact reads through Project, Paper, Field, slot, and finalized revision", () => {
    const history = source(paths.history);
    expect(history).toContain("join papers paper on paper.project_id=p.id and paper.id=${paperId}::uuid");
    expect(history).toContain("join extraction_fields f on f.project_id=p.id and f.id=${fieldId}::uuid");
    expect(history).toContain("join extraction_values slot on slot.project_id=p.id and slot.paper_id=paper.id and slot.field_id=f.id");
    expect(history).toContain("revision.extraction_value_id=slot.id");
    expect(history).toContain("revision.id=${revisionId}::uuid and revision.finalized_at is not null");
    expect(history).toContain("order by item.page_number asc, item.created_at asc");
    expect(history).not.toMatch(/order by item\.page_number asc, item\.created_at asc, item\.id/i);
    expect(history).not.toContain("field.archived_at is null");
    expect(history).not.toContain("paper.final_eligibility");
    expect(source(paths.historyPage)).toContain("getExtractionFieldRevisionHistoryPage");
    expect(source(paths.exactPage)).toContain("getExtractionRevisionExact");
  });
});
