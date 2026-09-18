import { test, expect } from "@playwright/test";

test.describe("Slice 25 immutable manuscript snapshots", () => {
  test("captures a milestone, exports it, and keeps it fixed after working-copy edits", async ({ page, request }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 25 snapshots ${Date.now()}`);
    await page.getByLabel("Research question").fill("What did the manuscript look like at each milestone?");
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/manuscript`);
    const manuscriptId = await page.locator('input[name="manuscriptId"]').first().inputValue();
    await page.getByLabel("Section title").fill("Discussion");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Discussion", exact: true })).toBeVisible();
    await page.getByLabel("Section title").fill("Empty section");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Empty section", exact: true })).toBeVisible();
    await page.getByLabel("New prose for Discussion").fill("Baseline wording.");
    await page.locator("form").filter({ has: page.getByLabel("New prose for Discussion") }).getByRole("button", { name: "+ Add prose" }).click();
    await expect(page.getByText(/Prose block · position 1 · Revision 1/)).toBeVisible();

    await page.getByRole("button", { name: "Create snapshot" }).click();
    await expect(page).toHaveURL(/\/manuscript\/snapshots\/[0-9a-f-]+\?manuscriptId=/);
    const snapshot1Id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByText("Baseline wording.", { exact: true })).toBeVisible();
    await expect(page.getByText("Frozen bibliography", { exact: true })).toBeVisible();
    const snapshot1ExportHref = await page.getByRole("link", { name: "Export Markdown" }).getAttribute("href");
    expect(snapshot1ExportHref).toBeTruthy();
    const snapshot1Markdown = await (await request.get(new URL(snapshot1ExportHref!, page.url()).toString())).text();
    expect(snapshot1Markdown).toContain("Baseline wording.");
    expect(snapshot1Markdown).toContain("## Empty section");

    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByLabel("Edit prose block 1").fill("Revised wording.");
    await page.getByRole("button", { name: "Save prose" }).click();
    await expect(page.getByText(/Prose block · position 1 · Revision 2/)).toBeVisible();
    await page.getByRole("button", { name: "Create snapshot" }).click();
    await expect(page).toHaveURL(/\/manuscript\/snapshots\/[0-9a-f-]+\?manuscriptId=/);
    const snapshot2Id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByText("Revised wording.", { exact: true })).toBeVisible();

    await page.goto(`/projects/${projectId}/manuscript/snapshots?manuscriptId=${manuscriptId}`);
    await expect(page.getByRole("link", { name: /Snapshot 1/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Snapshot 2/ })).toBeVisible();

    const refetchedSnapshot1 = await (await request.get(`/projects/${projectId}/manuscript/snapshots/${snapshot1Id}/export?manuscriptId=${manuscriptId}`)).text();
    expect(refetchedSnapshot1).toBe(snapshot1Markdown);
    expect(refetchedSnapshot1).not.toContain("Revised wording.");
    expect(snapshot2Id).not.toBe(snapshot1Id);
  });
});
