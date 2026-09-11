import { test, expect } from "@playwright/test";

test.describe("Slice 16 Evidence curation", () => {
  test("curates an Evidence record, blocks rejected direct use, and restores it on re-acceptance", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Curation review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByLabel("Title", { exact: true }).fill("Curation study");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.getByText("Curation study", { exact: true }).first()).toBeVisible();

    await page.getByLabel("Paper").selectOption({ label: "Curation study" });
    await page.getByLabel("Verbatim source passage").fill("Slice 16 curation passage");
    await page.getByLabel("Page number").fill("7");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence recorded with source provenance.");

    const workspaceUrl = `/projects/${projectId}/evidence`;
    await page.goto(workspaceUrl);
    await expect(page.getByText("Unreviewed", { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "Open Evidence detail →" }).click();
    await expect(page).toHaveURL(/\/evidence\/[0-9a-f-]+$/);
    const evidenceUrl = page.url();
    await expect(page.getByText("Unreviewed", { exact: true }).first()).toBeVisible();

    await page.getByLabel("Researcher annotation").fill("  Keep this context  ");
    await page.getByRole("button", { name: "Append annotation" }).click();
    await expect(page.getByRole("status")).toHaveText("Curation change saved.");
    await expect(page.getByText("Keep this context", { exact: true })).toBeVisible();

    await page.locator("#review-decision").selectOption("accepted");
    await page.getByLabel("Decision note").fill("  accepted after check  ");
    await page.getByRole("button", { name: "Append review decision" }).click();
    await expect(page.getByRole("status")).toHaveText("Curation change saved.");
    await expect(page.getByText("accepted after check", { exact: true })).toBeVisible();
    await expect(page.getByText("Accepted", { exact: true }).first()).toBeVisible();

    await page.goto(workspaceUrl);
    await page.getByLabel("New label").fill("  important  ");
    await page.getByRole("button", { name: "Create label" }).click();
    await expect(page.getByRole("status")).toHaveText("Label change saved.");
    await expect(page.locator(".item-title").filter({ hasText: "important" })).toBeVisible();

    await page.goto(evidenceUrl);
    await page.getByLabel("Assign active label").selectOption({ label: "important" });
    await page.getByRole("button", { name: "Assign label" }).click();
    await expect(page.getByRole("status")).toHaveText("Curation change saved.");
    await expect(page.locator(".item-title").filter({ hasText: "important" })).toBeVisible();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("status")).toHaveText("Curation change saved.");
    await expect(page.getByText("No current labels.", { exact: true })).toBeVisible();

    await page.locator("#review-decision").selectOption("rejected");
    await page.getByLabel("Decision note").fill("  no direct use  ");
    await page.getByRole("button", { name: "Append review decision" }).click();
    await expect(page.getByRole("status")).toHaveText("Curation change saved.");
    await expect(page.getByText("no direct use", { exact: true })).toBeVisible();
    await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Currently rejected for new direct use.", { exact: true })).toBeVisible();

    await page.goto(`/projects/${projectId}/claims`);
    await page.getByLabel("Claim text").fill("Rejected Evidence cannot be newly selected");
    await page.getByRole("button", { name: "Create unsupported claim" }).click();
    await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+(?:\?.*)?$/);
    const claimUrl = page.url();
    await expect(page.getByText("No Evidence records are available.", { exact: true })).toBeVisible();

    await page.goto(evidenceUrl);
    await page.locator("#review-decision").selectOption("accepted");
    await page.getByRole("button", { name: "Append review decision" }).click();
    await expect(page.getByRole("status")).toHaveText("Curation change saved.");
    await page.goto(claimUrl);
    await expect(page.locator("#link-evidence option").filter({ hasText: "Slice 16 curation passage" })).toHaveCount(1);
  });
});
