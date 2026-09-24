import { expect, test } from "@playwright/test";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

test.describe("Slice 36 full-text queue pagination", () => {
  test("shows bounded ranges and resets page when queue state changes", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 36 pagination ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const client = createPlaywrightTestDatabaseClient({ prepare: false });
    try {
      await client.begin(async (tx) => {
        await tx`insert into papers (project_id, title)
          select ${projectId}::uuid, 'Slice 36 pagination fixture ' || n::text
          from generate_series(1, 55) as n`;
        await tx`insert into screening_decisions (project_id, paper_id, decision)
          select ${projectId}::uuid, p.id, 'include'
          from papers p
          where p.project_id=${projectId}::uuid
            and p.title like 'Slice 36 pagination fixture %'`;
      });
    } finally {
      await client.end();
    }

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval`);
    const retrievalPagination = page.getByRole("navigation", { name: "Full-text retrieval queue pagination" });
    await expect(page.getByText("1–50 of 55", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(50);
    await expect(retrievalPagination.getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
    await retrievalPagination.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(new RegExp(`/screening/full-text/retrieval\\?page=2$`));
    await expect(page.getByText("51–55 of 55", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(5);
    await expect(retrievalPagination.getByRole("link", { name: "Previous page" })).toBeVisible();
    await expect(retrievalPagination.getByText("Page 2 of 2", { exact: true })).toHaveAttribute("aria-current", "page");

    await page.locator(".screening-stat").filter({ hasText: "not sought" }).click();
    await expect(page).toHaveURL(new RegExp(`/screening/full-text/retrieval\\?state=not_sought$`));
    await expect(page.getByText("1–50 of 55", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Full-text retrieval queue pagination" }).getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto(`/projects/${projectId}/screening/full-text?state=invalid&page=2`);
    await expect(page.getByText("1–50 of 55", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Full-text queue pagination" }).getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
    await page.locator(".screening-stat").filter({ hasText: "awaiting" }).click();
    await expect(page).toHaveURL(new RegExp(`/screening/full-text\\?state=awaiting$`));
    await expect(page.getByText("1–50 of 55", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(50);
  });
});
