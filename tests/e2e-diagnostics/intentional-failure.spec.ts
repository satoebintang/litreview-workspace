import { expect, test } from "@playwright/test";

test("SLICE56_SYNTHETIC_FAILURE_PROBE creates only synthetic browser diagnostics", async ({ page }) => {
  await page.setContent("<main><h1>Slice 56 synthetic diagnostics probe</h1><p>No researcher content.</p></main>");
  await expect(page.getByRole("heading", { name: "Slice 56 synthetic diagnostics probe" })).toBeVisible();
  expect("SLICE56_INTENTIONAL_FAILURE").toBe("SLICE56_EXPECTED_VALUE");
});
