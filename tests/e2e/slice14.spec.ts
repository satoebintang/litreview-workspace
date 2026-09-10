import { test, expect } from "@playwright/test";

test.describe("Slice 14 full-text document workflow", () => {
  test("keeps active duplicate detection and archived Evidence provenance exact", async ({ page }) => {
    test.setTimeout(120_000);
    const pdf = { name: "study.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nE2E immutable bytes\n") };
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Documents review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByLabel("Title", { exact: true }).fill("Document study");
    await page.getByLabel("Abstract").fill("Document study abstract");
    await page.getByRole("button", { name: "Add paper" }).click();
    const documentsLink = page.getByRole("link", { name: "Documents" }).first();
    await expect(documentsLink).toBeVisible();
    await documentsLink.click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/papers\/[0-9a-f-]+\/documents$/);
    const documentsUrl = page.url();
    const paperId = new URL(documentsUrl).pathname.match(/\/papers\/([^/]+)\/documents/)?.[1] ?? "";
    expect(paperId).toMatch(/^[0-9a-f-]+$/);

    await page.locator("input[type=file]").setInputFiles(pdf);
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByRole("status")).toHaveText("PDF document uploaded.");
    const firstDocumentLink = page.getByRole("link", { name: "study.pdf" }).first();
    await expect(firstDocumentLink).toBeVisible();
    const firstDocumentUrl = await firstDocumentLink.getAttribute("href");
    expect(firstDocumentUrl).toBeTruthy();

    await page.locator("input[type=file]").setInputFiles(pdf);
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByRole("status")).toHaveText("Duplicate active bytes detected; the existing artifact was kept.");
    await expect(page.getByText("1 document", { exact: false })).toBeVisible();

    await page.goto(firstDocumentUrl!);
    await page.getByLabel("Verbatim source passage").fill("Historical passage from the first artifact");
    await page.getByLabel("Page number").fill("2");
    await page.getByRole("button", { name: "Record Evidence" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?saved=evidence`));
    await page.goto(documentsUrl);
    await page.getByRole("button", { name: "Archive artifact" }).click();
    await expect(page.getByRole("status")).toHaveText("Document archived; its historical Evidence remains available.");
    await page.locator("input[type=file]").setInputFiles(pdf);
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByRole("status")).toHaveText("PDF document uploaded.");
    await expect(page.getByText("2 documents", { exact: false })).toBeVisible();

    const documentLinks = page.getByRole("link", { name: "study.pdf" });
    await expect(documentLinks).toHaveCount(2);
    const secondDocumentUrl = await documentLinks.first().getAttribute("href");
    expect(secondDocumentUrl).toBeTruthy();

    await page.goto(firstDocumentUrl!);
    await expect(page.getByText(/new Evidence must use an active document/)).toBeVisible();
    await expect(page.getByText("Historical passage from the first artifact")).toBeVisible();
    await page.goto(secondDocumentUrl!);
    await page.getByLabel("Verbatim source passage").fill("A new passage from the reattached artifact");
    await page.getByLabel("Page number").fill("3");
    await page.getByRole("button", { name: "Record Evidence" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?saved=evidence`));
    await expect(page.getByText(/^Document artifact:/).first()).toBeVisible();
  });
});
