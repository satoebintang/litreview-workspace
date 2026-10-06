import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");
const manuscriptPage = source("src/app/projects/[projectId]/manuscript/page.tsx");
const placementPage = source("src/app/projects/[projectId]/manuscript/claim-revisions/page.tsx");
const replacementPage = source("src/app/projects/[projectId]/manuscript/placements/[placementId]/replacements/page.tsx");
const reads = source("src/application/manuscript-claim-selection-read-services.ts");
const cursor = source("src/application/manuscript-claim-selection-cursor.ts");

describe("Slice 54 manuscript ClaimRevision route contracts", () => {
  it("keeps the normal manuscript route free of global candidate reads and revision dropdowns", () => {
    expect(manuscriptPage).not.toContain("listPlaceableClaimRevisions");
    expect(manuscriptPage).not.toContain("claims.map(");
    expect(manuscriptPage).not.toContain("claims.filter(");
    expect(manuscriptPage).not.toContain("claims.some(");
    expect(manuscriptPage).not.toContain("replacePlacedClaimRevisionAction");
    expect(manuscriptPage).toContain("Browse ClaimRevisions");
    expect(manuscriptPage).toContain("Browse replacements");
    expect(manuscriptPage).toContain('placement.claimLifecycle === "active"');
    expect(manuscriptPage).toContain("placement.claimLifecycle === \"withdrawn\"");
  });

  it("loads one page per browse request and posts server-bound identities to the existing actions", () => {
    expect((placementPage.match(/getPlacementClaimRevisionPage\(/g) ?? [])).toHaveLength(1);
    expect((replacementPage.match(/getPlacementReplacementClaimRevisionPage\(/g) ?? [])).toHaveLength(1);
    expect(placementPage).toContain("placeClaimRevisionAction");
    expect(replacementPage).toContain("replacePlacedClaimRevisionAction");
    expect(replacementPage).toContain("expectedCurrentClaimRevisionId");
    expect(replacementPage).not.toContain('name="claimId"');
    expect(replacementPage).not.toContain('name="placedSequence"');
    expect(replacementPage).not.toContain("listPlaceableClaimRevisions");
  });

  it("limits key selection before preview hydration and retains mixed-order continuation", () => {
    expect(reads).toMatch(/page_keys as materialized/i);
    expect(reads).toMatch(/visible_keys as materialized/i);
    expect(reads).toMatch(/from visible_keys visible[\s\S]*?join claim_revisions revision/i);
    expect(reads).toMatch(/left\(revision\.claim_text, 600\)/i);
    expect(reads).toMatch(/char_length\(revision\.claim_text\) > 600/i);
    expect(reads).toMatch(/left\(m\.title, 600\) as manuscript_title/i);
    expect(reads).toMatch(/left\(s\.title, 600\) as section_title/i);
    expect(reads).toMatch(/left\(section\.title, 600\) as section_title/i);
    expect(reads).toMatch(/r\.sequence=\$\{sequence\}::bigint and r\.id>\$\{id\}::uuid/i);
    expect(reads).toMatch(/r\.sequence<\$\{sequence\}::bigint/i);
    expect(reads).not.toMatch(/\(r\.sequence,\s*r\.id\)\s*</i);
    expect(reads).not.toMatch(/supportStatus|supportKinds|provenance/i);
    expect(cursor).toContain("MANUSCRIPT_CLAIM_SELECTION_MAX_PAGE_SIZE = 50");
    expect(cursor).toContain("MANUSCRIPT_CLAIM_SELECTION_CURSOR_MAX_LENGTH = 512");
  });
});
