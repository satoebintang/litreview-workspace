import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  PDFJS_ALGORITHM_VERSION,
  PDFJS_EXTRACTOR_KEY,
  PDFJS_EXTRACTOR_VERSION,
} from "@/infrastructure/pdfjs-text-extractor";

const fixtureDirectory = path.join(process.cwd(), "tests", "fixtures", "slice15");

const fixtureSha256 = {
  "native-text-unicode-2page.pdf": "83755B7739D105CBD182F811935544B6373C1689DA69AF9954267C62A0A1CC09",
  "unicode-cjk-2page.pdf": "27A33523F62DE13EC36CEE1D828E6D9ED8B98A270EAED9BA1382CDCE88F79953",
  "image-only-no-text.pdf": "747CC8A372CD943A18912A2BA45B335ABD7CB5CECA842BCBAD5A3DD111BCFFFD",
  "encrypted-password.pdf": "A09C7994DECE236B8E66756F0E01AB9EBBA20E50E0C3F0D4B85858DF42D6DE52",
  "malformed.pdf": "6F52474DB46424AE532A87DCFE8BD85F025C439BFA3219414EBA333A0E1374E0",
} as const;

async function fixture(name: keyof typeof fixtureSha256): Promise<Buffer> {
  const bytes = await readFile(path.join(fixtureDirectory, name));
  expect(createHash("sha256").update(bytes).digest("hex").toUpperCase()).toBe(fixtureSha256[name]);
  return bytes;
}

describe("pdfjs-dist text extraction adapter", () => {
  it("exposes the pinned parser and algorithm identity", () => {
    expect(PDFJS_EXTRACTOR_KEY).toBe("pdfjs");
    expect(PDFJS_EXTRACTOR_VERSION).toBe("6.3.289");
    expect(PDFJS_ALGORITHM_VERSION).toBe("pdfjs-text-v1");
  });

  it("checksums the committed fixtures and extracts native text deterministically", async () => {
    const bytes = await fixture("native-text-unicode-2page.pdf");
    const first = await extractPdfText(bytes);
    const second = await extractPdfText(bytes);
    expect(first).toEqual(second);
    expect(first.status).toBe("succeeded");
    expect(first.pageCount).toBe(2);
    expect(first.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(first.pages.every((page) => page.status === "succeeded")).toBe(true);
    expect(first.pages[0]?.text).toContain("Slice 15 page one ASCII");
    expect(first.pages[1]?.text).toContain("Line boundary fixture beta");
    expect(first.pages[0]?.text.includes("\r")).toBe(false);
  });

  it("preserves Unicode text and page boundaries without grapheme normalization", async () => {
    const result = await extractPdfText(await fixture("unicode-cjk-2page.pdf"));
    expect(result.status).toBe("succeeded");
    expect(result.pageCount).toBe(2);
    expect(result.pages[0]?.text).toContain("CJK 日本語");
    expect(result.pages[0]?.text).toContain("Astral emoji");
    expect(result.pages[1]?.text).toContain("Second page alpha");
    expect(result.pages[0]?.text.includes("\r")).toBe(false);
  });

  it("treats a valid image-only PDF as succeeded with an empty text page", async () => {
    const result = await extractPdfText(await fixture("image-only-no-text.pdf"));
    expect(result).toMatchObject({ status: "succeeded", pageCount: 1, characterCount: 0, error: null });
    expect(result.pages).toEqual([
      expect.objectContaining({ pageNumber: 1, status: "succeeded", text: "", characterCount: 0 }),
    ]);
  });

  it("returns a global failed result with no rows for malformed and wrong-password PDFs", async () => {
    const malformed = await extractPdfText(await fixture("malformed.pdf"));
    expect(malformed.status).toBe("failed");
    expect(malformed.pages).toEqual([]);
    expect(malformed.pageCount).toBeNull();
    expect(malformed.error?.code).toBe("InvalidPDFException");

    const encrypted = await extractPdfText(await fixture("encrypted-password.pdf"), { password: "wrong-password" });
    expect(encrypted.status).toBe("failed");
    expect(encrypted.pages).toEqual([]);
    expect(encrypted.error?.code).toBe("PasswordException");
  });

  it("extracts the same bytes from a non-zero-offset Buffer view", async () => {
    const bytes = await fixture("native-text-unicode-2page.pdf");
    const padded = Buffer.concat([Buffer.from([0xde, 0xad, 0xbe]), bytes, Buffer.from([0xef, 0xfe])]);
    const view = padded.subarray(3, 3 + bytes.byteLength);
    const result = await extractPdfText(view);
    expect(result.status).toBe("succeeded");
    expect(result.pages.map((page) => page.text)).toEqual((await extractPdfText(bytes)).pages.map((page) => page.text));
  });

  it("returns a failed zero-page result when cancelled before parsing", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await extractPdfText(await fixture("native-text-unicode-2page.pdf"), { signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", pages: [], pageCount: null });
    expect(result.error?.code).toBe("cancelled");
  });
});

