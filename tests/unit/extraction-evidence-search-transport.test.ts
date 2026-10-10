import { beforeEach, describe, expect, it, vi } from "vitest";

const { readPage } = vi.hoisted(() => ({ readPage: vi.fn() }));

vi.mock("@/app/server", () => ({
  extractionReadServices: { getPaperExtractionEvidenceCandidatePage: readPage },
}));

import { GET } from "@/app/api/projects/[projectId]/papers/[paperId]/extraction-evidence/route";
import { getPaperExtractionEvidenceCandidatePageAction } from "@/app/actions/extraction-evidence-selection";
import { DomainError } from "@/domain/errors";
import { normalizeExtractionEvidenceSearchQuery } from "@/application/extraction-evidence-search-query";

const projectId = "11111111-1111-4111-8111-111111111111";
const paperId = "22222222-2222-4222-8222-222222222222";
const page = { items: [], pageSize: 20, hasNext: false, nextCursor: null };

describe("Extraction Evidence search transports", () => {
  beforeEach(() => {
    readPage.mockReset();
    readPage.mockResolvedValue(page);
  });

  it("passes query, cursor, and page size through the no-store GET route", async () => {
    const response = await GET(
      new Request(`http://127.0.0.1/api?query=${encodeURIComponent("  %_ \"word\"  ")}&pageSize=50&after=cursor`),
      { params: Promise.resolve({ projectId, paperId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readPage).toHaveBeenCalledWith(projectId, paperId, { pageSize: 50, after: "cursor", query: "  %_ \"word\"  " });
  });

  it("returns query validation as HTTP 400 without pagination repair", async () => {
    readPage.mockRejectedValue(new DomainError("VALIDATION_ERROR", "Evidence search query cannot contain a NUL character.", { input: "query" }));
    const response = await GET(
      new Request("http://127.0.0.1/api?query=%00&after=bad-cursor"),
      { params: Promise.resolve({ projectId, paperId }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "error", invalidBrowseState: false, validationInput: "query",
    });
  });

  it("classifies repeated query parameters as a non-string query error", async () => {
    readPage.mockRejectedValue(new DomainError("VALIDATION_ERROR", "Evidence search query must be text.", { input: "query" }));
    const response = await GET(
      new Request("http://127.0.0.1/api?query=first&query=second&after=bad-cursor"),
      { params: Promise.resolve({ projectId, paperId }) },
    );

    expect(readPage).toHaveBeenCalledWith(projectId, paperId, {
      pageSize: undefined, after: "bad-cursor", query: ["first", "second"],
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "error", invalidBrowseState: false, validationInput: "query",
    });
  });

  it("accepts the decoded value produced for malformed percent-encoded UTF-8", async () => {
    const request = new Request("http://127.0.0.1/api?query=%ED%A0%80");
    const decodedQuery = new URL(request.url).searchParams.get("query");
    const expectedDecodedQuery = "\uFFFD".repeat(3);
    expect(decodedQuery).toBe(expectedDecodedQuery);
    expect(normalizeExtractionEvidenceSearchQuery(decodedQuery)).toBe(decodedQuery);
    readPage.mockImplementation((_projectId: string, _paperId: string, options: { query?: unknown }) => {
      expect(normalizeExtractionEvidenceSearchQuery(options.query)).toBe(decodedQuery);
      return page;
    });

    const response = await GET(request, { params: Promise.resolve({ projectId, paperId }) });

    expect(response.status).toBe(200);
    expect(readPage).toHaveBeenCalledWith(projectId, paperId, {
      pageSize: undefined, after: null, query: decodedQuery,
    });
  });

  it("returns invalid cursor validation as a repairable pagination error", async () => {
    readPage.mockRejectedValue(new DomainError("VALIDATION_ERROR", "Evidence page cursor is invalid.", { input: "pagination" }));
    const response = await GET(
      new Request("http://127.0.0.1/api?query=valid&after=bad-cursor"),
      { params: Promise.resolve({ projectId, paperId }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "error", invalidBrowseState: true, validationInput: "pagination",
    });
  });

  it("classifies action query errors separately from invalid browse state", async () => {
    readPage.mockRejectedValue(new DomainError("VALIDATION_ERROR", "Evidence search query must be text.", { input: "query" }));

    await expect(getPaperExtractionEvidenceCandidatePageAction(projectId, paperId, { query: 1 }))
      .resolves.toMatchObject({ status: "error", invalidBrowseState: false, validationInput: "query" });
    expect(readPage).toHaveBeenCalledWith(projectId, paperId, { query: 1 });
  });
});
