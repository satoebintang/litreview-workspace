import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { createPlaywrightTestDatabaseClient, resolvePlaywrightTestDatabaseUrl } from "./playwright-database";
import { selectEvidencePaper } from "./evidence-paper-picker";

test.describe("Slice 39 Evidence workspace reads", () => {
  test("keeps Paper selections independent through failed capture, filtering, and pagination", async ({ page }) => {
    test.setTimeout(180_000);
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 39 Evidence reads ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const testDatabase = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(testDatabase.db);
    const seedClient = createPlaywrightTestDatabaseClient({ prepare: false });
    let capturePaperId = "";
    let filterPaperId = "";
    try {
      const capturePaper = await services.addPaper(projectId, { title: `Capture Paper ${unique}` });
      const filterPaper = await services.addPaper(projectId, { title: `Queue Paper ${unique}` });
      capturePaperId = capturePaper.id;
      filterPaperId = filterPaper.id;
      await seedClient`insert into evidence (project_id, paper_id, source_text, page_number)
        select ${projectId}::uuid, ${filterPaper.id}::uuid, 'Queue pagination fixture ' || n::text, n
        from generate_series(1, 51) as n`;
    } finally {
      await seedClient.end();
      await testDatabase.client.end();
    }

    await page.goto(`/projects/${projectId}/evidence`);
    const capture = page.getByRole("region", { name: "Record Evidence" });
    const capturePicker = capture.locator(".evidence-paper-picker");
    const captureSearch = capturePicker.getByRole("searchbox");
    await expect(captureSearch).toHaveAccessibleName("Search Papers for manual evidence capture");
    await captureSearch.fill(`Capture Paper ${unique}`);
    await captureSearch.press("Enter");
    const captureResult = capturePicker.locator(".claim-support-result-row").filter({ hasText: `Capture Paper ${unique}` });
    await expect(captureResult).toBeVisible();
    await expect(capturePicker.getByRole("status")).toContainText("showing 1–1 of 1 Papers");
    const captureSelect = captureResult.getByRole("button", { name: "Select", exact: true });
    await captureSelect.focus();
    await captureSelect.press("Enter");
    await expect(capture.locator('input[name="capturePaperId"]')).toHaveValue(capturePaperId);
    await expect(capture.locator(".evidence-paper-selection")).toContainText(`Selected Paper: Capture Paper ${unique}`);
    await expect(capture.getByRole("button", { name: "Record evidence" })).toBeEnabled();

    await capture.getByRole("button", { name: "Remove selected Paper" }).click();
    await expect(capture.locator('input[name="capturePaperId"]')).toHaveValue("");
    await expect(capture.getByRole("button", { name: "Record evidence" })).toBeDisabled();
    await captureResult.getByRole("button", { name: "Select", exact: true }).click();

    await capture.getByLabel("Verbatim source passage").fill("A rejected manual capture retains the chosen Paper.");
    await capture.getByLabel("Page number", { exact: true }).fill("0");
    await capture.locator("form").evaluate((form) => { (form as HTMLFormElement).noValidate = true; });
    await capture.getByRole("button", { name: "Record evidence" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/evidence\\?capturePaperId=${capturePaperId}.*error=`));
    const failureUrl = new URL(page.url());
    expect(failureUrl.searchParams.get("capturePaperId")).toBe(capturePaperId);
    expect(failureUrl.searchParams.has("paperId")).toBe(false);
    const restoredCapture = page.getByRole("region", { name: "Record Evidence" });
    await expect(restoredCapture.locator('input[name="capturePaperId"]')).toHaveValue(capturePaperId);
    await expect(restoredCapture.locator(".evidence-paper-selection")).toContainText(`Selected Paper: Capture Paper ${unique}`);

    const filters = page.getByRole("region", { name: "Filter Evidence" });
    await selectEvidencePaper(page, `Queue Paper ${unique}`, filters);
    await filters.getByLabel("Review state").selectOption("all");
    await filters.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/\/evidence\?/);
    let filteredUrl = new URL(page.url());
    expect(filteredUrl.searchParams.get("paperId")).toBe(filterPaperId);
    expect(filteredUrl.searchParams.get("capturePaperId")).toBe(capturePaperId);
    expect(filteredUrl.searchParams.has("page")).toBe(false);
    await expect(page.getByText("1–50 of 51", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(50);

    const pagination = page.getByRole("navigation", { name: "Evidence workspace pages" });
    await pagination.getByRole("link", { name: "Next" }).click();
    await expect(page.getByText("51–51 of 51", { exact: true })).toBeVisible();
    filteredUrl = new URL(page.url());
    expect(filteredUrl.searchParams.get("paperId")).toBe(filterPaperId);
    expect(filteredUrl.searchParams.get("capturePaperId")).toBe(capturePaperId);
    expect(filteredUrl.searchParams.get("page")).toBe("2");
    await expect(page.locator(".item-list .item")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Record Evidence" }).locator(".evidence-paper-selection")).toContainText(`Selected Paper: Capture Paper ${unique}`);
  });
});
