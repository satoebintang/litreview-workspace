import { describe, expect, it, vi } from "vitest";
import {
  buildCrossrefWorkUrl,
  createCrossrefBibliographicMetadataLookupProvider,
  CrossrefBibliographicMetadataLookupProvider,
  type BibliographicMetadataLookupAttempt,
  type CrossrefMetadataLookupFetchCall,
} from "@/infrastructure/crossref-bibliographic-metadata-lookup-provider";
import { BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS } from "@/application/bibliographic-metadata-lookup-provider";

const DOI = "10.1000/example/part";
const NOW = new Date("2026-09-20T00:00:00.000Z");

function crossrefResponse(message: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ status: "ok", message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function provider(
  responses: Array<Response | Error>,
  overrides: Partial<ConstructorParameters<typeof CrossrefBibliographicMetadataLookupProvider>[0]> = {},
) {
  const calls: CrossrefMetadataLookupFetchCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (!next) throw new Error("fake transport exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  const attempts: BibliographicMetadataLookupAttempt[] = [];
  const releases: number[] = [];
  const sleeper = vi.fn(async () => undefined);
  const instance = createCrossrefBibliographicMetadataLookupProvider({
    mailto: "researcher@example.test",
    fetch,
    clock: () => NOW,
    sleeper,
    jitter: () => 0,
    attemptAccounting: {
      begin: vi.fn(async (attempt) => {
        attempts.push(attempt);
        return { release: () => { releases.push(attempts.length); } };
      }),
    },
    ...overrides,
  });
  return { instance, fetch, calls, attempts, releases, sleeper };
}

describe("Crossref DOI metadata lookup", () => {
  it("normalizes DOI forms and preserves slash separators while encoding segments", () => {
    expect(buildCrossrefWorkUrl(" DOI:10.1000/Example-Part/a?b#c ")).toBe("https://api.crossref.org/v1/works/10.1000/example-part/a%3Fb%23c");
    expect(buildCrossrefWorkUrl("https://doi.org/10.1000/example/part")).toBe("https://api.crossref.org/v1/works/10.1000/example/part");
    expect(buildCrossrefWorkUrl("https://dx.doi.org/10.1000/example/part")).toBe("https://api.crossref.org/v1/works/10.1000/example/part");
    expect(buildCrossrefWorkUrl("https://evil.example/10.1000/example")).toBeNull();
  });

  it("uses only a fixed Crossref GET with safe headers and accounting per outbound request", async () => {
    const fake = provider([crossrefResponse({ DOI, title: ["A study"], author: [] })]);
    const result = await fake.instance.lookup({ doi: `doi:${DOI}` });
    expect(result.kind).toBe("success");
    expect(fake.calls).toHaveLength(1);
    expect(String(fake.calls[0]?.input)).toBe("https://api.crossref.org/v1/works/10.1000/example/part?mailto=researcher%40example.test");
    expect(fake.calls[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(fake.calls[0]?.init?.headers).toEqual({ Accept: "application/vnd.crossref-api-message+json, application/json", "User-Agent": "Tracework/0.30.0 (mailto:researcher@example.test)" });
    expect(fake.instance.contractVersion).toBe("bibliographic-metadata-lookup-v1");
    expect(fake.instance.mappingVersion).toBe("crossref-work-v1");
    expect(fake.attempts).toHaveLength(1);
    expect(fake.releases).toHaveLength(1);
  });

  it("rejects header injection and invalid DOI before any GET", async () => {
    expect(() => new CrossrefBibliographicMetadataLookupProvider({ mailto: "researcher@example.test\r\nX-Leak: yes" })).toThrow();
    const fake = provider([]);
    const result = await fake.instance.lookup({ doi: "https://doi.org/https://evil.example" });
    expect(result).toMatchObject({ kind: "failure", code: "invalid_doi", evidence: { attemptCount: 0 } });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("maps full and sparse records without persisting abstract, references, or unknown fields", async () => {
    const fake = provider([crossrefResponse({
      DOI: "10.1000/EXAMPLE/PART",
      title: ["  A bounded study  "],
      author: [{ given: "Jane", family: "Doe", suffix: "Jr." }, { name: "The Study Group" }],
      "published-print": { "date-parts": [[2020, 2, 3]] },
      "published-online": { "date-parts": [[2019]] },
      "container-title": ["Journal of Testing"],
      abstract: "secret abstract must not escape",
      reference: [{ DOI: "10.1000/other" }],
      unknownField: "must not escape",
    })]);
    const result = await fake.instance.lookup({ doi: DOI });
    expect(result).toMatchObject({ kind: "success", proposal: { requestedDoi: DOI, returnedDoi: DOI, title: "A bounded study", authors: ["Jane Doe Jr.", "The Study Group"], publicationYear: 2020, venue: "Journal of Testing", warnings: [] } });
    expect(JSON.stringify(result)).not.toContain("secret abstract");
    expect(JSON.stringify(result)).not.toContain("must not escape");

    const sparse = provider([crossrefResponse({ DOI })]);
    await expect(sparse.instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "success", proposal: { title: null, authors: null, publicationYear: null, venue: null, warnings: [] } });
  });

  it("uses publication date precedence and bounds title, venue, and authors atomically", async () => {
    const oversizedAuthor = "a".repeat(BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints + 1);
    const fake = provider([crossrefResponse({
      DOI,
      title: ["t".repeat(BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxTitleCodePoints + 1)],
      "container-title": ["v".repeat(BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxVenueCodePoints + 1)],
      author: [{ given: "Valid", family: "Person" }, { given: oversizedAuthor, family: "Rejected" }],
      "published-print": { "date-parts": [[999]] },
      "published-online": { "date-parts": [[2022]] },
      issued: { "date-parts": [[2021]] },
    })]);
    const result = await fake.instance.lookup({ doi: DOI });
    expect(result).toMatchObject({ kind: "success", proposal: { title: null, venue: null, authors: null, publicationYear: 2022 } });
    expect(result.kind === "success" ? result.proposal.warnings.map((item) => item.code) : []).toEqual(["authors_invalid", "title_too_long", "venue_too_long"]);

    const tooMany = provider([crossrefResponse({ DOI, author: Array.from({ length: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCount + 1 }, () => ({ family: "A" })) })]);
    await expect(tooMany.instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "success", proposal: { authors: null, warnings: [{ code: "authors_too_many", field: "authors" }] } });
  });

  it("does not retry terminal parsing, content-type, mismatch, or 4xx failures", async () => {
    for (const response of [
      new Response("{}", { status: 200, headers: { "content-type": "text/html" } }),
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      crossrefResponse({ DOI: "10.1000/other" }),
      new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } }),
    ]) {
      const fake = provider([response]);
      const result = await fake.instance.lookup({ doi: DOI });
      expect(result.kind).toBe("failure");
      expect(fake.fetch).toHaveBeenCalledTimes(1);
      expect(fake.sleeper).not.toHaveBeenCalled();
    }
  });

  it("retries transient HTTP and transport failures with deterministic backoff and Retry-After", async () => {
    const fake = provider([
      new Response("busy", { status: 503, headers: { "retry-after": "2", "content-type": "text/plain" } }),
      new Error("socket reset"),
      crossrefResponse({ DOI, title: ["Recovered"] }),
    ]);
    const result = await fake.instance.lookup({ doi: DOI });
    expect(result).toMatchObject({ kind: "success", proposal: { title: "Recovered" }, evidence: { attemptCount: 3 } });
    expect(fake.sleeper).toHaveBeenNthCalledWith(1, 2_000);
    expect(fake.sleeper).toHaveBeenNthCalledWith(2, 500);
    expect(fake.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(fake.releases).toHaveLength(3);
  });

  it("follows only same-origin HTTPS API redirects and accounts for redirected GETs", async () => {
    const fake = provider([
      new Response(null, { status: 307, headers: { location: "https://api.crossref.org/v1/works/10.1000/example/part?redirected=true" } }),
      crossrefResponse({ DOI, title: ["Redirected"] }),
    ]);
    const result = await fake.instance.lookup({ doi: DOI });
    expect(result).toMatchObject({ kind: "success", proposal: { title: "Redirected" }, evidence: { attemptCount: 2 } });
    expect(fake.calls.map((call) => String(call.input))).toEqual([
      "https://api.crossref.org/v1/works/10.1000/example/part?mailto=researcher%40example.test",
      "https://api.crossref.org/v1/works/10.1000/example/part?redirected=true&mailto=researcher%40example.test",
    ]);

    const rejected = provider([new Response(null, { status: 302, headers: { location: "http://api.crossref.org/v1/works/10.1000/example/part" } })]);
    await expect(rejected.instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "failure", code: "redirect_rejected" });
  });

  it("enforces response byte, JSON depth, and visited-value bounds", async () => {
    const oversized = new Response("x".repeat(BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxResponseBytes + 1), { status: 200, headers: { "content-type": "application/json", "content-length": String(BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxResponseBytes + 1) } });
    await expect(provider([oversized]).instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "failure", code: "response_too_large" });

    let deep: unknown = { DOI };
    for (let index = 0; index <= BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxJsonDepth; index += 1) deep = { nested: deep };
    await expect(provider([crossrefResponse(deep as Record<string, unknown>)]).instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "failure", code: "json_depth_exceeded" });

    const many = { DOI, values: Array.from({ length: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxJsonVisitedValues }, () => 1) };
    await expect(provider([crossrefResponse(many)]).instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "failure", code: "json_visited_values_exceeded" });
  });

  it("classifies not-found, TLS, timeout, and exhausted retry outcomes without provider text", async () => {
    const notFound = provider([new Response("missing", { status: 404, headers: { "content-type": "text/plain" } })]);
    await expect(notFound.instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "failure", code: "not_found" });

    const tls = provider([Object.assign(new Error("certificate verify failed"), { code: "CERT_HAS_EXPIRED" })]);
    const tlsResult = await tls.instance.lookup({ doi: DOI });
    expect(tlsResult).toMatchObject({ kind: "failure", code: "tls_error", evidence: { attemptCount: 1 } });
    expect(JSON.stringify(tlsResult)).not.toContain("certificate verify failed");

    const timeout = provider([Object.assign(new Error("timed out"), { name: "AbortError" }), Object.assign(new Error("timed out"), { name: "AbortError" }), Object.assign(new Error("timed out"), { name: "AbortError" })]);
    await expect(timeout.instance.lookup({ doi: DOI })).resolves.toMatchObject({ kind: "failure", code: "timeout", evidence: { attemptCount: 3 } });
  });
});
