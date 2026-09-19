import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectPdfMetadata,
  isLowInformationPdfTitle,
  extractPdfDoiCandidate,
  normalizePdfDoiCandidate,
  mapPdfMetadataFromParsed,
  PDF_METADATA_LIMITS,
  PDF_METADATA_INSPECTOR_KEY,
  PDF_METADATA_INSPECTOR_VERSION,
} from "@/infrastructure/pdf-metadata-inspector";

const fixtures = path.join(process.cwd(), "tests", "fixtures", "slice15");

describe("bounded PDF metadata inspector", () => {
  const metadata = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

  it("uses the public PDF.js metadata contract and limits page inspection", async () => {
    const bytes = await readFile(path.join(fixtures, "native-text-unicode-2page.pdf"));
    const result = await inspectPdfMetadata(bytes, { limits: { maxPhysicalPages: 1 } });
    expect(result.status).toBe("succeeded");
    expect(result.inspectorKey).toBe(PDF_METADATA_INSPECTOR_KEY);
    expect(result.inspectorVersion).toBe("6.3.289");
    expect(PDF_METADATA_INSPECTOR_VERSION).toBe("6.3.289");
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1]);
    expect(result.metadata.title).toBe("untitled");
    expect(result.fields.title.source?.kind).toBe("info");
    expect(result.fields.title.diagnostic).toBe("low_information_embedded_title");
  });

  it("returns metadata_failed after a PDF signature has been accepted but parsing fails", async () => {
    const bytes = await readFile(path.join(fixtures, "malformed.pdf"));
    const result = await inspectPdfMetadata(bytes);
    expect(result.status).toBe("metadata_failed");
    expect(result.error?.code).toBe("InvalidPDFException");
    expect(result.pages).toEqual([]);
  });

  it("rejects retained bytes beyond the bounded parser limit", async () => {
    const result = await inspectPdfMetadata(new Uint8Array(6), { limits: { maxInputBytes: 5 } });
    expect(result.status).toBe("metadata_failed");
    expect(result.error?.code).toBe("input_too_large");
  });

  it("maps supported XMP and Info fields without treating file timestamps or producer metadata as bibliography", () => {
    const xmp = metadata({
      "dc:title": "XMP title",
      "dc:creator": ["Ada Lovelace", "Grace Hopper"],
      "dc:description": "An embedded abstract.",
      "prism:publicationDate": "2024-05-01",
      "prism:publicationName": "Journal of Deterministic Tests",
    });
    const info = {
      Title: "Info title",
      Author: "Opaque Author String",
      CreationDate: "D:20200101000000Z",
      ModDate: "D:20240101000000Z",
      Producer: "A PDF producer",
      Creator: "Microsoft Word",
    };
    const mapped = mapPdfMetadataFromParsed(info, xmp, [], PDF_METADATA_LIMITS);
    expect(mapped.metadata.title).toBe("XMP title");
    expect(mapped.fields.title.source?.kind).toBe("xmp");
    expect(mapped.metadata.authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(mapped.fields.authors.provenance.map((value) => value.kind)).toEqual(["xmp", "xmp"]);
    expect(mapped.metadata.abstract).toBe("An embedded abstract.");
    expect(mapped.metadata.publicationYear).toBe(2024);
    expect(mapped.metadata.venue).toBe("Journal of Deterministic Tests");
    expect(mapped.fields.venue.provenance[0]?.key).toBe("prism:publicationName");
  });

  it("maps opaque Info Author conservatively and ignores Info dates, Producer, and Creator", () => {
    const mapped = mapPdfMetadataFromParsed({
      Title: "Info-only title",
      Author: "Smith, John, Doe, Jane",
      CreationDate: "D:20200101000000Z",
      ModDate: "D:20240101000000Z",
      Producer: "Journal Publisher",
      Creator: "Microsoft Word",
    }, metadata({}), [], PDF_METADATA_LIMITS);
    expect(mapped.metadata.title).toBe("Info-only title");
    expect(mapped.metadata.authors).toEqual(["Smith, John, Doe, Jane"]);
    expect(mapped.fields.authors.provenance[0]).toMatchObject({ kind: "info", key: "Author", ambiguous: true });
    expect(mapped.metadata.publicationYear).toBeNull();
    expect(mapped.metadata.venue).toBeNull();
    expect(mapped.metadata.abstract).toBeNull();
  });

  it("preserves ordered structured XMP creator values", () => {
    const mapped = mapPdfMetadataFromParsed({}, metadata({ "dc:creator": [{ value: "Ada Lovelace" }, { value: "Grace Hopper" }] }), [], PDF_METADATA_LIMITS);
    expect(mapped.metadata.authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  it("prefers XMP title while retaining Info provenance only when it is the selected source", () => {
    const equal = mapPdfMetadataFromParsed({ Title: "Same title" }, metadata({ "dc:title": "Same title" }), [], PDF_METADATA_LIMITS);
    expect(equal.fields.title.source).toMatchObject({ kind: "xmp", key: "dc:title" });
    const conflicting = mapPdfMetadataFromParsed({ Title: "Info title" }, metadata({ "dc:title": "XMP title" }), [], PDF_METADATA_LIMITS);
    expect(conflicting.metadata.title).toBe("XMP title");
    expect(conflicting.fields.title.source).toMatchObject({ kind: "xmp", key: "dc:title" });
  });

  it.each([
    "untitled",
    " Document ",
    "DOCUMENT1",
    "Microsoft Word - manuscript.docx",
    "microsoft word - manuscript.doc",
  ])("diagnoses low-information title %s", (value) => {
    expect(isLowInformationPdfTitle(value)).toBe(true);
    const mapped = mapPdfMetadataFromParsed({}, metadata({ "dc:title": value }), [], PDF_METADATA_LIMITS);
    expect(mapped.metadata.title).toBe(value.trim());
    expect(mapped.fields.title.diagnostic).toBe("low_information_embedded_title");
  });

  it.each(["Documentary Analysis", "Document 2: A study", "A document about review methods"])('does not reject legitimate title "%s"', (value) => {
    expect(isLowInformationPdfTitle(value)).toBe(false);
  });

  it("keeps DOI extraction cleanup separate from shared comparison normalization", () => {
    expect(extractPdfDoiCandidate("doi:10.1000/ABC.")).toBe("10.1000/ABC");
    expect(extractPdfDoiCandidate("https://doi.org/10.1000/ABC]")).toBe("10.1000/ABC");
    expect(extractPdfDoiCandidate("https://dx.doi.org/10.1000/ABC(foo)")).toBe("10.1000/ABC(foo)");
    expect(normalizePdfDoiCandidate("DOI 10.1000/ABC.")).toBe("10.1000/abc");
  });

  it("groups raw DOI spellings by the shared normalized identity", () => {
    const mapped = mapPdfMetadataFromParsed({}, metadata({ "dc:identifier": ["10.1000/ABC", "doi:10.1000/abc.", "https://doi.org/10.1000/ABC"] }), [], PDF_METADATA_LIMITS);
    expect(mapped.metadata.doi).toBe("10.1000/abc");
    expect(mapped.fields.doi.provenance).toHaveLength(3);
    expect(mapped.fields.doi.provenance.map((candidate) => candidate.normalizedValue)).toEqual(["10.1000/abc", "10.1000/abc", "10.1000/abc"]);
  });

  it("records exact Unicode code-point offsets for page DOI provenance", () => {
    const text = "中文 😀 DOI 10.1000/ABC";
    const mapped = mapPdfMetadataFromParsed({}, metadata({}), [{ pageNumber: 1, text, characterCount: Array.from(text).length, error: null }], PDF_METADATA_LIMITS);
    const source = mapped.fields.doi.provenance[0];
    expect(source?.pageNumber).toBe(1);
    expect(source?.startOffset).toBe(Array.from("中文 😀 DOI ").length);
    expect(source?.endOffset).toBe(Array.from(text).length);
    expect(Array.from(text).slice(source!.startOffset!, source!.endOffset!).join("")).toBe(source?.rawValue);
  });

  it("bounds DOI occurrences at 50 and keeps the capped result non-authoritative", () => {
    const text = Array.from({ length: 51 }, () => "10.1000/same").join(" ");
    const mapped = mapPdfMetadataFromParsed({}, metadata({}), [{ pageNumber: 1, text, characterCount: Array.from(text).length, error: null }], PDF_METADATA_LIMITS);
    expect(mapped.fields.doi.provenance).toHaveLength(50);
    expect(mapped.fields.doi.value).toBeNull();
    expect(mapped.fields.doi.diagnostic).toContain("doi_occurrence_limit_exhausted");
  });

  it("accepts exactly 50 DOI occurrences when they have one normalized identity", () => {
    const text = Array.from({ length: 50 }, (_, index) => index % 2 === 0 ? "doi:10.1000/boundary." : "https://doi.org/10.1000/BOUNDARY").join(" ");
    const mapped = mapPdfMetadataFromParsed({}, metadata({}), [{ pageNumber: 1, text, characterCount: Array.from(text).length, error: null }], PDF_METADATA_LIMITS);
    expect(mapped.fields.doi.provenance).toHaveLength(50);
    expect(mapped.fields.doi.value).toBe("10.1000/boundary");
    expect(mapped.fields.doi.diagnostic).toBeNull();
  });

  it("bounds distinct DOI identities at 20 while preserving bounded ambiguity", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `10.1000/value-${index}`).join(" ");
    const bounded = mapPdfMetadataFromParsed({}, metadata({}), [{ pageNumber: 1, text: twenty, characterCount: Array.from(twenty).length, error: null }], PDF_METADATA_LIMITS);
    expect(bounded.fields.doi.provenance).toHaveLength(20);
    expect(bounded.fields.doi.value).toBeNull();
    expect(bounded.fields.doi.diagnostic).toBe("multiple_distinct_doi_candidates");

    const twentyOne = `${twenty} 10.1000/value-20`;
    const capped = mapPdfMetadataFromParsed({}, metadata({}), [{ pageNumber: 1, text: twentyOne, characterCount: Array.from(twentyOne).length, error: null }], PDF_METADATA_LIMITS);
    expect(capped.fields.doi.provenance).toHaveLength(20);
    expect(capped.fields.doi.value).toBeNull();
    expect(capped.fields.doi.diagnostic).toContain("doi_distinct_candidate_limit_exhausted");
  });

  it("keeps embedded and page DOI conflicts ambiguous", () => {
    const mapped = mapPdfMetadataFromParsed({}, metadata({ "dc:identifier": "doi:10.1000/embedded" }), [{ pageNumber: 1, text: "10.1000/page", characterCount: 12, error: null }], PDF_METADATA_LIMITS);
    expect(mapped.metadata.doi).toBeNull();
    expect(mapped.fields.doi.diagnostic).toBe("multiple_distinct_doi_candidates");
  });

  it("keeps image-only and encrypted PDFs reviewable without OCR or password persistence", async () => {
    const imageOnly = await inspectPdfMetadata(await readFile(path.join(fixtures, "image-only-no-text.pdf")));
    expect(imageOnly.status).toBe("succeeded");
    expect(imageOnly.pages.every((page) => page.text === "")).toBe(true);

    const encrypted = await inspectPdfMetadata(await readFile(path.join(fixtures, "encrypted-password.pdf")));
    expect(encrypted.status).toBe("metadata_failed");
    expect(encrypted.error?.code).toBe("PasswordException");
    expect(encrypted.error?.message).toBeTruthy();
  });
});
