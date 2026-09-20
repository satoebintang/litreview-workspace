import { describe, expect, it } from "vitest";
import {
  DOI_MAX_CONCURRENT_GETS,
  DOI_POLITE_RATE_PER_SECOND,
  boundedDoiMetadataSnapshot,
  buildProviderDoiUrl,
  createDoiIntakeLifecycleServices,
  type DoiCacheEntry,
  type DoiDispatchClaim,
  type DoiHttpAttempt,
  type DoiHttpTransport,
  type DoiIntakeLifecycleStore,
  type DoiIntakeRequest,
  type DoiMetadataProvider,
  type DoiProviderResponse,
  type DoiRateSlot,
  type DoiTerminalPersistenceInput,
  type DoiTerminalResult,
} from "@/application/doi-lookup-services";

type Dispatch = { id: string; requestId: string; mode: "network" | "cache_reuse"; status: "open" | "terminal"; leaseUntil: Date | null; token: string | null };

class DurableDoiTestStore implements DoiIntakeLifecycleStore {
  requests = new Map<string, DoiIntakeRequest>();
  idempotency = new Map<string, string>();
  dispatches = new Map<string, Dispatch>();
  attempts: DoiHttpAttempt[] = [];
  results = new Map<string, DoiTerminalResult>();
  cache: DoiCacheEntry[] = [];
  persistFailures = 0;
  currentNow = new Date("2026-09-20T00:00:00.000Z");
  private active = new Map<string, Set<string>>();
  private timestamps = new Map<string, Date[]>();
  private limits = new Map<string, { rate: number; concurrency: number }>();

  private id(): string { return crypto.randomUUID(); }
  private key(projectId: string, idempotencyKey: string): string { return `${projectId}:${idempotencyKey}`; }
  setNow(value: Date) { this.currentNow = value; }

  async findRequestByIdempotency(projectId: string, idempotencyKey: string) { const id = this.idempotency.get(this.key(projectId, idempotencyKey)); return id ? this.requests.get(id) ?? null : null; }
  async insertRequest(input: Omit<DoiIntakeRequest, "id" | "status">) {
    const key = this.key(input.projectId, input.idempotencyKey);
    const existingId = this.idempotency.get(key);
    if (existingId) return this.requests.get(existingId)!;
    const request = { ...input, id: this.id(), status: "created" as const };
    this.requests.set(request.id, request); this.idempotency.set(key, request.id); return request;
  }
  async findRequest(requestId: string, projectId?: string) {
    const request = this.requests.get(requestId) ?? null;
    return request && (!projectId || request.projectId === projectId) ? request : null;
  }
  async findReusableCache(identity: Pick<DoiIntakeRequest, "provider" | "normalizedDoi" | "contractVersion" | "mappingVersion">, now: Date) {
    return this.cache.filter((entry) => entry.provider === identity.provider && entry.normalizedDoi === identity.normalizedDoi && entry.contractVersion === identity.contractVersion && entry.mappingVersion === identity.mappingVersion && entry.finalizedAt <= now).sort((a, b) => a.finalizedAt.getTime() - b.finalizedAt.getTime() || a.resultId.localeCompare(b.resultId))[0] ?? null;
  }
  async createDispatch(input: { requestId: string; cacheEntryId: string | null; mode: "network" | "cache_reuse" }) {
    if (input.mode === "network") {
      const existing = [...this.dispatches.values()].find((dispatch) => dispatch.requestId === input.requestId && dispatch.mode === "network");
      if (existing) return { id: existing.id };
    }
    const id = this.id(); this.dispatches.set(id, { id, requestId: input.requestId, mode: input.mode, status: "open", leaseUntil: null, token: null }); return { id };
  }
  async claimDispatch(input: { requestId: string; dispatchId: string; now: Date; leaseMs: number }): Promise<DoiDispatchClaim> {
    const dispatch = this.dispatches.get(input.dispatchId)!;
    if (dispatch.status === "terminal") return { kind: "terminal", dispatchId: dispatch.id, leaseToken: null, recoveredExpiredLease: false };
    if (dispatch.leaseUntil && dispatch.leaseUntil > input.now) return { kind: "busy", dispatchId: dispatch.id, leaseToken: null, recoveredExpiredLease: false };
    const recoveredExpiredLease = dispatch.leaseUntil != null;
    dispatch.token = this.id(); dispatch.leaseUntil = new Date(input.now.getTime() + input.leaseMs); return { kind: "claimed", dispatchId: dispatch.id, leaseToken: dispatch.token, recoveredExpiredLease };
  }
  async claimGlobalHttpSlot(input: { provider: string; now: Date; ratePerSecond: number; maxConcurrency: number }): Promise<DoiRateSlot> {
    const active = this.active.get(input.provider) ?? new Set<string>(); this.active.set(input.provider, active);
    const timestamps = (this.timestamps.get(input.provider) ?? []).filter((date) => input.now.getTime() - date.getTime() < 1_000); this.timestamps.set(input.provider, timestamps);
    const configured = this.limits.get(input.provider) ?? { rate: input.ratePerSecond, concurrency: input.maxConcurrency };
    if (active.size >= configured.concurrency) return { kind: "wait", retryAt: new Date(input.now.getTime() + 10) };
    if (timestamps.length >= configured.rate) return { kind: "wait", retryAt: new Date(timestamps[0]!.getTime() + 1_000) };
    const leaseId = this.id(); active.add(leaseId); timestamps.push(input.now); return { kind: "acquired", leaseId };
  }
  async releaseGlobalHttpSlot(input: { provider: string; leaseId: string; now: Date }) { this.active.get(input.provider)?.delete(input.leaseId); }
  async observeRateLimitHeaders(input: { provider: string; headers: Record<string, string | undefined>; now: Date }) {
    const raw = input.headers["x-ratelimit-limit"] ?? input.headers["ratelimit-limit"];
    const rate = raw == null ? null : Number(raw.split(",")[0]);
    const concurrencyRaw = input.headers["x-ratelimit-concurrency"];
    const concurrency = concurrencyRaw == null ? null : Number(concurrencyRaw);
    const current = this.limits.get(input.provider) ?? { rate: DOI_POLITE_RATE_PER_SECOND, concurrency: DOI_MAX_CONCURRENT_GETS };
    const validRate = rate != null && Number.isInteger(rate) && rate > 0 ? rate : null;
    const validConcurrency = concurrency != null && Number.isInteger(concurrency) && concurrency > 0 ? concurrency : null;
    this.limits.set(input.provider, { rate: validRate == null ? current.rate : Math.min(current.rate, validRate), concurrency: validConcurrency == null ? current.concurrency : Math.min(current.concurrency, validConcurrency) });
  }
  async startHttpAttempt(input: { requestId: string; dispatchId: string; attempt: number; url: string; startedAt: Date }) { const attempt = { ...input, id: this.id(), completedAt: null, status: "started" as const, httpStatus: null, errorCode: null }; this.attempts.push(attempt); return { id: attempt.id }; }
  async finishHttpAttempt(input: { attemptId: string; completedAt: Date; status: "succeeded" | "failed"; httpStatus: number | null; errorCode: string | null }) { const attempt = this.attempts.find((item) => item.id === input.attemptId)!; Object.assign(attempt, input); }
  async persistTerminal(input: DoiTerminalPersistenceInput) {
    const existing = this.results.get(input.request.id);
    if (existing) return existing;
    if (this.persistFailures > 0) { this.persistFailures -= 1; throw new Error("transient persistence failure"); }
    let cacheEntryId: string | null = null;
    if (input.cacheEligible && input.metadata) {
      cacheEntryId = this.id(); this.cache.push({ id: cacheEntryId, provider: input.request.provider, normalizedDoi: input.request.normalizedDoi, contractVersion: input.request.contractVersion, mappingVersion: input.request.mappingVersion, finalizedAt: input.finalizedAt, resultId: this.id(), metadata: input.metadata });
    }
    const candidates = this.cache.filter((entry) => entry.provider === input.request.provider && entry.normalizedDoi === input.request.normalizedDoi && entry.contractVersion === input.request.contractVersion && entry.mappingVersion === input.request.mappingVersion).sort((a, b) => a.finalizedAt.getTime() - b.finalizedAt.getTime() || a.resultId.localeCompare(b.resultId));
    const result: DoiTerminalResult = { id: this.id(), requestId: input.request.id, dispatchId: input.dispatchId, outcome: input.outcome, diagnostic: input.diagnostic, errorCode: input.errorCode, metadata: input.metadata, finalizedAt: input.finalizedAt, cacheEntryId, canonicalCacheResultId: candidates[0]?.resultId ?? null };
    this.results.set(input.request.id, result);
    const request = this.requests.get(input.request.id)!; request.status = "terminal";
    const dispatch = this.dispatches.get(input.dispatchId); if (dispatch) { dispatch.status = "terminal"; dispatch.leaseUntil = null; }
    return result;
  }
}

function provider(overrides: Partial<DoiMetadataProvider> = {}): DoiMetadataProvider {
  return {
    provider: "crossref",
    baseUrl: "https://api.example.test/works",
    parse(response) {
      if (response.status === 404) return { kind: "not_found" };
      if (response.status === 429 || response.status >= 500) return { kind: "retryable", code: `http_${response.status}` };
      return { kind: "success", metadata: { title: "A bounded title", authors: [{ given: "Ada", family: "Lovelace" }], publicationYear: 2024, venue: "Journal", evidence: [{ field: "title", source: "title", value: "A bounded title" }] } };
    },
    ...overrides,
  };
}

function response(status = 200, body = "provider-body", headers: Record<string, string | undefined> = {}): DoiProviderResponse { return { status, body, headers, url: "https://api.example.test/works/10.1000/example" }; }
function transportFrom(responses: DoiProviderResponse[] | (() => DoiProviderResponse)): { transport: DoiHttpTransport; calls: string[] } {
  const calls: string[] = []; let index = 0;
  return { calls, transport: { async get(input) { calls.push(input.url); const value = typeof responses === "function" ? responses() : responses[Math.min(index++, responses.length - 1)]!; return value; } } };
}

describe("Slice 30 DOI intake lifecycle and global lookup cache", () => {
  it("is idempotent per project/key while exact cache reuse crosses projects", async () => {
    const store = new DurableDoiTestStore(); const { transport, calls } = transportFrom([response()]); const services = createDoiIntakeLifecycleServices(store, provider(), transport, { clock: () => store.currentNow });
    const first = await services.begin({ projectId: "project-a", idempotencyKey: "same", doi: "DOI:10.1000/Example" });
    const duplicate = await services.begin({ projectId: "project-a", idempotencyKey: "same", doi: "10.1000/example" });
    expect(duplicate).toMatchObject({ reused: true, request: { id: first.request.id } });
    await services.execute(first.request.id, "project-a");
    const other = await services.begin({ projectId: "project-b", idempotencyKey: "same", doi: "https://doi.org/10.1000/example" });
    const reused = await services.execute(other.request.id, "project-b");
    expect(reused).toMatchObject({ outcome: "cache_reused" }); expect(calls).toHaveLength(1);
  });

  it("does not reuse failed, unknown, or not-found history", async () => {
    const store = new DurableDoiTestStore(); const { transport, calls } = transportFrom([response(503), response(503), response(503)]); const services = createDoiIntakeLifecycleServices(store, provider(), transport, { clock: () => store.currentNow, sleep: async () => {} });
    const first = await services.begin({ projectId: "a", idempotencyKey: "one", doi: "10.1000/fail" }); const result = await services.execute(first.request.id);
    expect(result).toMatchObject({ outcome: "outcome_unknown" }); expect(store.cache).toHaveLength(0);
    const second = await services.begin({ projectId: "b", idempotencyKey: "two", doi: "10.1000/fail" }); await services.execute(second.request.id); expect(calls).toHaveLength(6);
  });

  it("records every initial, retry, and redirect GET with slash-preserving DOI paths", async () => {
    const store = new DurableDoiTestStore(); const { transport } = transportFrom([response(302, "", { location: "https://api.example.test/redirect" }), response(503), response()]); const services = createDoiIntakeLifecycleServices(store, provider(), transport, { clock: () => store.currentNow, sleep: async () => {} });
    const request = await services.begin({ projectId: "a", idempotencyKey: "history", doi: "10.1000/part-one/part-two" }); await services.execute(request.request.id);
    expect(store.attempts).toHaveLength(3); expect(store.attempts.map((attempt) => attempt.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(store.attempts[0]!.url).toContain("10.1000/part-one/part-two");
    expect(buildProviderDoiUrl("https://api.example.test/works/", "10.1000/a/b")).toBe("https://api.example.test/works/10.1000/a/b");
  });

  it("shares rate and concurrency claims and lowers budgets from valid headers", async () => {
    const store = new DurableDoiTestStore(); const now = new Date("2026-09-20T00:00:00Z");
    const claims = await Promise.all(Array.from({ length: DOI_MAX_CONCURRENT_GETS }, () => store.claimGlobalHttpSlot({ provider: "crossref", now, ratePerSecond: DOI_POLITE_RATE_PER_SECOND, maxConcurrency: DOI_MAX_CONCURRENT_GETS })));
    expect(claims.every((claim) => claim.kind === "acquired")).toBe(true);
    expect((await store.claimGlobalHttpSlot({ provider: "crossref", now, ratePerSecond: DOI_POLITE_RATE_PER_SECOND, maxConcurrency: DOI_MAX_CONCURRENT_GETS })).kind).toBe("wait");
    await store.observeRateLimitHeaders({ provider: "crossref", headers: { "x-ratelimit-limit": "2" }, now });
    for (const claim of claims) if (claim.kind === "acquired") await store.releaseGlobalHttpSlot({ provider: "crossref", leaseId: claim.leaseId, now });
    const limited = await Promise.all(Array.from({ length: 3 }, () => store.claimGlobalHttpSlot({ provider: "crossref", now: new Date(now.getTime() + 2_000), ratePerSecond: DOI_POLITE_RATE_PER_SECOND, maxConcurrency: DOI_MAX_CONCURRENT_GETS })));
    expect(limited.filter((claim) => claim.kind === "acquired")).toHaveLength(2);
  });

  it("recovers an expired short dispatch lease without a second network dispatch", async () => {
    const store = new DurableDoiTestStore(); const t0 = new Date("2026-09-20T00:00:00Z"); const { transport, calls } = transportFrom([response()]); const services = createDoiIntakeLifecycleServices(store, provider(), transport, { clock: () => store.currentNow, dispatchLeaseMs: 100 });
    const begun = await services.begin({ projectId: "a", idempotencyKey: "lease", doi: "10.1000/lease" }); const dispatch = await store.createDispatch({ requestId: begun.request.id, cacheEntryId: null, mode: "network" });
    const firstClaim = await store.claimDispatch({ requestId: begun.request.id, dispatchId: dispatch.id, now: t0, leaseMs: 100 }); expect(firstClaim.kind).toBe("claimed");
    store.setNow(new Date(t0.getTime() + 101)); const secondClaim = await store.claimDispatch({ requestId: begun.request.id, dispatchId: dispatch.id, now: store.currentNow, leaseMs: 100 }); expect(secondClaim).toMatchObject({ kind: "claimed", recoveredExpiredLease: true });
    store.setNow(new Date(t0.getTime() + 202));
    await services.execute(begun.request.id); expect(calls).toHaveLength(1); expect([...store.dispatches.values()].filter((item) => item.mode === "network")).toHaveLength(1);
  });

  it("retries terminal result persistence without refetching", async () => {
    const store = new DurableDoiTestStore(); store.persistFailures = 1; const { transport, calls } = transportFrom([response()]); const services = createDoiIntakeLifecycleServices(store, provider(), transport, { clock: () => store.currentNow, sleep: async () => {}, persistenceRetries: 1 });
    const request = await services.begin({ projectId: "a", idempotencyKey: "persist", doi: "10.1000/persist" }); const result = await services.execute(request.request.id);
    expect(result).toMatchObject({ outcome: "succeeded" }); expect(calls).toHaveLength(1); expect(store.results.size).toBe(1);
  });

  it("persists an all-or-nothing authors proposal and excludes raw provider fields", () => {
    const snapshot = boundedDoiMetadataSnapshot({ title: "Title", authors: [{ given: "Ada", family: "Lovelace" }, { given: "x".repeat(300), family: "Unsafe" }], abstract: "must not persist", references: ["must not persist"], unknownField: "must not persist" } as never, { normalizedDoi: "10.1000/example", response: response() });
    expect(snapshot.authors).toBeNull(); expect(snapshot.authorsProposalState).toBe("invalid"); expect(snapshot).not.toHaveProperty("abstract"); expect(snapshot).not.toHaveProperty("references"); expect(snapshot).not.toHaveProperty("unknownField");
  });

  it("selects the earliest finalized cache result, then result UUID, for late concurrent successes", async () => {
    const store = new DurableDoiTestStore(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let calls = 0;
    const transport: DoiHttpTransport = { async get() { calls += 1; if (calls === 1) await gate; return response(200, `body-${calls}`); } };
    let tick = 0; const clock = () => new Date(1_000 + tick++); const services = createDoiIntakeLifecycleServices(store, provider(), transport, { clock, sleep: async () => {} });
    const a = await services.begin({ projectId: "a", idempotencyKey: "a", doi: "10.1000/race" }); const b = await services.begin({ projectId: "b", idempotencyKey: "b", doi: "10.1000/race" });
    const first = services.execute(a.request.id); const second = services.execute(b.request.id); await Promise.resolve(); release(); const results = await Promise.all([first, second]);
    const terminal = results.filter((result): result is DoiTerminalResult => "outcome" in result); expect(terminal).toHaveLength(2); expect(new Set(terminal.map((result) => result.canonicalCacheResultId)).size).toBe(1); expect(store.cache).toHaveLength(2);
  });
});
