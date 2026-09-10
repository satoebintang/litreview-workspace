import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";

const databaseMarkerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export default async function teardown() {
  if (!fs.existsSync(databaseMarkerPath)) return;
  const marker = JSON.parse(fs.readFileSync(databaseMarkerPath, "utf8")) as { adminUrl: string; databaseName: string; storageRoot?: string };
  if (!/^litreview_playwright_[A-Za-z0-9_]+$/.test(marker.databaseName)) throw new Error(`Refusing to clean unexpected Playwright database name: ${marker.databaseName}`);
  const admin = postgres(marker.adminUrl, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(marker.databaseName)} with (force)`);
    if (marker.storageRoot) {
      const storageRoot = path.resolve(marker.storageRoot);
      const tempRoot = path.resolve(os.tmpdir());
      if (!path.basename(storageRoot).startsWith("litreview_playwright_storage_") || !storageRoot.startsWith(`${tempRoot}${path.sep}`)) throw new Error(`Refusing to clean unexpected Playwright storage root: ${storageRoot}`);
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  } finally {
    await admin.end();
    fs.rmSync(databaseMarkerPath, { force: true });
  }
}
