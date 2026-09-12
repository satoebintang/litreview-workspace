import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

const fixture = readFileSync(path.join(process.cwd(), "tests", "fixtures", "slice15", "native-text-unicode-2page.pdf"));

test.describe("Slice 15 immutable PDF text extraction", () => {
  test("extracts page text and records exact code-point Evidence", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Text extraction review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);

    await page.getByLabel("Title", { exact: true }).fill("Native text study");
    await page.getByLabel("Abstract").fill("Deterministic parser fixture");
    await page.getByRole("button", { name: "Add paper" }).click();
    const documentsLink = page.getByRole("link", { name: "Documents" }).first();
    await documentsLink.click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/papers\/[0-9a-f-]+\/documents$/);
    const documentsUrl = page.url();
    const paperId = new URL(documentsUrl).pathname.match(/\/papers\/([^/]+)\/documents/)?.[1] ?? "";
    expect(paperId).toMatch(/^[0-9a-f-]+$/);

    await page.locator("input[type=file]").setInputFiles({ name: "native.pdf", mimeType: "application/pdf", buffer: fixture });
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByRole("status")).toHaveText("PDF document uploaded.");
    const documentHref = await page.getByRole("link", { name: "native.pdf" }).first().getAttribute("href");
    expect(documentHref).toBeTruthy();
    await page.goto(documentHref!);

    await page.getByRole("button", { name: "Extract text" }).click();
    await expect(page).toHaveURL(/\/extractions\/[0-9a-f-]+\?saved=extracted$/);
    await expect(page.getByRole("status")).toHaveText("Text extraction completed.");
    await expect(page.locator("pre").first()).toContainText("Slice 15 page one ASCII");
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();

    const firstPageText = await page.locator("pre").first().textContent();
    const phrase = "Slice 15 page one ASCII";
    const codePoints = Array.from(firstPageText ?? "");
    const phraseCodePoints = Array.from(phrase);
    const start = codePoints.findIndex((_, index) => phraseCodePoints.every((codePoint, offset) => codePoints[index + offset] === codePoint));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = start + Array.from(phrase).length;
    await page.getByLabel("Start offset").first().fill(String(start));
    await page.getByLabel("End offset (exclusive)").first().fill(String(end));
    await page.getByRole("button", { name: "Record exact Evidence" }).first().click();
    await expect(page.getByRole("status")).toHaveText("Evidence recorded from the exact extracted span.");

    await page.goto(documentHref!);
    await expect(page.getByText(/Extraction-grounded/)).toBeVisible();
    await page.getByRole("button", { name: "Extract text" }).click();
    await expect(page).toHaveURL(/\/extractions\/[0-9a-f-]+\?saved=extracted$/);
    await page.goto(documentHref!);
    await expect(page.getByRole("link", { name: /Run 2/ })).toBeVisible();
    await page.getByRole("button", { name: "Archive artifact" }).click();
    await expect(page.getByText(/historical Evidence remains available/)).toBeVisible();
    await page.goto(documentHref!);
    await expect(page.getByText(/Extraction-grounded/)).toBeVisible();
  });
});
