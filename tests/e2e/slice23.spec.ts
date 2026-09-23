import { test, expect } from "@playwright/test";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";


async function getTestDbClient() {
  return createPlaywrightTestDatabaseClient({ prepare: false });
}

test.describe("Slice 23 manuscript editorial review", () => {
  test("opens exact context, preserves lifecycle through edits, and isolates export", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const exactText = "  Opening wording.\n\nSecond line\t  ";
    // HTML form submission preserves the textarea value while representing
    // line breaks as CRLF in FormData; assert the exact persisted payload.
    const expectedPersistedText = exactText.replaceAll("\n", "\r\n");

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 23 review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByRole("button", { name: "Start manuscript" }).click();
    await expect(page.getByLabel("Section title")).toBeVisible();
    await page.getByLabel("Section title").fill("Discussion");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Discussion" })).toBeVisible();
    await page.getByLabel("New prose for Discussion").fill(exactText);
    await page.getByRole("button", { name: "+ Add prose" }).click();
    await expect(page.getByText("Prose block", { exact: false })).toBeVisible();

    const proseItem = page.locator('a[href*="/manuscript/review?item="]').first();
    await expect(proseItem).toBeVisible();
    const itemHref = await proseItem.getAttribute("href");
    const sectionItemId = new URL(itemHref!, "http://127.0.0.1").searchParams.get("item")!;
    const beforeDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export Markdown" }).click();
    const before = await beforeDownload;
    const beforeStream = await before.createReadStream();
    let beforeMarkdown = "";
    if (beforeStream) for await (const chunk of beforeStream) beforeMarkdown += chunk.toString();

    await proseItem.click();
    await expect(page.getByRole("heading", { name: "Open review thread" })).toBeVisible();
    await page.getByLabel("Title").fill("Clarify opening wording");
    await page.getByLabel("Opening comment").fill("Please review this exact passage.");
    await page.getByRole("button", { name: "Open thread" }).click();
    await expect(page.getByRole("heading", { name: "Clarify opening wording" })).toBeVisible();
    await expect(page.locator("pre").first()).toHaveText(exactText);
    await expect(page.getByText("open", { exact: true }).first()).toBeVisible();

    await page.getByLabel("Comment").fill("A follow-up editorial comment.");
    await page.getByRole("button", { name: "Comment" }).click();
    await expect(page.getByText("A follow-up editorial comment.", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Optional resolution note").fill("Resolved for this draft.");
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByText("resolved", { exact: true }).first()).toBeVisible();
    await page.getByLabel("Comment").fill("Commenting does not reopen a resolved thread.");
    await page.getByRole("button", { name: "Comment" }).click();
    await expect(page.getByText("resolved", { exact: true }).first()).toBeVisible();
    await page.getByPlaceholder("Optional reopening note").fill("Reopen for another pass.");
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByText("open", { exact: true }).first()).toBeVisible();

    const editorialOnlyDownload = page.waitForEvent("download");
    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByRole("link", { name: "Export Markdown" }).click();
    const editorialOnly = await editorialOnlyDownload;
    const editorialOnlyStream = await editorialOnly.createReadStream();
    let editorialOnlyMarkdown = "";
    if (editorialOnlyStream) for await (const chunk of editorialOnlyStream) editorialOnlyMarkdown += chunk.toString();
    expect(editorialOnlyMarkdown).toBe(beforeMarkdown);

    await page.getByLabel("Edit prose block 1").fill("Changed retained wording.");
    await page.getByRole("button", { name: "Save prose" }).click();
    await expect(page.getByText("Changed retained wording.", { exact: true })).toBeVisible();
    await page.goto(`/projects/${projectId}/manuscript/review`);
    await expect(page.getByText(/changed since opening: yes/)).toBeVisible();
    await expect(page.locator("pre").first()).toHaveText(exactText);

    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByRole("button", { name: "Remove prose" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove prose" }).click();
    await expect(page.getByText("Prose removed.", { exact: true })).toBeVisible();
    await page.goto(`/projects/${projectId}/manuscript/review`);
    await expect(page.getByText("Target is removed", { exact: false })).toBeVisible();
    await expect(page.locator("pre").first()).toHaveText(exactText);
    await page.getByLabel("Comment").fill("Historical target remains commentable.");
    await page.getByRole("button", { name: "Comment" }).click();
    await expect(page.getByText("Historical target remains commentable.", { exact: true })).toBeVisible();

    const sql = await getTestDbClient();
    try {
      const [row] = await sql`
        select opening_prose_text
        from manuscript_review_threads
        where project_id = ${projectId} and section_item_id = ${sectionItemId}
        order by created_at desc limit 1
      `;
      expect(String(row.opening_prose_text)).toBe(expectedPersistedText);
    } finally {
      await sql.end();
    }
  });
});
