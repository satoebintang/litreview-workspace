import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { createPlaywrightTestDatabaseClient, resolvePlaywrightTestDatabaseUrl } from "./playwright-database";
import { addManualPaper } from "./manual-paper";

test("pages the canonical Paper collection and keeps creation and BibTeX export complete", async ({ page }) => {
  test.setTimeout(180_000);
  const unique = Date.now();
  await page.goto("/");
  await page.getByLabel("Project title").fill(`Slice 42 Paper collection ${unique}`);
  await page.getByRole("button", { name: /Create project/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = new URL(page.url()).pathname.split("/").pop()!;

  const testDatabase = createDb(resolvePlaywrightTestDatabaseUrl());
  const services = createReviewServices(testDatabase.db);
  const seedClient = createPlaywrightTestDatabaseClient({ prepare: false });
  try {
    const seeded = await seedClient`
      insert into papers (project_id, title, authors, abstract, bibliographic_note, created_at, updated_at)
      select ${projectId}::uuid,
        'Slice 42 Collection Paper ' || series::text || ' ' || ${unique}::text,
        array['Collection Author ' || series::text],
        'private abstract fixture', 'private bibliographic note fixture',
        case when series=51 then '2026-01-02T00:00:00Z'::timestamptz else '2026-01-01T00:00:00Z'::timestamptz end,
        case when series=51 then '2026-01-02T00:00:00Z'::timestamptz else '2026-01-01T00:00:00Z'::timestamptz end
      from generate_series(1, 51) as series
      returning id, title
    ` as Array<{ id: string; title: string }>;
    const selected = seeded.find((paper) => paper.title.includes("Collection Paper 51"));
    expect(selected).toBeTruthy();
    await services.recordScreeningDecision(projectId, selected!.id, { decision: "include" });

    await page.goto(`/projects/${projectId}/papers?page=1`);
    await expect(page.getByText("51 Papers", { exact: true })).toBeVisible();
    await expect(page.getByText("1–50 of 51", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(50);
    const selectedItem = page.locator(".item-list .item").filter({ hasText: selected!.title });
    await expect(selectedItem.getByText("included", { exact: true })).toBeVisible();
    await expect(selectedItem.getByRole("link", { name: selected!.title })).toHaveAttribute("href", `/projects/${projectId}/papers/${selected!.id}/documents`);
    await expect(selectedItem.getByRole("link", { name: "Screen" })).toHaveAttribute("href", `/projects/${projectId}/screening/${selected!.id}`);

    const pagination = page.getByRole("navigation", { name: "Paper collection pagination" });
    await expect(pagination.getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
    await expect(pagination.locator('[aria-disabled="true"]')).toHaveText("Previous");
    const next = pagination.getByRole("link", { name: "Next page" });
    await expect(next).toHaveAttribute("href", `/projects/${projectId}/papers?page=2`);
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/projects/${projectId}/papers?page=2`);
    await expect(page.getByText("51–51 of 51", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(1);
    await expect(pagination.getByText("Page 2 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
    await expect(pagination.locator('[aria-disabled="true"]')).toHaveText("Next");
    await pagination.getByRole("link", { name: "Previous page" }).click();
    await expect(page).toHaveURL(`/projects/${projectId}/papers`);

    const exportResponse = await page.request.get(`/projects/${projectId}/papers/export`);
    expect(exportResponse.ok()).toBe(true);
    expect(await exportResponse.text()).toContain("Slice 42 Collection Paper 51");

    const newTitle = `Slice 42 newly created Paper ${unique}`;
    const form = page.getByTestId("manual-paper-form");
    await form.getByLabel("Title", { exact: true }).fill(newTitle);
    await addManualPaper(page);
    await expect(page).toHaveURL(`/projects/${projectId}/papers`);
    await expect(page.locator(".item-list .item").first().getByRole("link", { name: newTitle })).toBeVisible();
    await expect(page.getByText("1–50 of 52", { exact: true })).toBeVisible();
  } finally {
    await seedClient.end();
    await testDatabase.client.end();
  }
});
