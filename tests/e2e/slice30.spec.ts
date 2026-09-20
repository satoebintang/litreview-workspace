import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";

async function getTestDbClient() {
  const markerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.adminUrl && marker.databaseName) return postgres(`${marker.adminUrl.replace(/\/[^/]+$/, "")}/${marker.databaseName}`, { max: 1 });
    } catch {
      // Fall through to the configured test database.
    }
  }
  return postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 1 });
}

test.describe("Slice 30 DOI metadata lookup", () => {
  test("keeps provider metadata bounded until explicit canonical Paper creation", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const unique = Date.now();
    const doi = "10.1234/tracework-slice30";

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 30 browser review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    await page.goto(`/projects/${projectId}/papers/doi-intake`);
    await page.getByLabel("DOI").fill(doi);
    await page.getByRole("button", { name: "Start bounded DOI lookup" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/papers/doi-intake/[0-9a-f-]+$`));
    await expect(page.getByRole("button", { name: "Execute bounded lookup" })).toBeVisible();

    await page.getByRole("button", { name: "Execute bounded lookup" }).click();
    await expect(page.getByRole("heading", { name: "Bounded proposal" })).toBeVisible();
    await expect(page.getByText("Deterministic Crossref DOI fixture", { exact: true })).toBeVisible();
    await expect(page.getByText("Create canonical Paper", { exact: true })).toBeVisible();

    const requestId = page.url().match(/doi-intake\/([0-9a-f-]+)$/)?.[1] as string;
    const db = await getTestDbClient();
    try {
      const [beforeResolution] = await db`select count(*)::int as count from papers where project_id=${projectId}`;
      expect(Number(beforeResolution.count)).toBe(0);
      const [rawPayload] = await db`select source_snapshot::text as snapshot from bibliographic_metadata_fetch_results r join bibliographic_metadata_fetches f on f.id=r.fetch_id join doi_lookup_dispatches d on d.fetch_id=f.id where d.project_id=${projectId} and d.request_id=${requestId}::uuid order by d.sequence desc limit 1`;
      expect(String(rawPayload.snapshot)).not.toMatch(/abstract|references|raw/i);
      const [attempt] = await db`select request_url from bibliographic_metadata_http_attempts a join bibliographic_metadata_fetches f on f.id=a.fetch_id join doi_lookup_dispatches d on d.fetch_id=f.id where d.project_id=${projectId} and d.request_id=${requestId}::uuid order by a.attempt_ordinal limit 1`;
      expect(String(attempt.request_url)).not.toMatch(/mailto=/i);
    } finally {
      await db.end();
    }

    await page.getByRole("button", { name: "Create canonical Paper" }).click();
    await expect(page.getByRole("status")).toContainText("Resolution recorded.");
    await expect(page.getByText("created_paper", { exact: false }).last()).toBeVisible();

    const afterDb = await getTestDbClient();
    try {
      const [paper] = await afterDb`select id, title, doi from papers where project_id=${projectId}`;
      expect(paper.title).toBe("Deterministic Crossref DOI fixture");
      expect(paper.doi).toBe(doi);
      const [resolution] = await afterDb`select resolution_kind, paper_id from doi_lookup_resolutions where project_id=${projectId} and request_id=${requestId}::uuid order by sequence desc limit 1`;
      expect(resolution.resolution_kind).toBe("created_paper");
      expect(resolution.paper_id).toBe(paper.id);
    } finally {
      await afterDb.end();
    }
  });
});
