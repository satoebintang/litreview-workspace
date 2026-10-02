import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { createPlaywrightTestDatabaseClient, resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

type SeededPaper = { id: string; title: string };

async function seedPapers(
  client: ReturnType<typeof createPlaywrightTestDatabaseClient>,
  projectId: string,
  prefix: string,
  count: number,
): Promise<SeededPaper[]> {
  const rows = await client`
    insert into papers (project_id, title, authors, publication_year, abstract, created_at, updated_at)
    select ${projectId}::uuid,
      ${prefix} || ' Paper ' || lpad(series::text, 2, '0'),
      array['Screening Author ' || series::text],
      2024,
      ${prefix} || ' abstract ' || series::text,
      '2020-01-01T00:00:00Z'::timestamptz + (series - 1) * interval '1 day',
      '2020-01-01T00:00:00Z'::timestamptz + (series - 1) * interval '1 day'
    from generate_series(1, ${count}) as series
    returning id, title
  ` as unknown as SeededPaper[];
  return rows.sort((left, right) => left.title.localeCompare(right.title));
}

test.describe("Slice 44 title/abstract screening reads", () => {
  test("pages default and filtered queues, resets state changes, and keeps Start independent", async ({ page }) => {
    test.setTimeout(180_000);
    const suffix = randomUUID();
    const database = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(database.db);
    const seedClient = createPlaywrightTestDatabaseClient({ prepare: false });

    try {
      const project = await services.createProject({ title: `Slice 44 screening queue ${suffix}` });
      const prefix = `Slice44 ${suffix}`;
      const papers = await seedPapers(seedClient, project.id, prefix, 55);
      await seedClient`
        insert into screening_decisions (project_id, paper_id, decision)
        select ${project.id}::uuid, id, 'include'
        from papers
        where project_id = ${project.id}::uuid
          and title like ${prefix} || ' Paper __'
          and right(title, 2)::integer <= 52
      `;

      const dashboardUrl = `/projects/${project.id}/screening`;
      await page.goto(dashboardUrl);
      await expect(page.getByRole("heading", { name: "Title/abstract screening" })).toBeVisible();
      await expect(page.getByText("Papers 1–50 of 55", { exact: true })).toBeVisible();
      await expect(page.locator(".item-list .item")).toHaveCount(50);
      await expect(page.getByRole("link", { name: "Start screening" })).toHaveAttribute("href", `${dashboardUrl}/${papers[52].id}`);

      const pagination = page.getByRole("navigation", { name: "Screening queue pagination" });
      await expect(pagination.getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
      await pagination.getByRole("link", { name: "Next page" }).click();
      await expect(page).toHaveURL(`${dashboardUrl}?page=2`);
      await expect(page.getByText("Papers 51–55 of 55", { exact: true })).toBeVisible();
      await expect(page.locator(".item-list .item")).toHaveCount(5);

      const includedFilter = page.locator(".screening-stats .screening-stat").filter({ hasText: "included" });
      await includedFilter.click();
      await expect(page).toHaveURL(`${dashboardUrl}?state=included`);
      await expect(page.getByText("Papers 1–50 of 52", { exact: true })).toBeVisible();
      await expect(page.locator(".item-list .item")).toHaveCount(50);
      const includedPagination = page.getByRole("navigation", { name: "Screening queue pagination" });
      await expect(includedPagination.getByRole("link", { name: "Next page" })).toHaveAttribute("href", `${dashboardUrl}?state=included&page=2`);
      await includedPagination.getByRole("link", { name: "Next page" }).click();
      await expect(page).toHaveURL(`${dashboardUrl}?state=included&page=2`);
      await expect(page.getByText("Papers 51–52 of 52", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Start screening" })).toHaveAttribute("href", `${dashboardUrl}/${papers[52].id}`);

      await page.locator(".filter-row").getByRole("link", { name: "unscreened", exact: true }).click();
      await expect(page).toHaveURL(`${dashboardUrl}?state=unscreened`);
      await expect(page.getByText("Papers 1–3 of 3", { exact: true })).toBeVisible();
      await expect(page.locator(".item-list .item")).toHaveCount(3);

      await page.goto(`${dashboardUrl}/${papers[52].id}`);
      await expect(page.getByText("Title/abstract screening · Paper 53 of 55", { exact: true })).toBeVisible();
      const paperNavigation = page.getByRole("navigation", { name: "Screening paper navigation" });
      await expect(paperNavigation.getByRole("link", { name: "← Previous" })).toHaveAttribute("href", `${dashboardUrl}/${papers[51].id}`);
      await expect(paperNavigation.getByRole("link", { name: "Next →" })).toHaveAttribute("href", `${dashboardUrl}/${papers[53].id}`);
    } finally {
      await seedClient.end();
      await database.client.end();
    }
  });

  test("uses the first Paper after all are screened and refreshes decisions with project-wide navigation", async ({ page }) => {
    test.setTimeout(120_000);
    const suffix = randomUUID();
    const database = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(database.db);
    const seedClient = createPlaywrightTestDatabaseClient({ prepare: false });

    try {
      const project = await services.createProject({ title: `Slice 44 screening detail ${suffix}` });
      const prefix = `Slice44 ${suffix}`;
      const papers = await seedPapers(seedClient, project.id, prefix, 3);
      await seedClient`
        insert into screening_decisions (project_id, paper_id, decision)
        select ${project.id}::uuid, id,
          case right(title, 2) when '01' then 'include' else 'maybe' end
        from papers
        where project_id = ${project.id}::uuid
          and title like ${prefix} || ' Paper __'
          and right(title, 2) in ('01', '03')
      `;

      const dashboardUrl = `/projects/${project.id}/screening`;
      await page.goto(dashboardUrl);
      await expect(page.getByText("Papers 1–3 of 3", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Start screening" })).toHaveAttribute("href", `${dashboardUrl}/${papers[1].id}`);

      await page.getByRole("link", { name: "Start screening" }).click();
      await expect(page).toHaveURL(`${dashboardUrl}/${papers[1].id}`);
      await expect(page.getByText("Title/abstract screening · Paper 2 of 3", { exact: true })).toBeVisible();
      const navigation = page.getByRole("navigation", { name: "Screening paper navigation" });
      await expect(navigation.getByRole("link", { name: "← Previous" })).toHaveAttribute("href", `${dashboardUrl}/${papers[0].id}`);
      await expect(navigation.getByRole("link", { name: "Next →" })).toHaveAttribute("href", `${dashboardUrl}/${papers[2].id}`);

      await page.getByRole("button", { name: "Include", exact: true }).click();
      await expect(page).toHaveURL(`${dashboardUrl}/${papers[1].id}?saved=decision`);
      await expect(page.getByRole("status")).toContainText("Decision recorded in screening history.");
      await expect(page.locator(".status.screening-included")).toBeVisible();
      const history = page.locator("section.card.section-card.full");
      await expect(history.getByText("1 shown", { exact: true })).toBeVisible();
      await expect(history.getByText("INCLUDE", { exact: true })).toBeVisible();

      await page.goto(dashboardUrl);
      await expect(page.locator(".screening-stats .screening-stat").filter({ hasText: "included" })).toContainText("2");
      await expect(page.locator(".screening-stats .screening-stat").filter({ hasText: "unscreened" })).toContainText("0");
      await expect(page.getByRole("link", { name: "Start screening" })).toHaveAttribute("href", `${dashboardUrl}/${papers[0].id}`);
    } finally {
      await seedClient.end();
      await database.client.end();
    }
  });
});
