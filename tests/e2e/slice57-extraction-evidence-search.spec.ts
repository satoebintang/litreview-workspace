import { expect, test, type Page } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

type Fixture = {
  projectId: string;
  paperId: string;
  fieldAId: string;
  fieldBId: string;
  candidateIds: Record<number, string>;
  worksheetPath: string;
};

async function createFixture(page: Page): Promise<Fixture> {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectTitle = `Slice 57 Evidence search ${unique}`;
  const paperTitle = `Slice 57 Paper ${unique}`;
  await page.goto("/");
  await page.getByLabel("Project title").fill(projectTitle);
  await page.getByRole("button", { name: /Create project/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;

  await page.goto(`/projects/${projectId}/papers`);
  await page.getByLabel("Title", { exact: true }).fill(paperTitle);
  await page.getByLabel("Authors").fill("Slice 57 Researcher");
  await page.getByLabel("Abstract").fill("A Paper for Evidence passage and note search coverage.");
  const paperId = await addManualPaper(page);

  const db = createPlaywrightTestDatabaseClient();
  try {
    await db`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
    await db`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}::uuid, ${paperId}::uuid, 'retrieved', now())`;
    await db`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
    const fields = await db<{ id: string; name: string }[]>`insert into extraction_fields (project_id, name, field_type, required, sort_order)
      values (${projectId}::uuid, 'Primary outcome', 'short_text', true, 0), (${projectId}::uuid, 'Secondary outcome', 'short_text', false, 1)
      returning id::text as id, name`;
    const fieldAId = fields.find((field) => field.name === "Primary outcome")!.id;
    const fieldBId = fields.find((field) => field.name === "Secondary outcome")!.id;
    await db`insert into evidence (project_id, paper_id, source_text, note, page_number, created_at, updated_at)
      select ${projectId}::uuid, ${paperId}::uuid,
        'Candidate ' || lpad(series::text, 2, '0') || ' — common exact-search-term ' || repeat('x', 1205)
          || case when series = 1 then ' PASSAGE-TAIL-NEEDLE' else '' end
          || case when series = 3 then ' ' || '\uFFFD\uFFFD\uFFFD' || ' decoded-search-marker' else '' end,
        case when series = 2 then repeat('n', 605) || ' NOTE-TAIL-NEEDLE' else 'Evidence note ' || series::text end,
        series,
        '2026-10-01T00:00:00Z'::timestamptz + series * interval '1 second',
        '2026-10-01T00:00:00Z'::timestamptz + series * interval '1 second'
      from generate_series(1, 27) as series`;
    await db`insert into evidence_review_decisions (project_id, evidence_id, decision)
      select ${projectId}::uuid, id, 'accepted'
      from evidence where project_id=${projectId}::uuid and paper_id=${paperId}::uuid`;
    const candidates = await db<{ id: string; page_number: number }[]>`select id::text as id, page_number from evidence where project_id=${projectId}::uuid and paper_id=${paperId}::uuid`;
    return {
      projectId,
      paperId,
      fieldAId,
      fieldBId,
      candidateIds: Object.fromEntries(candidates.map((item) => [item.page_number, item.id])),
      worksheetPath: `/projects/${projectId}/extraction/${paperId}`,
    };
  } finally {
    await db.end();
  }
}

function getField(page: Page, fieldId: string) {
  return page.locator(`.extraction-value[data-extraction-field="${fieldId}"]`);
}

test.describe("Slice 57 Evidence passage and note search", () => {
  test("preserves every Field draft and selected support across search, paging, switching, clearing, and history", async ({ page }) => {
    test.setTimeout(180_000);
    const fixture = await createFixture(page);
    await page.goto(fixture.worksheetPath);
    const fieldA = getField(page, fixture.fieldAId);
    const fieldB = getField(page, fixture.fieldBId);
    const browserRegion = page.getByRole("region", { name: "Shared Evidence browser" });

    await fieldA.getByLabel("Structured value").fill("Draft outcome A");
    await fieldA.locator("textarea[name='researcherNote']").fill("Draft note A");
    await fieldB.getByLabel("Structured value").fill("Draft outcome B");
    await fieldB.locator("textarea[name='researcherNote']").fill("Draft note B");
    await fieldA.getByRole("button", { name: "Browse Evidence to add to Primary outcome" }).click();
    await expect(browserRegion.getByRole("status").filter({ hasText: /Showing 20 candidates/ })).toBeVisible();

    const search = browserRegion.getByLabel("Search Evidence passages and notes");
    await search.fill("  passage-tail-needle  ");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/evidenceQuery=passage-tail-needle/);
    const passageHit = browserRegion.locator(".candidate-evidence");
    await expect(passageHit).toHaveCount(1);
    await expect(passageHit).toContainText("Candidate 01");
    await expect(passageHit).toContainText("Preview truncated");
    await expect(passageHit.getByText(/PASSAGE-TAIL-NEEDLE/)).toHaveCount(0);
    await passageHit.getByRole("button", { name: "Add to this Field" }).click();
    const passageSupport = fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[1]}"]`);
    await expect(passageSupport).toBeChecked();

    await search.fill("note-tail-needle");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    const noteHit = browserRegion.locator(".candidate-evidence");
    await expect(noteHit).toHaveCount(1);
    await expect(noteHit).toContainText("Candidate 02");
    await expect(noteHit).toContainText("preview truncated");
    await expect(noteHit.getByText(/NOTE-TAIL-NEEDLE/)).toHaveCount(0);
    await noteHit.getByRole("button", { name: "Add to this Field" }).click();
    const noteSupport = fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[2]}"]`);
    await expect(noteSupport).toBeChecked();

    await search.fill("common exact-search-term");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(page).toHaveURL(/evidenceQuery=common\+exact-search-term/);
    const firstPageCandidate = browserRegion.locator(".candidate-evidence").first();
    const firstPageDetail = await firstPageCandidate.getByRole("link", { name: /Open exact Evidence detail/ }).getAttribute("href");
    const firstPageId = firstPageDetail?.split("/").at(-1);
    await firstPageCandidate.getByRole("button", { name: "Add to this Field" }).click();
    expect(firstPageId).toBeTruthy();
    const firstPageSupport = fieldA.locator(`input[name="evidenceIds"][value="${firstPageId}"]`);
    await expect(firstPageSupport).toBeChecked();

    await browserRegion.getByRole("button", { name: "Next Evidence page" }).click();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(7);
    const secondPageCandidate = browserRegion.locator(".candidate-evidence").first();
    const secondPageDetail = await secondPageCandidate.getByRole("link", { name: /Open exact Evidence detail/ }).getAttribute("href");
    const secondPageId = secondPageDetail?.split("/").at(-1);
    await secondPageCandidate.getByRole("button", { name: "Add to this Field" }).click();
    const secondPageSupport = fieldA.locator(`input[name="evidenceIds"][value="${secondPageId}"]`);
    await expect(secondPageSupport).toBeChecked();
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Draft outcome A");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Draft note A");
    await page.goBack();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(search).toHaveValue("common exact-search-term");
    await expect(page).not.toHaveURL(/evidenceAfter=/);
    await expect(passageSupport).toBeChecked();
    await expect(noteSupport).toBeChecked();
    await expect(secondPageSupport).toBeChecked();
    await page.goForward();
    await expect(page).toHaveURL(/evidenceAfter=/);
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(7);
    await expect(secondPageSupport).toBeChecked();

    await browserRegion.getByLabel("Field receiving added Evidence").selectOption(fixture.fieldBId);
    await expect(page).not.toHaveURL(/evidenceAfter=/);
    await expect(page).toHaveURL(/evidenceQuery=common\+exact-search-term/);
    await expect(search).toHaveValue("common exact-search-term");
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await browserRegion.locator(".candidate-evidence").first().getByRole("button", { name: "Add to this Field" }).click();
    const fieldBSupport = fieldB.locator('input[name="evidenceIds"]');
    await expect(fieldBSupport).toHaveCount(1);
    await expect(fieldBSupport).toBeChecked();
    await expect(fieldB.getByLabel("Structured value")).toHaveValue("Draft outcome B");
    await expect(fieldB.locator("textarea[name='researcherNote']")).toHaveValue("Draft note B");

    await browserRegion.getByLabel("Field receiving added Evidence").selectOption(fixture.fieldAId);
    await expect(passageSupport).toBeChecked();
    await expect(noteSupport).toBeChecked();
    await expect(secondPageSupport).toBeChecked();
    await browserRegion.getByRole("button", { name: "Clear search" }).click();
    await expect(page).not.toHaveURL(/evidenceQuery=/);
    await expect(browserRegion.getByLabel("Search Evidence passages and notes")).toHaveValue("");
    await expect(passageSupport).toBeChecked();
    await expect(noteSupport).toBeChecked();
    await expect(secondPageSupport).toBeChecked();

    await browserRegion.getByLabel("Search Evidence passages and notes").fill("common exact-search-term");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await browserRegion.getByRole("button", { name: "Next Evidence page" }).click();
    const cursorBeforeInvalidSearch = new URL(page.url()).searchParams.get("evidenceAfter");
    expect(cursorBeforeInvalidSearch).toBeTruthy();
    await browserRegion.getByLabel("Search Evidence passages and notes").fill("x".repeat(201));
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(browserRegion.getByRole("alert")).toContainText("cannot exceed 200 characters");
    await expect.poll(() => new URL(page.url()).searchParams.get("evidenceAfter")).toBe(cursorBeforeInvalidSearch);
    expect(new URL(page.url()).searchParams.get("evidenceQuery")).toBe("common exact-search-term");
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(0);
    await expect(passageSupport).toBeChecked();
    await expect(noteSupport).toBeChecked();
    await expect(secondPageSupport).toBeChecked();
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Draft outcome A");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Draft note A");
    await expect(fieldB.getByLabel("Structured value")).toHaveValue("Draft outcome B");
    await expect(fieldB.locator("textarea[name='researcherNote']")).toHaveValue("Draft note B");

    await browserRegion.getByLabel("Search Evidence passages and notes").fill("common exact-search-term");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await browserRegion.getByRole("button", { name: "Close browser" }).click();
    await expect(page).not.toHaveURL(/evidence(?:Field|After|PageSize|Query)=/);
    await fieldA.getByRole("button", { name: "Browse Evidence to add to Primary outcome" }).click();
    await expect(browserRegion.getByLabel("Search Evidence passages and notes")).toHaveValue("common exact-search-term");
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await page.goBack();
    await expect(browserRegion.getByText("Open the browser from a Field to load its first bounded Evidence page.")).toBeVisible();
    await expect(page).not.toHaveURL(/evidence(?:Field|After|PageSize|Query)=/);
    await page.goForward();
    await expect(browserRegion.getByLabel("Search Evidence passages and notes")).toHaveValue("common exact-search-term");
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(passageSupport).toBeChecked();
    await expect(noteSupport).toBeChecked();
    await expect(secondPageSupport).toBeChecked();
  });

  test("ignores delayed stale searches and preserves Field drafts and supports after request failure", async ({ page }) => {
    test.setTimeout(180_000);
    const fixture = await createFixture(page);
    let releaseFirstResponse!: () => void;
    let firstResponseReady!: () => void;
    let firstResponseFinished!: () => void;
    let searchedResponseFinished!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    const firstReady = new Promise<void>((resolve) => { firstResponseReady = resolve; });
    const firstFinished = new Promise<void>((resolve) => { firstResponseFinished = resolve; });
    const searchedFinished = new Promise<void>((resolve) => { searchedResponseFinished = resolve; });
    let requestCount = 0;
    await page.route("**/api/projects/**/extraction-evidence**", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      requestCount += 1;
      if (requestCount === 3) return route.abort("failed");
      const response = await route.fetch();
      if (requestCount === 1) {
        firstResponseReady();
        await firstGate;
        await route.fulfill({ response });
        firstResponseFinished();
        return;
      }
      await route.fulfill({ response });
      if (requestCount === 2) searchedResponseFinished();
    });

    await page.goto(fixture.worksheetPath);
    const fieldA = getField(page, fixture.fieldAId);
    await fieldA.getByLabel("Structured value").fill("Failure-safe value");
    await fieldA.locator("textarea[name='researcherNote']").fill("Failure-safe note");
    await fieldA.getByRole("button", { name: "Browse Evidence to add to Primary outcome" }).click();
    await firstReady;
    const browserRegion = page.getByRole("region", { name: "Shared Evidence browser" });
    await browserRegion.getByLabel("Search Evidence passages and notes").fill("passage-tail-needle");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await searchedFinished;
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(1);
    await expect(browserRegion.locator(".candidate-evidence")).toContainText("Candidate 01");
    releaseFirstResponse();
    await firstFinished;
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(1);
    await expect(browserRegion.locator(".candidate-evidence")).toContainText("Candidate 01");

    await browserRegion.locator(".candidate-evidence").getByRole("button", { name: "Add to this Field" }).click();
    const selected = fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[1]}"]`);
    await expect(selected).toBeChecked();
    await browserRegion.getByLabel("Search Evidence passages and notes").fill("will-fail");
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(browserRegion.getByRole("alert")).toContainText("Selected supports were kept unchanged");
    await expect(selected).toBeChecked();
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Failure-safe value");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Failure-safe note");
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(0);
  });

  test("repairs invalid pagination in-session while retaining the query and Field state", async ({ page }) => {
    test.setTimeout(120_000);
    const fixture = await createFixture(page);
    const requests: { after: string | null; query: string | null }[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const url = new URL(request.url());
      if (!url.pathname.endsWith("/extraction-evidence")) return;
      requests.push({ after: url.searchParams.get("after"), query: url.searchParams.get("query") });
    });

    await page.goto(fixture.worksheetPath);
    const fieldA = getField(page, fixture.fieldAId);
    await fieldA.getByLabel("Structured value").fill("Recovery draft value");
    await fieldA.locator("textarea[name='researcherNote']").fill("Recovery draft note");
    await fieldA.getByRole("button", { name: "Browse Evidence to add to Primary outcome" }).click();
    const browserRegion = page.getByRole("region", { name: "Shared Evidence browser" });
    await expect(browserRegion.getByRole("status").filter({ hasText: /Showing 20 candidates/ })).toBeVisible();

    const query = "common exact-search-term";
    await browserRegion.getByLabel("Search Evidence passages and notes").fill(query);
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/evidenceQuery=common\+exact-search-term/);
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    const firstCandidate = browserRegion.locator(".candidate-evidence").first();
    const firstCandidateHref = await firstCandidate.getByRole("link", { name: /Open exact Evidence detail/ }).getAttribute("href");
    const firstCandidateId = firstCandidateHref?.split("/").at(-1);
    expect(firstCandidateId).toBeTruthy();
    const selected = fieldA.locator(`input[name="evidenceIds"][value="${firstCandidateId}"]`);
    await firstCandidate.getByRole("button", { name: "Add to this Field" }).click();
    await expect(selected).toBeChecked();

    const firstRequestAfter = requests.length;
    const invalidCursorUrl = new URL(page.url());
    invalidCursorUrl.searchParams.set("evidenceAfter", "invalid-cursor");
    const firstPageRepairResponse = page.waitForResponse((response) => {
      if (response.request().method() !== "GET") return false;
      const url = new URL(response.url());
      return url.pathname.endsWith("/extraction-evidence")
        && url.searchParams.get("after") === null
        && url.searchParams.get("query") === query;
    });
    await page.evaluate((nextLocation) => {
      window.history.pushState(window.history.state, "", nextLocation);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `${invalidCursorUrl.pathname}${invalidCursorUrl.search}${invalidCursorUrl.hash}`);

    const repairedResponse = await firstPageRepairResponse;
    expect(repairedResponse.status()).toBe(200);
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(browserRegion.locator(".candidate-evidence").first().getByRole("link", { name: /Open exact Evidence detail/ }))
      .toHaveAttribute("href", firstCandidateHref!);
    await expect.poll(() => new URL(page.url()).searchParams.get("evidenceAfter")).toBeNull();
    await expect(page).toHaveURL(/evidenceQuery=common\+exact-search-term/);
    await expect(browserRegion.getByLabel("Search Evidence passages and notes")).toHaveValue(query);
    await expect(selected).toBeChecked();
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Recovery draft value");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Recovery draft note");

    const recoveryRequests = requests.slice(firstRequestAfter);
    await expect.poll(() => recoveryRequests.filter((request) => request.after === "invalid-cursor").length).toBe(1);
    expect(recoveryRequests).toHaveLength(2);
    expect(recoveryRequests.filter((request) => request.after === null && request.query === query)).toHaveLength(1);
    expect(recoveryRequests.every((request) => request.query === query)).toBe(true);
  });

  test("repairs invalid pagination once while retaining valid search and leaves invalid-query cursors alone", async ({ page }) => {
    test.setTimeout(120_000);
    const fixture = await createFixture(page);
    const validUrl = new URL(fixture.worksheetPath, "http://127.0.0.1:3000");
    validUrl.searchParams.set("evidenceField", fixture.fieldAId);
    validUrl.searchParams.set("evidencePageSize", "20");
    validUrl.searchParams.set("evidenceAfter", "invalid-cursor");
    validUrl.searchParams.set("evidenceQuery", "common exact-search-term");
    await page.goto(validUrl.pathname + validUrl.search);
    const browserRegion = page.getByRole("region", { name: "Shared Evidence browser" });
    await expect(browserRegion.getByLabel("Search Evidence passages and notes")).toHaveValue("common exact-search-term");
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect.poll(() => new URL(page.url()).searchParams.get("evidenceAfter")).toBeNull();
    expect(new URL(page.url()).searchParams.get("evidenceQuery")).toBe("common exact-search-term");

    const invalidUrl = new URL(fixture.worksheetPath, "http://127.0.0.1:3000");
    invalidUrl.searchParams.set("evidenceField", fixture.fieldAId);
    invalidUrl.searchParams.set("evidencePageSize", "20");
    invalidUrl.searchParams.set("evidenceAfter", "invalid-cursor");
    invalidUrl.searchParams.set("evidenceQuery", "x".repeat(201));
    await page.goto(invalidUrl.pathname + invalidUrl.search);
    await expect(browserRegion.getByRole("alert")).toContainText("cannot exceed 200 characters");
    await expect.poll(() => new URL(page.url()).searchParams.get("evidenceAfter")).toBe("invalid-cursor");
    expect(new URL(page.url()).searchParams.get("evidenceQuery")).toBe("x".repeat(201));
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(0);

    await page.goto(`${fixture.worksheetPath}?evidenceField=${fixture.fieldAId}&evidencePageSize=20&evidenceAfter=invalid-cursor&evidenceQuery=%ED%A0%80`);
    const decodedQuery = new URL(page.url()).searchParams.get("evidenceQuery");
    expect(decodedQuery).toBe("\uFFFD".repeat(3));
    await expect(browserRegion.getByLabel("Search Evidence passages and notes")).toHaveValue(decodedQuery!);
    await expect.poll(() => new URL(page.url()).searchParams.get("evidenceAfter")).toBeNull();
    await expect(browserRegion.getByRole("alert")).toHaveCount(0);
    const malformedUrlMatch = browserRegion.locator(".candidate-evidence");
    await expect(malformedUrlMatch).toHaveCount(1);
    await expect(malformedUrlMatch).toContainText("Candidate 03");
    const malformedUrlEvidenceHref = await malformedUrlMatch.getByRole("link", { name: /Open exact Evidence detail/ }).getAttribute("href");
    expect(malformedUrlEvidenceHref).toContain(fixture.candidateIds[3]);

    await browserRegion.getByLabel("Search Evidence passages and notes").fill(decodedQuery!);
    await browserRegion.getByRole("button", { name: "Search", exact: true }).click();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(1);
    await expect(browserRegion.locator(".candidate-evidence")).toContainText("Candidate 03");
    await expect(browserRegion.locator(".candidate-evidence").getByRole("link", { name: /Open exact Evidence detail/ }))
      .toHaveAttribute("href", malformedUrlEvidenceHref!);
    expect(new URL(page.url()).searchParams.get("evidenceQuery")).toBe(decodedQuery);
  });
});
