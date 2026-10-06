import { test, expect } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { selectEvidencePaper } from "./evidence-paper-picker";

test.describe("Slice 7 manuscript workspace", () => {
  test("composes mixed prose and exact ClaimRevisions with unified citation order", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Manuscript review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
      const projectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/papers`);

    for (const [title, passage] of [["First study", "First study supports the claim."], ["Second study", "Second study supports the claim."]] as const) {
      await page.goto(`/projects/${projectId}/papers`);
      await page.getByLabel("Title", { exact: true }).fill(title);
      await addManualPaper(page);
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
      await page.goto(`/projects/${projectId}/evidence`);
      await selectEvidencePaper(page, title, page.getByRole("region", { name: "Record Evidence" }));
      await page.getByLabel("Verbatim source passage").fill(passage);
      await page.getByLabel("Page number", { exact: true }).fill("1");
      await page.getByRole("button", { name: "Record evidence" }).click();
      await expect(page.getByText(passage, { exact: false })).toBeVisible();
    }

    const claims = [
      ["First claim", "First study supports the claim."],
      ["Second claim", "Second study supports the claim."],
    ] as const;
    const claimIds: string[] = [];
    for (const [claimText, passage] of claims) {
      await page.goto(`/projects/${projectId}/claims`);
      await page.getByLabel("Claim text").fill(claimText);
      await page.getByRole("button", { name: "Create unsupported claim" }).click();
      await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+\?saved=created$/);
      const option = page.locator("#link-evidence option").filter({ hasText: passage }).first();
      await page.getByLabel("Evidence passage").selectOption(await option.getAttribute("value") as string);
      await page.getByRole("button", { name: "Link evidence" }).click();
      await expect(page.getByText("supported", { exact: true })).toBeVisible();
      const claimId = new URL(page.url()).pathname.split("/").pop()!;
      claimIds.push(claimId);
      if (claimText === "First claim") {
        await page.getByLabel("Claim text").fill("First claim revised");
        await page.getByRole("button", { name: "Save new Claim revision" }).click();
        await expect(page).toHaveURL(/saved=revised$/);
      }
    }

    await page.goto(`/projects/${projectId}/claims`);
    await page.getByLabel("Claim text").fill("Withdrawn parent candidate");
    await page.getByRole("button", { name: "Create unsupported claim" }).click();
    await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+\?saved=created$/);
    await page.getByRole("button", { name: "Withdraw Claim" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw Claim" }).click();
    await expect(page).toHaveURL(/saved=withdrawn$/);

    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByRole("button", { name: "Start manuscript" }).click();
    await expect(page.getByLabel("Section title")).toBeVisible();
    await page.getByLabel("Section title").fill("Introduction");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Introduction" })).toBeVisible();
    await page.getByLabel("Section title").fill("Discussion");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Introduction" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Discussion" })).toBeVisible();

    await expect(page.getByLabel("Finalized active ClaimRevision")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Browse ClaimRevisions" })).toHaveCount(2);
    await page.getByRole("link", { name: "Browse ClaimRevisions" }).nth(0).click();
    await expect(page).toHaveURL(/\/manuscript\/claim-revisions\?sectionId=/);
    const introRoute = new URL(page.url());
    const validSectionId = introRoute.searchParams.get("sectionId");
    expect(validSectionId).toBeTruthy();
    const malformedPlacementProject = await page.request.get(`/projects/not-a-uuid/manuscript/claim-revisions?sectionId=${validSectionId}`);
    expect(malformedPlacementProject.status()).toBe(404);
    const malformedSectionRoute = await page.request.get(`${introRoute.pathname}?sectionId=not-a-uuid`);
    expect(malformedSectionRoute.status()).toBe(404);
    await page.goto(`${introRoute.pathname}?sectionId=${introRoute.searchParams.get("sectionId")}&pageSize=1`);
    const introNextHref = await page.getByRole("link", { name: "Next ClaimRevision page" }).getAttribute("href");
    expect(introNextHref).toBeTruthy();
    const seenCandidateIds = new Set<string>();
    let sawCurrentSecondCandidate = false;
    let sawCurrentFirstCandidate = false;
    let historicalFirstCandidatePage: string | null = null;
    for (;;) {
      const candidateCards = page.locator("article.card.item");
      for (let index = 0; index < await candidateCards.count(); index += 1) {
        const candidate = candidateCards.nth(index);
        const candidateId = await candidate.getAttribute("data-claim-revision-id");
        expect(candidateId).toBeTruthy();
        expect(seenCandidateIds.has(candidateId!)).toBe(false);
        seenCandidateIds.add(candidateId!);
        const preview = await candidate.locator("p").innerText();
        const annotation = await candidate.locator(".item-meta").innerText();
        if (preview === "Second claim" && annotation.startsWith("Current revision")) sawCurrentSecondCandidate = true;
        if (preview === "First claim revised" && annotation.startsWith("Current revision")) sawCurrentFirstCandidate = true;
        if (preview === "First claim" && annotation.startsWith("Historical revision")) historicalFirstCandidatePage = page.url();
      }
      await expect(page.getByText("Withdrawn parent candidate", { exact: true })).toHaveCount(0);
      const nextCandidatePage = page.getByRole("link", { name: "Next ClaimRevision page" });
      if (await nextCandidatePage.count() === 0) break;
      const previousPageUrl = page.url();
      const nextCandidateHref = await nextCandidatePage.getAttribute("href");
      expect(nextCandidateHref).toBeTruthy();
      await nextCandidatePage.click();
      await expect(page).toHaveURL(new URL(nextCandidateHref!, previousPageUrl).toString());
      expect(page.url()).not.toBe(previousPageUrl);
    }
    expect(seenCandidateIds.size).toBeGreaterThan(1);
    expect(sawCurrentSecondCandidate).toBe(true);
    expect(sawCurrentFirstCandidate).toBe(true);
    expect(historicalFirstCandidatePage).toBeTruthy();
    await page.goto(historicalFirstCandidatePage!);
    await expect(page.locator("article.card.item").filter({ hasText: "First claim" })).toBeVisible();
    await page.getByRole("button", { name: "Place this revision" }).click();
    await expect(page.getByText("First claim", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse replacements" })).toBeVisible();
    const replacementLink = page.getByRole("link", { name: "Browse replacements" });
    const replacementHref = await replacementLink.getAttribute("href");
    expect(replacementHref).toBeTruthy();
    const replacementRoute = new URL(replacementHref!, "http://127.0.0.1:3000");
    const placementId = replacementRoute.pathname.split("/").at(-2);
    expect(placementId).toBeTruthy();
    const malformedReplacementProject = await page.request.get(`/projects/not-a-uuid/manuscript/placements/${placementId}/replacements`);
    expect(malformedReplacementProject.status()).toBe(404);
    const malformedPlacementRoute = await page.request.get(`/projects/${projectId}/manuscript/placements/not-a-uuid/replacements`);
    expect(malformedPlacementRoute.status()).toBe(404);
    await replacementLink.click();
    await expect(page).toHaveURL(/\/manuscript\/placements\/[0-9a-f-]+\/replacements$/);
    await expect(page.getByText("First claim revised", { exact: true })).toBeVisible();
    const staleReplacementPage = page;
    const freshReplacementPage = await page.context().newPage();
    await freshReplacementPage.goto(replacementHref!);
    await expect(freshReplacementPage.getByText("First claim revised", { exact: true })).toBeVisible();
    const currentReplacementCandidate = freshReplacementPage.locator("article.card.item").filter({ hasText: "Current revision" });
    await expect(currentReplacementCandidate).toHaveCount(1);
    await currentReplacementCandidate.getByRole("button", { name: "Replace with this revision" }).click();
    await expect(freshReplacementPage).toHaveURL(/\/manuscript\?saved=replaced$/);
    await expect(freshReplacementPage.getByText("First claim revised", { exact: true }).first()).toBeVisible();
    const staleCurrentReplacementCandidate = staleReplacementPage.locator("article.card.item").filter({ hasText: "Current revision" });
    await expect(staleCurrentReplacementCandidate).toHaveCount(1);
    await staleCurrentReplacementCandidate.getByRole("button", { name: "Replace with this revision" }).click();
    await expect(staleReplacementPage).toHaveURL(/\/manuscript\?error=/);
    await expect(staleReplacementPage.getByRole("alert").filter({ hasText: "Placement changed while replacement was being prepared" })).toContainText("Placement changed while replacement was being prepared");
    await freshReplacementPage.close();

    const discussionBrowseHref = await page.getByRole("link", { name: "Browse ClaimRevisions" }).nth(1).getAttribute("href");
    expect(introNextHref).toBeTruthy();
    expect(discussionBrowseHref).toBeTruthy();
    const introCursor = new URL(introNextHref!, "http://127.0.0.1:3000").searchParams.get("cursor");
    expect(introCursor).toBeTruthy();
    const crossScopeRoute = new URL(discussionBrowseHref!, "http://127.0.0.1:3000");
    crossScopeRoute.searchParams.set("pageSize", "1");
    crossScopeRoute.searchParams.set("cursor", introCursor!);
    const crossScopeResponse = await page.goto(`${crossScopeRoute.pathname}${crossScopeRoute.search}`);
    expect(crossScopeResponse?.status()).toBe(404);
    await page.goto(`/projects/${projectId}/manuscript`);

    await page.getByRole("link", { name: "Browse ClaimRevisions" }).nth(1).click();
    await expect(page).toHaveURL(/\/manuscript\/claim-revisions\?sectionId=/);
    const discussionCandidate = page.locator("article.card.item").filter({ hasText: "Second claim" }).filter({ hasText: "Current revision" });
    await expect(discussionCandidate).toHaveCount(1);
    await discussionCandidate.getByRole("button", { name: "Place this revision" }).click();
    await expect(page).toHaveURL(/\/manuscript\?saved=placed$/);
    await expect(page.locator('[data-item-type="claim"]').filter({ hasText: "Second claim" })).toBeVisible();
    const invalidResponse = await page.goto(`${replacementHref!}?cursor=invalid`);
    expect(invalidResponse?.status()).toBe(404);
    await page.goto(`/projects/${projectId}/manuscript`);

    await expect(page.getByRole("heading", { name: "Bibliography candidates" })).toBeVisible();
    await expect(page.getByText("First study", { exact: true })).toBeVisible();
    await expect(page.getByText("Second study", { exact: true })).toBeVisible();
    await expect(page.getByText("Paper-ID deduplicated · derived order")).toBeVisible();
    await expect(page.getByText(/citation numbers: \[1\]/)).toBeVisible();
    await expect(page.getByText(/citation numbers: \[2\]/)).toBeVisible();

    await expect(page.getByLabel("Citation style")).toHaveValue("numeric");
    await page.getByLabel("Citation style").selectOption("author_year");
    await page.getByRole("button", { name: "Apply style" }).click();
    await expect(page.getByText("(First study, n.d.)", { exact: true })).toBeVisible();
    await expect(page.getByText("(Second study, n.d.)", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Warnings" })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export Markdown" }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let markdown = "";
    if (stream) for await (const chunk of stream) markdown += chunk.toString();
    expect(markdown).toContain("# Manuscript");
    expect(markdown).toContain("First claim revised (First study, n.d.)");
    expect(markdown).toContain("- First study (n.d.)");

    await page.getByLabel("Citation style").selectOption("numeric");
    await page.getByRole("button", { name: "Apply style" }).click();
    await expect(page.getByText("(First study, n.d.)", { exact: true })).not.toBeVisible();
    const bibliography = page.locator("section").filter({ has: page.getByRole("heading", { name: "Bibliography candidates", exact: true }) });
    await expect(bibliography.getByText("[1]", { exact: true })).toBeVisible();

    // Prose is plain text and can be interleaved with existing Claim items.
    const introProse = page.getByLabel("New prose for Introduction");
    await introProse.fill("Opening context.\n\nWith intentional whitespace.");
    await page.getByRole("button", { name: "+ Add prose" }).first().click();
    await expect(page.getByText(/Prose block · position \d+ · Revision 1/)).toBeVisible();
    const proseEditor = page.getByLabel("Edit prose block 1");
    await proseEditor.fill("Edited opening context.\nStill plain text.");
    await page.getByRole("button", { name: "Save prose" }).click();
    await expect(page.getByText("Edited opening context.", { exact: false })).toBeVisible();

    // The mixed-order controls submit the complete active item set.
    await page.locator('button:not([disabled])').filter({ hasText: "↑" }).last().click();
    await expect(page.getByText(/citation numbers: \[1\]/)).toBeVisible();

    await expect(page.getByRole("button", { name: "Reverse section order" })).toBeVisible();
  });
});
