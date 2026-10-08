import { expect, type Locator, type Page } from "@playwright/test";

export type ExtractionEvidenceTarget = {
  pageNumber: number;
  sourceText: string;
};

export type SelectedExtractionEvidence = ExtractionEvidenceTarget & {
  evidenceId: string;
  href: string;
};

type CandidateMatch = Omit<SelectedExtractionEvidence, "evidenceId"> & {
  pageIndex: number;
};

const readyStatus = /Showing \d+ candidates/;
const candidateDetailLinkName = "Open exact Evidence detail →";

export function getExtractionField(page: Page, accessibleHeadingName: string): Locator {
  return page.getByRole("article").filter({
    has: page.getByRole("heading", { level: 3, name: accessibleHeadingName, exact: true }),
  });
}

export async function expectSelectedEvidenceSupport(
  field: Locator,
  evidence: SelectedExtractionEvidence,
): Promise<void> {
  const supportGroup = field.getByRole("group", { name: /^Supporting Evidence/ });
  await expect(supportGroup).toHaveCount(1);
  const control = supportGroup.locator(`input[name="evidenceIds"][value="${evidence.evidenceId}"]`);
  await expect(control).toHaveCount(1);
  await expect(control).toBeChecked();

  const selectedRow = control.locator("xpath=ancestor::label[1]");
  await expect(selectedRow).toBeVisible();
  await expect(selectedRow.getByText(`Page ${evidence.pageNumber}`, { exact: true })).toBeVisible();
  await expect(selectedRow.getByText(`“${evidence.sourceText}”`, { exact: true })).toBeVisible();
  const detailLink = selectedRow.getByRole("link", { name: candidateDetailLinkName, exact: true });
  await expect(detailLink).toHaveCount(1);
  await expect(detailLink).toHaveAttribute("href", evidence.href);
}

async function detailHref(candidate: Locator): Promise<string> {
  const link = candidate.getByRole("link", { name: candidateDetailLinkName, exact: true });
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  expect(href, "Each Evidence candidate must expose its exact detail link").toBeTruthy();
  return href!;
}

async function firstCandidateHref(browser: Locator): Promise<string> {
  const candidates = browser.locator(".candidate-evidence");
  expect(await candidates.count(), "A bounded candidate page with a next page must contain a candidate").toBeGreaterThan(0);
  return detailHref(candidates.nth(0));
}

async function advanceToNextCandidatePage(browser: Locator): Promise<void> {
  const previousFirstHref = await firstCandidateHref(browser);
  const nextPage = browser.getByRole("button", { name: "Next Evidence page", exact: true });
  await expect(nextPage).toBeVisible();
  await nextPage.click();

  const nextFirstLink = browser.locator(".candidate-evidence").nth(0).getByRole("link", {
    name: candidateDetailLinkName,
    exact: true,
  });
  await expect(nextFirstLink).not.toHaveAttribute("href", previousFirstHref);
  await expect(browser.getByRole("status").filter({ hasText: readyStatus })).toBeVisible();
}

export async function addEvidenceToExtractionField(
  page: Page,
  accessibleHeadingName: string,
  target: ExtractionEvidenceTarget,
): Promise<SelectedExtractionEvidence> {
  const field = getExtractionField(page, accessibleHeadingName);
  await expect(field).toHaveCount(1);
  const fieldId = await field.getAttribute("data-extraction-field");
  expect(fieldId, `The ${accessibleHeadingName} Extraction Field must expose its identity`).toBeTruthy();

  const structuredValue = field.getByLabel("Structured value", { exact: true });
  const researcherNote = field.getByLabel("Researcher note");
  await expect(structuredValue).toHaveCount(1);
  await expect(researcherNote).toHaveCount(1);
  const originalValue = await structuredValue.inputValue();
  const originalNote = await researcherNote.inputValue();
  const assertDraftsIntact = async () => {
    await expect(structuredValue).toHaveValue(originalValue);
    await expect(researcherNote).toHaveValue(originalNote);
  };

  const openBrowser = field.getByRole("button", {
    name: /^Browse Evidence (?:to add to .+|for this Field)$/,
  });
  await expect(openBrowser).toHaveCount(1);
  await openBrowser.click();

  const browser = page.getByRole("region", { name: "Shared Evidence browser" });
  await expect(browser).toBeVisible();
  await expect(browser.getByLabel("Field receiving added Evidence")).toHaveValue(fieldId!);
  await expect(browser.getByRole("status").filter({ hasText: readyStatus })).toBeVisible();

  const matches: CandidateMatch[] = [];
  const firstPageHref = await firstCandidateHref(browser);
  let pageIndex = 0;

  while (true) {
    const candidates = browser.locator(".candidate-evidence");
    const candidateCount = await candidates.count();
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
      const candidate = candidates.nth(candidateIndex);
      const passage = candidate.getByText(`“${target.sourceText}”`, { exact: true });
      const pageLabel = candidate.getByText(`Page ${target.pageNumber}`, { exact: true });
      const passageCount = await passage.count();
      const pageCount = await pageLabel.count();
      if (passageCount === 0 || pageCount === 0) continue;

      expect(passageCount, "An Evidence candidate must display the exact fixture passage only once").toBe(1);
      expect(pageCount, "An Evidence candidate must display the target page only once").toBe(1);
      matches.push({
        ...target,
        href: await detailHref(candidate),
        pageIndex,
      });
    }

    const nextPage = browser.getByRole("button", { name: "Next Evidence page", exact: true });
    if (await nextPage.count() === 0) break;
    await advanceToNextCandidatePage(browser);
    await assertDraftsIntact();
    pageIndex += 1;
  }

  expect(
    matches.map(({ href }) => href),
    `Expected exactly one candidate matching Page ${target.pageNumber} and the exact fixture passage; found ${matches.length}`,
  ).toHaveLength(1);
  const match = matches[0]!;

  if (match.pageIndex !== pageIndex) {
    const firstPage = browser.getByRole("button", { name: "First page", exact: true });
    await expect(firstPage).toBeVisible();
    await firstPage.click();
    const firstLink = browser.locator(".candidate-evidence").nth(0).getByRole("link", {
      name: candidateDetailLinkName,
      exact: true,
    });
    await expect(firstLink).toHaveAttribute("href", firstPageHref);
    await expect(browser.getByRole("status").filter({ hasText: readyStatus })).toBeVisible();
    await assertDraftsIntact();

    for (let currentPageIndex = 0; currentPageIndex < match.pageIndex; currentPageIndex += 1) {
      await advanceToNextCandidatePage(browser);
      await assertDraftsIntact();
    }
  }

  const targetCandidates: Locator[] = [];
  const currentCandidates = browser.locator(".candidate-evidence");
  const currentCandidateCount = await currentCandidates.count();
  for (let candidateIndex = 0; candidateIndex < currentCandidateCount; candidateIndex += 1) {
    const candidate = currentCandidates.nth(candidateIndex);
    if (await detailHref(candidate) === match.href) targetCandidates.push(candidate);
  }
  expect(targetCandidates, "The unique exact Evidence identity must be present on its bounded page").toHaveLength(1);

  const targetCandidate = targetCandidates[0]!;
  await expect(targetCandidate.getByText(`“${target.sourceText}”`, { exact: true })).toBeVisible();
  await expect(targetCandidate.getByText(`Page ${target.pageNumber}`, { exact: true })).toBeVisible();
  const addButton = targetCandidate.getByRole("button", { name: "Add to this Field", exact: true });
  await expect(addButton, "The exact Evidence candidate must be eligible for selection").toHaveCount(1);
  await expect(addButton).toBeEnabled();
  const supportGroup = field.getByRole("group", { name: /^Supporting Evidence/ });
  await expect(supportGroup).toHaveCount(1);
  const supportControls = supportGroup.locator('input[name="evidenceIds"]');
  const previousSupportCount = await supportControls.count();
  await addButton.click();
  await expect(supportControls).toHaveCount(previousSupportCount + 1);

  const selectedRows: Locator[] = [];
  const supportCount = await supportControls.count();
  for (let supportIndex = 0; supportIndex < supportCount; supportIndex += 1) {
    const supportRow = supportControls.nth(supportIndex).locator("xpath=ancestor::label[1]");
    const supportLink = supportRow.getByRole("link", { name: candidateDetailLinkName, exact: true });
    if (await supportLink.count() === 1 && await supportLink.getAttribute("href") === match.href) {
      selectedRows.push(supportRow);
    }
  }

  expect(selectedRows, "The exact Evidence must appear in this Field's selected-support list").toHaveLength(1);
  const selectedRow = selectedRows[0]!;
  await expect(selectedRow).toBeVisible();
  await expect(selectedRow.getByText(`Page ${target.pageNumber}`, { exact: true })).toBeVisible();
  await expect(selectedRow.getByText(`“${target.sourceText}”`, { exact: true })).toBeVisible();
  const selectedControl = selectedRow.locator('input[name="evidenceIds"]');
  await expect(selectedControl).toHaveCount(1);
  await expect(selectedControl).toBeChecked();
  const evidenceId = await selectedControl.getAttribute("value");
  expect(evidenceId, "The selected support control must retain its exact Evidence ID").toBeTruthy();
  await expect(selectedRow.getByRole("link", { name: candidateDetailLinkName, exact: true })).toHaveAttribute("href", match.href);
  await assertDraftsIntact();

  return { ...target, evidenceId: evidenceId!, href: match.href };
}
