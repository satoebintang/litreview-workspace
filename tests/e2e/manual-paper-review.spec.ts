import { test, expect } from "@playwright/test";

test("reviews manual Paper candidates inline without draft data in URLs and resets acknowledgement after edits", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const unique = Date.now();
  const title = `Manual review study ${unique}`;
  const authors = "A. Researcher, B. Researcher";
  const year = "2024";
  const venue = "Journal of Inline Reviews";
  const doi = `10.5555/manual-review-${unique}`;
  const abstract = `Abstract draft ${unique} stays in the form state.`;
  const note = `Researcher note ${unique} stays in the form state.`;

  await page.goto("/");
  await page.getByLabel("Project title").fill(`Manual duplicate review ${unique}`);
  await page.getByRole("button", { name: /Create project/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1];
  expect(projectId).toBeTruthy();
  await page.goto(`/projects/${projectId}/papers`);

  const form = page.getByTestId("manual-paper-form");
  async function fillPaperDraft() {
    await form.getByLabel("Title", { exact: true }).fill(title);
    await form.getByLabel(/Authors/).fill(authors);
    await form.getByLabel(/Publication year/).fill(year);
    await form.getByLabel(/Venue/).fill(venue);
    await form.getByLabel(/DOI/).fill(doi);
    await form.getByLabel(/Abstract/).fill(abstract);
    await form.getByLabel(/Bibliographic note/).fill(note);
  }

  async function reviewCurrentDraft() {
    await form.getByRole("button", { name: "Review possible duplicates" }).click();
    await expect(page).toHaveURL(`/projects/${projectId}/papers`);
    await expect(form.getByLabel(/Abstract/)).toHaveValue(abstract);
    await expect(form.getByLabel(/Bibliographic note/)).toHaveValue(note);
  }

  await fillPaperDraft();
  await reviewCurrentDraft();
  await expect(form.getByText("No possible duplicate Papers were found.")).toBeVisible();
  await form.getByRole("button", { name: "Add Paper" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}/papers`);
  await expect(page.locator(".item-title", { hasText: title }).first()).toBeVisible();

  await fillPaperDraft();
  const action = await form.getAttribute("action");
  await reviewCurrentDraft();
  const review = page.getByTestId("manual-paper-review");
  await expect(review.getByRole("heading", { name: "Review possible duplicate Papers" })).toBeVisible();
  await expect(review.locator(".item-title", { hasText: title })).toBeVisible();
  await expect(review.getByRole("checkbox")).not.toBeChecked();

  const urlAfterReview = new URL(page.url());
  expect(urlAfterReview.search).toBe("");
  expect(action ?? "").not.toContain(title);
  expect(action ?? "").not.toContain(encodeURIComponent(abstract));
  const cookieText = JSON.stringify(await page.context().cookies());
  for (const draftValue of [title, authors, venue, doi, abstract, note]) expect(cookieText).not.toContain(draftValue);

  const editableFields = [
    { name: "Title", original: title, edited: `${title} edited` },
    { name: /Authors/, original: authors, edited: "C. Researcher" },
    { name: /Publication year/, original: year, edited: "2025" },
    { name: /Venue/, original: venue, edited: "Another Venue" },
    { name: /DOI/, original: doi, edited: `10.5555/edited-${unique}` },
    { name: /Abstract/, original: abstract, edited: "Edited abstract" },
    { name: /Bibliographic note/, original: note, edited: "Edited researcher note" },
  ] as const;

  for (const field of editableFields) {
    await review.getByRole("checkbox").check();
    await expect(review.getByRole("checkbox")).toBeChecked();
    const input = form.getByLabel(field.name);
    await input.fill(field.edited);
    await expect(page.getByTestId("manual-paper-review")).toHaveCount(0);
    await expect(form.getByRole("checkbox")).toHaveCount(0);
    await expect(form.getByRole("status")).toContainText("The draft changed");

    await input.fill(field.original);
    await reviewCurrentDraft();
    await expect(review.getByRole("checkbox")).not.toBeChecked();
    await expect(review.locator(".item-title", { hasText: title })).toBeVisible();
  }

  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "Add Paper" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}/papers`);
  await expect(page.locator(".item-title", { hasText: title })).toHaveCount(2);
});
