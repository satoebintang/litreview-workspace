import { expect, test } from "@playwright/test";

test.describe("Slice 32 project workspace navigation", () => {
  test("creates and resumes a project through the read-only shell", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible();
    await expect(page.getByLabel("Research question")).toHaveCount(0);
    await page.getByLabel("Project title").fill(`Slice 32 workspace ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await expect(page.getByRole("heading", { name: `Slice 32 workspace ${unique}` })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("main form")).toHaveCount(0);

    const destinations: Record<string, string> = {
      Overview: `/projects/${projectId}`,
      Plan: `/projects/${projectId}/protocol`,
      Papers: `/projects/${projectId}/papers`,
      Screen: `/projects/${projectId}/screening`,
      Extract: `/projects/${projectId}/extraction`,
      Synthesize: `/projects/${projectId}/synthesis`,
      Write: `/projects/${projectId}/manuscript`,
      Reports: `/projects/${projectId}/review-flow`,
    };
    for (const [label, href] of Object.entries(destinations)) {
      await expect(page.getByTestId("project-nav").getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
    }
    await expect(page.getByTestId("project-nav").getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Papers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Screening" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Extraction" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Synthesis" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();

    await page.goto(`/projects/${projectId}/papers/imports`);
    await expect(page.getByTestId("project-nav").getByRole("link", { name: "Papers", exact: true })).toHaveAttribute("aria-current", "page");
    const breadcrumbs = page.getByTestId("project-breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).not.toContainText(projectId);
    await expect(breadcrumbs.getByText("Papers", { exact: true })).toBeVisible();
  });

  test("keeps Write read-only until the researcher starts a manuscript", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 32 manuscript ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/manuscript`);
    await expect(page.getByRole("heading", { name: "No manuscript has been started." })).toBeVisible();
    await expect(page.getByText("Create your manuscript when you're ready to begin writing.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start manuscript" })).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(1);
    await page.getByRole("button", { name: "Start manuscript" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/manuscript\?created=/);
    await expect(page.getByRole("heading", { name: "Citation formatting" })).toBeVisible();
  });

  test("provides an accessible confirmation dialog without nested forms", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 32 confirmation ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByRole("button", { name: "Start manuscript" }).click();
    await expect(page).toHaveURL(/\/manuscript\?created=/);

    await page.getByLabel("Section title").fill("Temporary section");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Temporary section" })).toBeVisible();
    const trigger = page.getByRole("button", { name: "Archive section" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Archive this section?" })).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-describedby", /confirm-action-consequence/);
    expect(await dialog.locator("form form").count()).toBe(0);
    await expect.poll(async () => dialog.locator("button", { hasText: "Cancel" }).evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(async () => trigger.evaluate((element) => document.activeElement === element)).toBe(true);

    await trigger.click();
    await dialog.getByRole("button", { name: "Archive section" }).click();
    await expect(page.getByText("Section archived.", { exact: true })).toBeVisible();
  });

  test("keeps the mobile menu keyboard-operable and avoids viewport overflow", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 32 mobile ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);

    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }

    await page.setViewportSize({ width: 375, height: 800 });
    const menu = page.getByRole("button", { name: "Project menu" });
    await menu.focus();
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const mobileNav = page.getByTestId("project-mobile-nav");
    await expect(mobileNav.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    await expect(mobileNav.getByRole("link", { name: "Reports", exact: true })).toBeVisible();
    await mobileNav.getByRole("link", { name: "Papers", exact: true }).focus();
    await expect(mobileNav.getByRole("link", { name: "Papers", exact: true })).toBeFocused();
  });
});
