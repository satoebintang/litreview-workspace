import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { expect, test } from "@playwright/test";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";

async function getTestDbClient() {
  const markerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.adminUrl && marker.databaseName) return postgres(`${marker.adminUrl.replace(/\/[^/]+$/, "")}/${marker.databaseName}`, { max: 1, prepare: false });
    } catch {
      // Fall back to the configured test database.
    }
  }
  return postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 1, prepare: false });
}

test.describe("Slice 27 bibliographic intake", () => {
  test("imports, explicitly resolves, preserves history, and exports canonical Papers", async ({ page, request }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const sql = await getTestDbClient();
    const projectId = randomUUID();
    const existingPaperId = randomUUID();
    const alternatePaperId = randomUUID();
    const source = Buffer.from(`@article{existing,\n  title = {Existing work},\n  author = {Existing, Author},\n  year = {2020},\n  doi = {10.1000/existing}\n}\n@article{new,\n  title = {New imported work},\n  author = {New, Author},\n  year = {2024}\n}\n@article{unresolved,\n  title = {Leave unresolved}\n}\n`, "utf8");
    try {
      await sql.begin(async (tx) => {
        await tx`insert into projects (id, title) values (${projectId}::uuid, 'Slice 27 browser intake')`;
        await tx`insert into papers (id, project_id, title, authors, publication_year, doi) values (${existingPaperId}::uuid, ${projectId}::uuid, 'Existing work', ${["Author Existing"]}::text[], 2020, '10.1000/existing')`;
        await tx`insert into papers (id, project_id, title, authors, publication_year) values (${alternatePaperId}::uuid, ${projectId}::uuid, 'Alternate work', ${["Author Alternate"]}::text[], 2021)`;
      });

      await page.goto(`/projects/${projectId}/papers/imports/upload`);
      await page.locator("#import-file").setInputFiles({ name: "refs.bib", mimeType: "application/x-bibtex", buffer: source });
      await page.getByRole("button", { name: "Import records" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/papers/imports/[0-9a-f-]+$`));
      await expect(page.getByText("3 records", { exact: false })).toBeVisible();

      const parsedRecords = page.locator("section").filter({ has: page.getByRole("heading", { name: "Parsed records" }) });
      const existing = parsedRecords.locator(".item").filter({ hasText: "Existing work" }).first();
      await existing.locator("select[name=paperId]").selectOption(existingPaperId);
      await existing.getByRole("button", { name: "Match existing Paper" }).click();
      await expect(page.getByText("Current Paper:", { exact: false })).toBeVisible();
      await existing.getByRole("button", { name: "Clear resolution" }).click();
      await expect(existing.locator(".status")).toHaveText("unresolved");
      await existing.locator("select[name=paperId]").selectOption(alternatePaperId);
      await existing.getByRole("button", { name: "Match existing Paper" }).click();
      await expect(existing.getByText(/Resolution history \(3\)/)).toBeVisible();
      await expect(existing.getByText(/cleared/)).toBeVisible();

      const created = parsedRecords.locator(".item").filter({ hasText: "New imported work" }).first();
      await created.getByRole("button", { name: "Create canonical Paper" }).click();
      await expect(created.locator(".status")).toHaveText("resolved");

      const exportResponse = await request.get(`/projects/${projectId}/papers/export`);
      expect(exportResponse.ok()).toBeTruthy();
      const exported = await exportResponse.text();
      expect(exported).toContain("Existing work");
      expect(exported).toContain("New imported work");
      expect(exported).not.toContain("Leave unresolved");

      await page.goto(`/projects/${projectId}/papers/imports`);
      await expect(page.getByText("refs.bib", { exact: true })).toBeVisible();
      await expect(page.getByText(/2 resolved/)).toBeVisible();
      await page.goto(`/projects/${projectId}`);
      const paperCollection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Paper collection" }) });
      await expect(paperCollection.getByText("Existing work", { exact: true })).toBeVisible();
      await expect(paperCollection.getByText("Alternate work", { exact: true })).toBeVisible();
    } finally {
      await sql.end();
    }
  });

  test("previews and atomically bulk-creates Papers, rejecting a stale confirmation", async ({ page, request }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const sql = await getTestDbClient();
    const projectId = randomUUID();
    const stalePaperId = randomUUID();
    const source = Buffer.from([
      "@article{bulk-one, title={Bulk browser one}, author={One, Author}, year={2020}}",
      "@article{bulk-two, title={Bulk browser two}, author={Two, Author}, year={2021}}",
      "@article{bulk-three, title={Bulk browser three}, author={Three, Author}, year={2022}}",
    ].join("\n"), "utf8");
    try {
      await sql`insert into projects (id, title) values (${projectId}::uuid, 'Slice 27 browser bulk')`;
      await page.goto(`/projects/${projectId}/papers/imports/upload`);
      await page.locator("#import-file").setInputFiles({ name: "bulk.bib", mimeType: "application/x-bibtex", buffer: source });
      await page.getByRole("button", { name: "Import records" }).click();
      await expect(page.getByText("3 records", { exact: false })).toBeVisible();
      const bulkRecords = page.locator('input[name="bulkRecordId"]');
      for (let index = 0; index < await bulkRecords.count(); index += 1) await bulkRecords.nth(index).check();
      await page.getByRole("button", { name: "Preview bulk creation" }).click();
      await expect(page.getByRole("heading", { name: /Bulk preview · 3 selected/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Confirm bulk creation" })).toBeVisible();
      await page.getByRole("button", { name: "Confirm bulk creation" }).click();
      await expect(page.getByText("Bulk Paper creation committed.", { exact: true })).toBeVisible();
      await page.goto(`/projects/${projectId}/screening`);
      await expect(page.getByText("Bulk browser one", { exact: true })).toBeVisible();
      await expect(page.getByText("Bulk browser two", { exact: true })).toBeVisible();
      await expect(page.getByText("Bulk browser three", { exact: true })).toBeVisible();

      const staleSource = Buffer.from("@article{stale, title={Bulk stale browser}, author={Stale, Author}}", "utf8");
      await page.goto(`/projects/${projectId}/papers/imports/upload`);
      await page.locator("#import-file").setInputFiles({ name: "stale.bib", mimeType: "application/x-bibtex", buffer: staleSource });
      await page.getByRole("button", { name: "Import records" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/papers/imports/[0-9a-f-]+$`));
      await expect(page.getByText("1 records", { exact: false })).toBeVisible();
      const staleBulkRecords = page.locator('input[name="bulkRecordId"]');
      for (let index = 0; index < await staleBulkRecords.count(); index += 1) await staleBulkRecords.nth(index).check();
      await page.getByRole("button", { name: "Preview bulk creation" }).click();
      await expect(page.getByRole("button", { name: "Confirm bulk creation" })).toBeVisible();
      await sql`insert into papers (id, project_id, title, authors) values (${stalePaperId}::uuid, ${projectId}::uuid, 'Bulk stale browser', ${["Stale Author"]}::text[])`;
      await page.getByRole("button", { name: "Confirm bulk creation" }).click();
      await expect(page.getByText(/Bulk creation blocked/)).toBeVisible();
      const staleExport = await (await request.get(`/projects/${projectId}/papers/export`)).text();
      expect(staleExport).toContain("Bulk stale browser");
      expect(staleExport.match(/Bulk stale browser/g)?.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  test("supports a RIS browser smoke path", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const sql = await getTestDbClient();
    const projectId = randomUUID();
    const source = Buffer.from("TY  - JOUR\nTI  - RIS browser smoke\nAU  - Smoke, Author\nPY  - 2024\nER  -\n", "utf8");
    try {
      await sql`insert into projects (id, title) values (${projectId}::uuid, 'Slice 27 browser RIS')`;
      await page.goto(`/projects/${projectId}/papers/imports/upload`);
      await page.locator("#import-format").selectOption("ris");
      await page.locator("#import-file").setInputFiles({ name: "smoke.ris", mimeType: "text/plain", buffer: source });
      await page.getByRole("button", { name: "Import records" }).click();
      const parsedRecords = page.locator("section").filter({ has: page.getByRole("heading", { name: "Parsed records" }) });
      await expect(parsedRecords.getByText("RIS browser smoke", { exact: true })).toBeVisible();
      const record = parsedRecords.locator(".item").filter({ hasText: "RIS browser smoke" }).first();
      await record.getByRole("button", { name: "Create canonical Paper" }).click();
      await expect(record.locator(".status")).toHaveText("resolved");
    } finally {
      await sql.end();
    }
  });
});
