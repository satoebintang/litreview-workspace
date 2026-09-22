import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { expect, test } from "@playwright/test";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const nativePdf = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "slice15", "native-text-unicode-2page.pdf"));

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

test.describe("Slice 28 PDF-first intake", () => {
  test("stages, inspects, explicitly resolves, and preserves canonical document semantics", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const sql = await getTestDbClient();
    const firstPdf = { name: "first-source.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nfirst retained source\n", "utf8") };
    const secondPdf = { name: "second-source.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nsecond retained source\n", "utf8") };
    const unresolvedPdf = { name: "unresolved-source.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nunresolved retained source\n", "utf8") };
    const duplicatePdf = { name: "duplicate-name.pdf", mimeType: "application/pdf", buffer: firstPdf.buffer };
    try {
      await page.goto("/");
      await page.getByLabel("Project title").fill(`Slice 28 browser ${Date.now()}`);
      await page.getByRole("button", { name: /Create project/ }).click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
      const actualProjectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${actualProjectId}/papers/pdf-intake`);
    await page.locator("#pdf-file").setInputFiles(firstPdf);
    await page.getByRole("button", { name: "Stage PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${actualProjectId}/papers/pdf-intake/[0-9a-f-]+\\?saved=staged$`));
    await expect(page.getByText(/metadata_failed/)).toBeVisible();
    await expect(page.getByText("Create canonical Paper", { exact: true })).toBeVisible();
    const firstIntakeId = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByLabel("Title", { exact: true }).fill("PDF-first canonical study");
    await page.getByRole("button", { name: "Create Paper and attach PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${actualProjectId}/papers/[0-9a-f-]+/documents/[0-9a-f-]+\\?saved=pdf-intake$`));
    const firstPaperId = new URL(page.url()).pathname.match(/\/papers\/([^/]+)\/documents/)?.[1] ?? "";
    expect(firstPaperId).toMatch(/^[0-9a-f-]+$/);

    await page.goto(`/projects/${actualProjectId}/papers/pdf-intake`);
    await page.locator("#pdf-file").setInputFiles(secondPdf);
    await page.getByRole("button", { name: "Stage PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${actualProjectId}/papers/pdf-intake/[0-9a-f-]+\\?saved=staged$`));
    await page.getByLabel("Paper").selectOption(firstPaperId);
    await page.getByRole("button", { name: "Attach to existing Paper" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${actualProjectId}/papers/${firstPaperId}/documents/[0-9a-f-]+\\?saved=pdf-intake$`));

    await page.goto(`/projects/${actualProjectId}/papers/pdf-intake`);
    await page.locator("#pdf-file").setInputFiles(unresolvedPdf);
    await page.getByRole("button", { name: "Stage PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${actualProjectId}/papers/pdf-intake/[0-9a-f-]+\\?saved=staged$`));
    await page.goto(`/projects/${actualProjectId}/screening`);
    await expect(page.getByText("PDF-first canonical study", { exact: true })).toBeVisible();
    await expect(page.getByText("unresolved-source.pdf", { exact: true })).not.toBeVisible();

    await page.goto(`/projects/${actualProjectId}/papers/pdf-intake`);
    await page.locator("#pdf-file").setInputFiles(duplicatePdf);
    await page.getByRole("button", { name: "Stage PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${actualProjectId}/papers/pdf-intake/${firstIntakeId}\\?saved=staged$`));

    const [paperCount] = await sql`select count(*)::integer as count from papers where project_id=${actualProjectId}::uuid`;
    const [documentCount] = await sql`select count(*)::integer as count from full_text_documents where project_id=${actualProjectId}::uuid and paper_id=${firstPaperId}::uuid`;
    const [intakeCount] = await sql`select count(*)::integer as count from pdf_intakes where project_id=${actualProjectId}::uuid`;
    const [resolutionCount] = await sql`select count(*)::integer as count from pdf_intake_resolutions where project_id=${actualProjectId}::uuid`;
    const [preferenceCount] = await sql`select count(*)::integer as count from paper_full_text_preferences where project_id=${actualProjectId}::uuid`;
    expect(paperCount.count).toBe(1);
    expect(documentCount.count).toBe(2);
    expect(intakeCount.count).toBe(3);
    expect(resolutionCount.count).toBe(2);
      expect(preferenceCount.count).toBe(0);
    } finally {
      await sql.end();
    }
  });

  test("follows a resolved PDF through the ordinary FullTextDocument text-extraction workflow", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 28 downstream ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/papers/pdf-intake`);
    await page.locator("#pdf-file").setInputFiles({ name: "native-intake.pdf", mimeType: "application/pdf", buffer: nativePdf });
    await page.getByRole("button", { name: "Stage PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/papers/pdf-intake/[0-9a-f-]+\\?saved=staged$`));
    await page.getByLabel("Title", { exact: true }).fill("Native text intake study");
    await page.getByRole("button", { name: "Create Paper and attach PDF" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/papers/[0-9a-f-]+/documents/[0-9a-f-]+\\?saved=pdf-intake$`));
    await page.getByRole("button", { name: "Extract text" }).click();
    await expect(page).toHaveURL(/\/extractions\/[0-9a-f-]+\?saved=extracted$/);
    await expect(page.getByRole("status")).toHaveText("Text extraction completed.");
    await expect(page.locator("pre").first()).toContainText("Slice 15 page one ASCII");
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  });

  test("keeps GET read-only and exposes explicit initial metadata inspection recovery", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const sql = await getTestDbClient();
    const markerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { storageRoot: string };
    try {
      await page.goto("/");
      await page.getByLabel("Project title").fill(`Slice 28 recovery ${Date.now()}`);
      await page.getByRole("button", { name: /Create project/ }).click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
      const projectId = new URL(page.url()).pathname.split("/").pop()!;
      const intakeId = randomUUID();
      const storageKey = `projects/${projectId}/pdf-intakes/${intakeId}/source.pdf`;
      const storedPath = path.join(marker.storageRoot, ...storageKey.split("/"));
      fs.mkdirSync(path.dirname(storedPath), { recursive: true });
      fs.writeFileSync(storedPath, nativePdf);
      await sql`
        insert into pdf_intakes (id, project_id, storage_key, original_filename, media_type, byte_size, sha256)
        values (${intakeId}, ${projectId}, ${storageKey}, 'recovery-fixture.pdf', 'application/pdf', ${nativePdf.byteLength}, ${createHash("sha256").update(nativePdf).digest("hex")})
      `;
      await page.goto(`/projects/${projectId}/papers/pdf-intake/${intakeId}`);
      await expect(page.getByText("Metadata inspection pending", { exact: true })).toBeVisible();
      const [before] = await sql`select count(*)::integer as count from pdf_intake_metadata_results where intake_id=${intakeId}`;
      expect(before.count).toBe(0);
      await page.reload();
      const [afterReload] = await sql`select count(*)::integer as count from pdf_intake_metadata_results where intake_id=${intakeId}`;
      expect(afterReload.count).toBe(0);
      await page.getByRole("button", { name: "Inspect metadata" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/papers/pdf-intake/${intakeId}\\?saved=inspected$`));
      const [afterInspect] = await sql`select count(*)::integer as count, min(sequence_no)::integer as sequence_no from pdf_intake_metadata_results where intake_id=${intakeId}`;
      expect(afterInspect.count).toBe(1);
      expect(afterInspect.sequence_no).toBe(1);
      await page.reload();
      await expect(page.getByRole("button", { name: "Inspect metadata" })).not.toBeVisible();
    } finally {
      await sql.end();
    }
  });
});
