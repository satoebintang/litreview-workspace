import { type Locator, type Page } from "@playwright/test";
import { selectPaper } from "./paper-picker";

export async function selectEvidencePaper(page: Page, title: string, within: Page | Locator = page) {
  const picker = within.locator(".evidence-paper-picker").first();
  await selectPaper(title, picker);
}
