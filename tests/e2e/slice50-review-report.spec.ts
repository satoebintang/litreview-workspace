import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { REVIEW_REPORT_METRIC_KEYS } from "@/domain/review-report";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

const SOURCE_METRICS = ["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"] as const;
const CONTEXT_PAGES = [
  { kind: "questions", title: "Active Research Questions" },
  { kind: "screening-criteria", title: "Active Screening Criteria" },
  { kind: "full-text-criteria", title: "Active Full-text Criteria" },
  { kind: "sources", title: "Represented SearchSources" },
  { kind: "exclusion-reasons", title: "Title/Abstract Exclusion Reasons" },
  { kind: "full-text-exclusion-reasons", title: "Full-text Exclusion Reasons" },
] as const;

async function seedReportFixture() {
  const database = createDb(resolvePlaywrightTestDatabaseUrl());
  const services = createReviewServices(database.db);
  const suffix = randomUUID();
  try {
    const project = await services.createProject({ title: `Slice 50 report ${suffix}` });
    const sources = await services.listSearchSources(project.id) as Array<{ id: string; sourceKey: string; displayName: string; archivedAt: Date | null }>;
    const currentSource = await services.createSearchSource(project.id, {
      sourceKey: `slice50_current_${suffix.replaceAll("-", "").slice(0, 12)}`,
      displayName: `Slice 50 Current Source ${suffix.slice(0, 8)}`,
    });
    sources.push(currentSource);
    while (sources.length < 11) {
      const index = sources.length + 1;
      sources.push(await services.createSearchSource(project.id, {
        sourceKey: `slice50_source_${index}_${suffix.replaceAll("-", "").slice(0, 8)}`,
        displayName: `Slice 50 represented source ${index}`,
      }));
    }
    const strategies = new Map<string, { id: string; queryText: string }>();
    const runs = new Map<string, { id: string }>();
    let zeroRunId = "";
    for (const [index, source] of sources.entries()) {
      const strategy = await services.createSearchStrategy(project.id, {
        searchSourceId: source.id,
        name: `Slice 50 strategy ${index + 1}`,
        queryText: `slice50 query ${index + 1} ${suffix}`,
      });
      strategies.set(source.id, strategy);
      const createRun = (reportedResultCount: number, offset: number) => services.createSearchRun(project.id, {
        searchSourceId: source.id,
        sourceKeySnapshot: source.sourceKey,
        sourceDisplayNameSnapshot: source.displayName,
        strategyId: strategy.id,
        queryText: strategy.queryText,
        reportedResultCount,
        executedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 3 + offset)),
      });
      if (source.id === currentSource.id) {
        const emptyRun = await createRun(0, 0);
        zeroRunId = emptyRun.id;
        runs.set(source.id, await createRun(64, 1));
      } else {
        runs.set(source.id, await createRun(index + 1, 0));
      }
    }

    const questionIds: string[] = [];
    for (let index = 1; index <= 11; index += 1) {
      const question = await services.createResearchQuestion(project.id, {
        identifier: `RQ-${String(index).padStart(2, "0")}`,
        label: `Slice 50 question ${String(index).padStart(2, "0")}`,
      });
      questionIds.push(question.id);
    }

    const exclusionCriterionIds: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const criterion = await services.createScreeningCriterion(project.id, {
        type: "exclusion",
        text: `Slice 50 title/abstract reason ${String(index).padStart(2, "0")}`,
      });
      const paper = await services.addPaper(project.id, { title: `Slice 50 TA excluded Paper ${index}` });
      await services.recordScreeningDecision(project.id, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });
      exclusionCriterionIds.push(criterion.id);
    }
    await services.archiveScreeningCriterion(project.id, exclusionCriterionIds[0]!);

    const fullTextCriterionIds: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const criterion = await services.createFullTextScreeningCriterion(project.id, {
        text: `Slice 50 full-text reason ${String(index).padStart(2, "0")}`,
      });
      const paper = await services.addPaper(project.id, { title: `Slice 50 FT excluded Paper ${index}` });
      await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
        outcome: "retrieved",
        attemptedAt: new Date(Date.UTC(2026, 0, 2, 0, index)),
      });
      await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });
      fullTextCriterionIds.push(criterion.id);
    }
    await services.archiveFullTextScreeningCriterion(project.id, fullTextCriterionIds[0]!);

    const overlapPaper = await services.addPaper(project.id, { title: "Slice 50 cross-source overlap Paper" });
    for (const source of [sources.find((item) => item.id === currentSource.id)!, sources.find((item) => item.id !== currentSource.id)!]) {
      const record = await services.createRetrievedRecord(project.id, {
        searchRunId: runs.get(source.id)!.id,
        searchSourceId: source.id,
        sourceRecordId: `slice50-overlap-${source.id}`,
        title: `Slice 50 overlap record for ${source.displayName}`,
        retrievedAt: new Date("2026-01-03T00:00:00Z"),
      });
      await services.linkRetrievedRecordToPaper(project.id, record.id, overlapPaper.id);
    }

    const duplicateRecordIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const record = await services.createRetrievedRecord(project.id, {
        searchRunId: runs.get(currentSource.id)!.id,
        searchSourceId: currentSource.id,
        sourceRecordId: `slice50-duplicate-${index}-${suffix}`,
        title: "Slice 50 exact title year candidate",
        publicationYear: 2024,
        retrievedAt: new Date(Date.UTC(2026, 0, 4, 0, index)),
      });
      duplicateRecordIds.push(record.id);
    }

    const archivedSource = sources.at(-1)!;
    await services.archiveSearchStrategy(project.id, strategies.get(archivedSource.id)!.id);
    await services.archiveSearchSource(project.id, archivedSource.id);
    return {
      projectId: project.id,
      currentSourceId: currentSource.id,
      currentSourceName: currentSource.displayName,
      archivedSourceId: archivedSource.id,
      archivedSourceName: archivedSource.displayName,
      zeroRunId,
      zeroRunQuery: strategies.get(currentSource.id)!.queryText,
      exclusionCriterionId: exclusionCriterionIds[0]!,
      fullTextCriterionId: fullTextCriterionIds[0]!,
      duplicateRecordIds,
    };
  } finally {
    await database.client.end();
  }
}

test.describe("Slice 50 bounded interactive Review Report", () => {
  test("covers summary, all context and contributor routes, dedup navigation, legacy redirects, and complete export", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const fixture = await seedReportFixture();
    const projectPath = `/projects/${fixture.projectId}`;
    const reportPath = `${projectPath}/review-report`;
    const rscRequestUrls: string[] = [];
    const speculativePrefetchRequests: Array<{ url: string; signal: "next-router-prefetch" | "purpose" | "sec-purpose" | "x-middleware-prefetch" }> = [];
    type ResponseKind = "http-document" | "rsc-navigation";
    type ResponseMetadata = {
      kind: ResponseKind;
      url: string;
      status: number;
      resourceType: string;
      contentType: string;
      contentDisposition: string;
      contentLength: string | null;
      sameKeyOrdinal: number;
    };
    type CdpBodyCaptureDiagnostic = ResponseMetadata & {
      result: "captured" | "failed" | "partial-cancelled" | "partial-failed";
      decodedPayloadBytes: number | null;
      encodedBodyBytesReceived: number;
      sanitizedReason: string | null;
    };
    const transferMeasurements: Array<ResponseMetadata & {
      completion: "complete" | "cancelled" | "failed";
      encodedTransferBytes: number | null;
      encodedBodyBytesReceived: number;
      terminalReason: string | null;
      byteSemantics: "Chromium CDP encoded transfer bytes and encoded response-body bytes; not decoded payload bytes";
      fromDiskCache: boolean;
      fromServiceWorker: boolean;
      fromPrefetchCache: boolean;
    }> = [];
    const responseCaptureFailures: Array<ResponseMetadata & { failure: string }> = [];
    const cdpBodyCaptureDiagnostics: CdpBodyCaptureDiagnostic[] = [];
    const excludedResponses: Array<{
      url: string;
      status: number;
      resourceType: string;
      contentType: string;
      contentDisposition: string;
      reason: "attachment measured through APIResponse.body()" | "redirect document excluded; final navigation response measured";
    }> = [];
    const pageResponseOrdinals = new Map<string, number>();
    const cdpResponseOrdinals = new Map<string, number>();
    const pageObservedResponses: ResponseMetadata[] = [];
    const pendingCdpBodyCaptures: Promise<void>[] = [];
    const drainCdpBodyCaptures = async () => {
      while (pendingCdpBodyCaptures.length > 0) {
        const pending = pendingCdpBodyCaptures.splice(0, pendingCdpBodyCaptures.length);
        await Promise.all(pending);
      }
    };
    const waitForCurrentPageAndDrain = async () => {
      await page.waitForLoadState("networkidle");
      await drainCdpBodyCaptures();
    };
    const cdpResponseMetadata = new Map<string, ResponseMetadata & {
      fromDiskCache: boolean;
      fromServiceWorker: boolean;
      fromPrefetchCache: boolean;
    }>();
    const cdpEncodedBodyBytes = new Map<string, number>();
    const cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send("Network.enable");
    const headerValue = (headers: Record<string, unknown>, name: string): string => {
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
      return typeof entry?.[1] === "string" ? entry[1] : "";
    };
    const sanitizeCaptureReason = (error: unknown): string => {
      if (!(error instanceof Error)) return `non-Error rejection (${typeof error})`;
      return `${error.name}: ${error.message}`
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
        .replace(/cursor=[^&\s]+/gi, "cursor=[redacted]")
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")
        .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
        .slice(0, 240);
    };
    const redactUrl = (rawUrl: string): string => {
      const uuidPattern = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi;
      try {
        const url = new URL(rawUrl);
        url.pathname = url.pathname.replace(uuidPattern, "[id]");
        const safeSearch = new URLSearchParams();
        for (const [key, value] of url.searchParams.entries()) {
          if (key.toLowerCase() === "_rsc" || key.toLowerCase() === "cursor") continue;
          safeSearch.append(key, value.replace(uuidPattern, "[id]"));
        }
        url.search = safeSearch.toString();
        return url.toString();
      } catch {
        return rawUrl
          .replace(uuidPattern, "[id]")
          .replace(/([?&](?:_rsc|cursor)=)[^&]*/gi, "$1[redacted]");
      }
    };
    const redactUrlRecord = <T extends { url: string }>(record: T): T => ({ ...record, url: redactUrl(record.url) });
    const responseCountKey = (kind: ResponseKind, url: string, status: number) => `${kind}\u0000${status}\u0000${url}`;
    const responseOccurrenceKey = (metadata: ResponseMetadata) => `${responseCountKey(metadata.kind, metadata.url, metadata.status)}\u0000${metadata.sameKeyOrdinal}`;
    const nextSameKeyOrdinal = (ordinals: Map<string, number>, kind: ResponseKind, url: string, status: number) => {
      const key = responseCountKey(kind, url, status);
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      return ordinal;
    };
    cdpSession.on("Network.responseReceived", (event) => {
      const contentType = headerValue(event.response.headers, "content-type");
      const contentDisposition = headerValue(event.response.headers, "content-disposition");
      const isAttachment = /(?:^|;)\s*attachment\b/i.test(contentDisposition);
      if (isAttachment) {
        if (event.response.url.includes("/review-report/export")) {
          excludedResponses.push({
            url: event.response.url,
            status: event.response.status,
            resourceType: event.type,
            contentType,
            contentDisposition,
            reason: "attachment measured through APIResponse.body()",
          });
        }
        return;
      }
      if (event.response.status >= 300 && event.response.status < 400 && event.type === "Document") {
        excludedResponses.push({
          url: event.response.url,
          status: event.response.status,
          resourceType: event.type,
          contentType,
          contentDisposition,
          reason: "redirect document excluded; final navigation response measured",
        });
        return;
      }
      const kind: ResponseKind | null = event.type === "Document"
        ? "http-document"
        : contentType.includes("text/x-component") ? "rsc-navigation" : null;
      if (!kind) return;
      const sameKeyOrdinal = nextSameKeyOrdinal(cdpResponseOrdinals, kind, event.response.url, event.response.status);
      cdpResponseMetadata.set(event.requestId, {
        kind,
        url: event.response.url,
        status: event.response.status,
        resourceType: event.type,
        contentType,
        contentDisposition,
        contentLength: headerValue(event.response.headers, "content-length") || null,
        sameKeyOrdinal,
        fromDiskCache: event.response.fromDiskCache ?? false,
        fromServiceWorker: event.response.fromServiceWorker ?? false,
        fromPrefetchCache: event.response.fromPrefetchCache ?? false,
      });
      cdpEncodedBodyBytes.set(event.requestId, 0);
    });
    cdpSession.on("Network.dataReceived", (event) => {
      if (!cdpResponseMetadata.has(event.requestId)) return;
      cdpEncodedBodyBytes.set(event.requestId, (cdpEncodedBodyBytes.get(event.requestId) ?? 0) + event.encodedDataLength);
    });
    cdpSession.on("Network.loadingFinished", (event) => {
      const metadata = cdpResponseMetadata.get(event.requestId);
      if (!metadata) return;
      const encodedBodyBytesReceived = cdpEncodedBodyBytes.get(event.requestId) ?? 0;
      transferMeasurements.push({
        ...metadata,
        completion: "complete",
        encodedTransferBytes: event.encodedDataLength,
        encodedBodyBytesReceived,
        terminalReason: null,
        byteSemantics: "Chromium CDP encoded transfer bytes and encoded response-body bytes; not decoded payload bytes",
      });
      const capturePromise = cdpSession.send("Network.getResponseBody", { requestId: event.requestId }).then((body) => {
        const decodedPayloadBytes = body.base64Encoded
          ? Buffer.from(body.body, "base64").byteLength
          : Buffer.byteLength(body.body, "utf8");
        cdpBodyCaptureDiagnostics.push({
          ...metadata,
          result: "captured",
          decodedPayloadBytes,
          encodedBodyBytesReceived,
          sanitizedReason: null,
        });
      }).catch((error: unknown) => {
        const sanitizedReason = sanitizeCaptureReason(error);
        cdpBodyCaptureDiagnostics.push({
          ...metadata,
          result: "failed",
          decodedPayloadBytes: null,
          encodedBodyBytesReceived,
          sanitizedReason,
        });
        responseCaptureFailures.push({ ...metadata, failure: `CDP completed body capture failed: ${sanitizedReason}` });
      });
      pendingCdpBodyCaptures.push(capturePromise);
      cdpResponseMetadata.delete(event.requestId);
      cdpEncodedBodyBytes.delete(event.requestId);
    });
    cdpSession.on("Network.loadingFailed", (event) => {
      const metadata = cdpResponseMetadata.get(event.requestId);
      if (!metadata) return;
      const terminalReason = sanitizeCaptureReason(new Error(event.errorText));
      const completion = event.canceled || event.errorText === "net::ERR_ABORTED" ? "cancelled" as const : "failed" as const;
      transferMeasurements.push({
        ...metadata,
        completion,
        encodedTransferBytes: null,
        encodedBodyBytesReceived: cdpEncodedBodyBytes.get(event.requestId) ?? 0,
        terminalReason,
        byteSemantics: "Chromium CDP encoded transfer bytes and encoded response-body bytes; not decoded payload bytes",
      });
      cdpBodyCaptureDiagnostics.push({
        ...metadata,
        result: completion === "cancelled" ? "partial-cancelled" : "partial-failed",
        decodedPayloadBytes: null,
        encodedBodyBytesReceived: cdpEncodedBodyBytes.get(event.requestId) ?? 0,
        sanitizedReason: terminalReason,
      });
      cdpResponseMetadata.delete(event.requestId);
      cdpEncodedBodyBytes.delete(event.requestId);
    });
    page.on("request", (request) => {
      try {
        const requestUrl = new URL(request.url());
        if (requestUrl.searchParams.has("_rsc")) rscRequestUrls.push(request.url());
        const headers = request.headers();
        const prefetchSignal = headers["next-router-prefetch"] === "1"
          ? "next-router-prefetch"
          : headers["purpose"]?.toLowerCase().includes("prefetch")
            ? "purpose"
            : headers["sec-purpose"]?.toLowerCase().includes("prefetch")
              ? "sec-purpose"
              : headers["x-middleware-prefetch"] === "1"
                ? "x-middleware-prefetch"
                : null;
        if (prefetchSignal && /\/review-report\/(?:context|contributors)(?:\/|$)/.test(requestUrl.pathname)) {
          speculativePrefetchRequests.push({ url: request.url(), signal: prefetchSignal });
        }
      } catch { /* ignore non-URL request metadata */ }
    });
    page.on("response", (response) => {
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";
      const contentDisposition = headers["content-disposition"] ?? "";
      const resourceType = response.request().resourceType();
      const isDocument = response.request().resourceType() === "document";
      const isRsc = contentType.includes("text/x-component");
      if (!isDocument && !isRsc) return;
      if (/(?:^|;)\s*attachment\b/i.test(contentDisposition)) return;
      if (isDocument && response.status() >= 300 && response.status() < 400) return;
      const metadata: ResponseMetadata = {
        kind: isDocument ? "http-document" as const : "rsc-navigation" as const,
        url: response.url(),
        status: response.status(),
        resourceType,
        contentType,
        contentDisposition,
        contentLength: headers["content-length"] ?? null,
        sameKeyOrdinal: nextSameKeyOrdinal(pageResponseOrdinals, isDocument ? "http-document" : "rsc-navigation", response.url(), response.status()),
      };
      pageObservedResponses.push(metadata);
    });

    const summaryResponse = await page.goto(reportPath);
    expect(summaryResponse).not.toBeNull();
    await expect(page.getByRole("heading", { name: "Review Flow Report" })).toBeVisible();
    await expect(page.getByText("Questions are loaded only when you open the context page.")).toBeVisible();
    await waitForCurrentPageAndDrain();
    expect(speculativePrefetchRequests.length).toBe(0);

    const questionContext = page.getByRole("link", { name: "Browse active questions →" });
    await waitForCurrentPageAndDrain();
    await questionContext.click();
    await expect(page).toHaveURL(new RegExp(`/review-report/context/questions$`));
    await expect(page.getByRole("heading", { name: "Active Research Questions" })).toBeVisible();
    const firstQuestionRows = await page.locator("article.item").allTextContents();
    expect(firstQuestionRows).toHaveLength(10);
    await waitForCurrentPageAndDrain();
    const questionsRscCount = rscRequestUrls.length;
    await waitForCurrentPageAndDrain();
    await page.getByRole("link", { name: "Next page →" }).click();
    await expect(page).toHaveURL(/\/review-report\/context\/questions\?cursor=/);
    const nextQuestionRows = await page.locator("article.item").allTextContents();
    expect(nextQuestionRows).toHaveLength(1);
    expect(nextQuestionRows[0]).toMatch(/RQ-\d{2}: Slice 50 question \d{2}/);
    expect(firstQuestionRows).not.toContain(nextQuestionRows[0]);
    await expect.poll(() => rscRequestUrls.length).toBeGreaterThan(questionsRscCount);
    await waitForCurrentPageAndDrain();
    await page.getByRole("link", { name: "Back to Review Flow Report" }).click();
    await expect(page).toHaveURL(new RegExp(`${reportPath}$`));
    await waitForCurrentPageAndDrain();

    for (const context of CONTEXT_PAGES) {
      const path = `${reportPath}/context/${context.kind}`;
      await waitForCurrentPageAndDrain();
      await page.goto(path);
      await expect(page.getByRole("heading", { name: context.title })).toBeVisible();
      await expect(page.getByRole("link", { name: "Next page →" })).toBeVisible();
      await waitForCurrentPageAndDrain();
      const before = rscRequestUrls.length;
      await waitForCurrentPageAndDrain();
      await page.getByRole("link", { name: "Next page →" }).click();
      await expect(page).toHaveURL(new RegExp(`/review-report/context/${context.kind}\\?cursor=`));
      await expect(page.getByRole("heading", { name: context.title })).toBeVisible();
      await expect(page.getByRole("link", { name: "Restart from first page" })).toBeVisible();
      await expect.poll(() => rscRequestUrls.length).toBeGreaterThan(before);
      await waitForCurrentPageAndDrain();
    }

    for (const metric of REVIEW_REPORT_METRIC_KEYS) {
      await waitForCurrentPageAndDrain();
      await page.goto(`${reportPath}/contributors/metric/${metric}`);
      await expect(page.getByRole("heading", { name: `Metric: ${metric}` })).toBeVisible();
      await expect(page.getByText("Contribution total:")).toBeVisible();
      await waitForCurrentPageAndDrain();
    }
    for (const metric of SOURCE_METRICS) {
      for (const sourceId of [fixture.currentSourceId, fixture.archivedSourceId]) {
        await waitForCurrentPageAndDrain();
        await page.goto(`${reportPath}/contributors/source/${sourceId}/${metric}`);
        await expect(page.getByRole("heading", { name: `SearchSource ${metric}` })).toBeVisible();
        await expect(page.getByText("Contribution total:")).toBeVisible();
        await waitForCurrentPageAndDrain();
      }
    }
    for (const [path, title] of [
      [`exclusion-reason/${fixture.exclusionCriterionId}`, "Title/abstract exclusion reason"],
      [`full-text-exclusion-reason/${fixture.fullTextCriterionId}`, "Full-text exclusion reason"],
      ["overlap", "Cross-source overlap"],
    ] as const) {
      await waitForCurrentPageAndDrain();
      await page.goto(`${reportPath}/contributors/${path}`);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByText("Contribution total:")).toBeVisible();
      await waitForCurrentPageAndDrain();
    }

    const weightedSourcePath = `${reportPath}/contributors/source/${fixture.currentSourceId}/reportedResults`;
    await waitForCurrentPageAndDrain();
    await page.goto(weightedSourcePath);
    await expect(page.getByText("Contribution total:").locator("..")).toContainText("64");
    await expect(page.locator("article.item")).toHaveCount(2);
    expect(await page.locator("article.item strong").allTextContents()).toContain("0");

    const distinctSourcesPath = `${reportPath}/contributors/metric/distinctSources`;
    await waitForCurrentPageAndDrain();
    await page.goto(distinctSourcesPath);
    const sourceContributorLinks = page.getByRole("link").filter({ hasText: fixture.currentSourceName });
    await expect(sourceContributorLinks).toHaveCount(1);
    await waitForCurrentPageAndDrain();
    const beforeSourceNavigation = rscRequestUrls.length;
    await waitForCurrentPageAndDrain();
    await sourceContributorLinks.click();
    await expect(page).toHaveURL(`${projectPath}/protocol#sources`);
    await expect(page.locator("#sources")).toBeVisible();
    await expect(page.locator("#sources")).toContainText(fixture.currentSourceName);
    await expect.poll(() => rscRequestUrls.length).toBeGreaterThan(beforeSourceNavigation);
    await waitForCurrentPageAndDrain();
    await page.goBack();
    await expect(page).toHaveURL(distinctSourcesPath);
    await waitForCurrentPageAndDrain();
    const archivedSourceLink = page.getByRole("link").filter({ hasText: fixture.archivedSourceName });
    await expect(archivedSourceLink).toHaveCount(1);
    await waitForCurrentPageAndDrain();
    await archivedSourceLink.click();
    await expect(page).toHaveURL(`${projectPath}/protocol#sources`);
    await expect(page.locator("#sources")).toContainText(fixture.archivedSourceName);
    await expect(page.locator("#sources")).toContainText("archived");
    await waitForCurrentPageAndDrain();

    const pairContributorPath = `${reportPath}/contributors/metric/unresolvedDuplicatePairs`;
    await waitForCurrentPageAndDrain();
    await page.goto(pairContributorPath);
    await expect(page.getByText("Contribution total:").locator("..")).toContainText("28");
    await expect(page.locator("article.item")).toHaveCount(25);
    await waitForCurrentPageAndDrain();
    const contributorRscCount = rscRequestUrls.length;
    await waitForCurrentPageAndDrain();
    await page.getByRole("link", { name: "Next page →" }).click();
    await expect(page).toHaveURL(/\/contributors\/metric\/unresolvedDuplicatePairs\?cursor=/);
    await expect(page.locator("article.item")).toHaveCount(3);
    await expect.poll(() => rscRequestUrls.length).toBeGreaterThan(contributorRscCount);
    await waitForCurrentPageAndDrain();
    const exactPairLink = page.locator("article.item").first().getByRole("link");
    const exactPairPath = await exactPairLink.getAttribute("href");
    expect(exactPairPath).toMatch(/\/deduplication\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    await waitForCurrentPageAndDrain();
    await exactPairLink.click();
    await expect(page.getByRole("heading", { name: "Candidate records" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${projectPath}/deduplication/[0-9a-f-]+/[0-9a-f-]+$`, "i"));
    await waitForCurrentPageAndDrain();
    await page.goBack();
    await expect(page).toHaveURL(/\/contributors\/metric\/unresolvedDuplicatePairs\?cursor=/);

    const queuePath = `${projectPath}/deduplication`;
    await waitForCurrentPageAndDrain();
    await page.goto(queuePath);
    await expect(page.getByRole("heading", { name: "Deduplication queue" })).toBeVisible();
    await expect(page.locator("article.item")).toHaveCount(25);
    await waitForCurrentPageAndDrain();
    const queueRscCount = rscRequestUrls.length;
    await waitForCurrentPageAndDrain();
    await page.getByRole("link", { name: "Next page →" }).click();
    await expect(page).toHaveURL(/\/deduplication\?pageSize=25&cursor=/);
    await expect(page.locator("article.item")).toHaveCount(3);
    await expect.poll(() => rscRequestUrls.length).toBeGreaterThan(queueRscCount);
    await waitForCurrentPageAndDrain();
    const inspectPair = page.getByRole("link", { name: "Inspect pair →" }).first();
    const inspectedHref = await inspectPair.getAttribute("href");
    expect(inspectedHref).toMatch(/\/deduplication\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    await waitForCurrentPageAndDrain();
    await inspectPair.click();
    await expect(page.getByRole("heading", { name: "Candidate records" })).toBeVisible();
    await waitForCurrentPageAndDrain();
    await page.goBack();
    await expect(page).toHaveURL(/\/deduplication\?pageSize=25&cursor=/);

    const legacyRedirects = [
      {
        query: `?metric=reportedResultsTotal&sourceId=${fixture.currentSourceId}&sourceMetric=runs&criterionId=${fixture.exclusionCriterionId}&fullTextCriterionId=${fixture.fullTextCriterionId}&overlap=1`,
        destination: `${reportPath}/contributors/metric/reportedResultsTotal`,
      },
      {
        query: `?sourceId=${fixture.currentSourceId}&sourceMetric=runs&criterionId=${fixture.exclusionCriterionId}&fullTextCriterionId=${fixture.fullTextCriterionId}&overlap=1`,
        destination: `${reportPath}/contributors/source/${fixture.currentSourceId}/runs`,
      },
      {
        query: `?criterionId=${fixture.exclusionCriterionId}&fullTextCriterionId=${fixture.fullTextCriterionId}&overlap=1`,
        destination: `${reportPath}/contributors/exclusion-reason/${fixture.exclusionCriterionId}`,
      },
      {
        query: `?fullTextCriterionId=${fixture.fullTextCriterionId}&overlap=1`,
        destination: `${reportPath}/contributors/full-text-exclusion-reason/${fixture.fullTextCriterionId}`,
      },
      { query: "?overlap=1", destination: `${reportPath}/contributors/overlap` },
    ];
    for (const redirect of legacyRedirects) {
    await waitForCurrentPageAndDrain();
    await page.goto(`${reportPath}${redirect.query}`);
      await expect(page).toHaveURL(new RegExp(`${redirect.destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      await waitForCurrentPageAndDrain();
    }

    await waitForCurrentPageAndDrain();
    await page.goto(reportPath);
    await waitForCurrentPageAndDrain();
    const exportResponse = await page.request.get(`${reportPath}/export`);
    expect(exportResponse.status()).toBe(200);
    expect(exportResponse.headers()["content-type"]).toContain("text/markdown");
    const exportBody = await exportResponse.body();
    const markdown = exportBody.toString("utf8");
    expect(markdown).toContain("## Immutable SearchRun Appendix");
    expect(markdown).toContain(fixture.zeroRunQuery);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download complete Markdown" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("review-flow-report.md");

    await drainCdpBodyCaptures();
    for (const metadata of cdpResponseMetadata.values()) {
      responseCaptureFailures.push({ ...metadata, failure: `CDP response occurrence ${metadata.sameKeyOrdinal} did not reach a terminal event` });
    }
    const terminalOccurrenceCounts = new Map<string, number>();
    for (const response of transferMeasurements) {
      const key = responseOccurrenceKey(response);
      const count = terminalOccurrenceCounts.get(key) ?? 0;
      terminalOccurrenceCounts.set(key, count + 1);
      if (count > 0) responseCaptureFailures.push({ ...response, failure: `duplicate terminal CDP occurrence ${response.sameKeyOrdinal}` });
    }
    const pageOccurrenceCounts = new Map<string, number>();
    for (const metadata of pageObservedResponses) {
      const key = responseOccurrenceKey(metadata);
      const count = pageOccurrenceCounts.get(key) ?? 0;
      pageOccurrenceCounts.set(key, count + 1);
      if (count > 0) responseCaptureFailures.push({ ...metadata, failure: `duplicate Playwright response occurrence ${metadata.sameKeyOrdinal}` });
      if (terminalOccurrenceCounts.get(key) !== 1) {
        responseCaptureFailures.push({ ...metadata, failure: `no unique terminal CDP response matched occurrence ${metadata.sameKeyOrdinal}` });
      }
    }
    for (const response of transferMeasurements) {
      const key = responseOccurrenceKey(response);
      if (pageOccurrenceCounts.get(key) !== 1) responseCaptureFailures.push({ ...response, failure: `no unique Playwright response matched terminal CDP occurrence ${response.sameKeyOrdinal}` });
    }
    await cdpSession.detach();
    const completedResponseCount = transferMeasurements.filter((response) => response.completion === "complete").length;
    const cancelledResponseCount = transferMeasurements.filter((response) => response.completion === "cancelled").length;
    const failedResponseCount = transferMeasurements.filter((response) => response.completion === "failed").length;
    const exactOccurrenceMatches = pageObservedResponses.filter((metadata) => {
      const key = responseOccurrenceKey(metadata);
      return pageOccurrenceCounts.get(key) === 1 && terminalOccurrenceCounts.get(key) === 1;
    }).length;
    const measurementSummary = {
      pageObservedEligibleResponses: pageObservedResponses.length,
      terminalCdpMeasurements: transferMeasurements.length,
      exactOccurrenceMatches,
      completionCounts: {
        complete: completedResponseCount,
        cancelled: cancelledResponseCount,
        failed: failedResponseCount,
      },
      bodyCaptureCounts: {
        capturedCompleteBodies: cdpBodyCaptureDiagnostics.filter((response) => response.result === "captured").length,
        failedCompleteBodyCaptures: cdpBodyCaptureDiagnostics.filter((response) => response.result === "failed").length,
        cancelledPartialBodies: cdpBodyCaptureDiagnostics.filter((response) => response.result === "partial-cancelled").length,
        failedPartialBodies: cdpBodyCaptureDiagnostics.filter((response) => response.result === "partial-failed").length,
        decodedPayloadBytes: cdpBodyCaptureDiagnostics.reduce((total, response) => total + (response.decodedPayloadBytes ?? 0), 0),
        encodedBodyBytesReceived: cdpBodyCaptureDiagnostics.reduce((total, response) => total + response.encodedBodyBytesReceived, 0),
      },
      excludedRedirectDocuments: excludedResponses.filter((response) => response.reason.startsWith("redirect")).length,
      excludedAttachmentResponses: excludedResponses.filter((response) => response.reason.startsWith("attachment")).length,
      captureFailures: responseCaptureFailures.length,
    };
    const bodyCaptureFailureSamples = (['http-document', 'rsc-navigation'] as const).flatMap((kind) => {
      const sample = cdpBodyCaptureDiagnostics.find((response) => response.kind === kind && response.result === "failed");
      return sample ? [{
        kind: sample.kind,
        status: sample.status,
        sameKeyOrdinal: sample.sameKeyOrdinal,
        resourceType: sample.resourceType,
        contentType: sample.contentType,
        contentDisposition: sample.contentDisposition,
        result: sample.result,
        encodedBodyBytesReceived: sample.encodedBodyBytesReceived,
        decodedPayloadBytes: sample.decodedPayloadBytes,
        sanitizedReason: sample.sanitizedReason,
      }] : [];
    });
    console.log(`[slice50-response-capture] ${JSON.stringify({ summary: measurementSummary, bodyCaptureFailureSamples, excludedResponseSamples: excludedResponses.slice(-2).map(redactUrlRecord) })}`);
    await testInfo.attach("slice50-review-report-http-rsc-measurements.json", {
      body: Buffer.from(JSON.stringify({
        measurementMethod: "For each completed response, Chromium CDP Network.loadingFinished.encodedDataLength is recorded as total encoded transfer bytes and Network.dataReceived.encodedDataLength is summed as encoded response-body bytes. Network.getResponseBody is requested immediately from the Network.loadingFinished callback for that exact CDP requestId; decoded payload bytes are counted after base64 decoding when indicated. Cancelled and failed requests are explicitly partial and use only their received encoded body-byte sums. Encoded transfer/body bytes are separate from decoded payload bytes and service DTO JSON payload bytes measured by the benchmark. Page-observed responses and terminal CDP measurements are verified one-to-one by independently assigned same-key occurrence ordinals.",
        summary: measurementSummary,
        responses: transferMeasurements.map(redactUrlRecord),
        cdpBodyCaptureDiagnostics: cdpBodyCaptureDiagnostics.map(redactUrlRecord),
        excludedResponses: excludedResponses.map(redactUrlRecord),
        captureFailures: responseCaptureFailures.map(redactUrlRecord),
        speculativePrefetchRequests: speculativePrefetchRequests.map(redactUrlRecord),
        markdownExport: {
          url: redactUrl(exportResponse.url()),
          status: exportResponse.status(),
          contentType: exportResponse.headers()["content-type"] ?? "",
          contentLength: exportResponse.headers()["content-length"] ?? null,
          contentDisposition: exportResponse.headers()["content-disposition"] ?? "",
          responsePayloadBytes: exportBody.byteLength,
          measurementMethod: "Playwright APIResponse.body() byte length; response payload bytes, separate from CDP encoded transfer bytes.",
        },
      }, null, 2)),
      contentType: "application/json",
    });
    expect(responseCaptureFailures.length, JSON.stringify({ summary: measurementSummary, bodyCaptureFailureSamples })).toBe(0);
    expect(measurementSummary.exactOccurrenceMatches).toBe(measurementSummary.pageObservedEligibleResponses);
    expect(measurementSummary.terminalCdpMeasurements).toBe(measurementSummary.pageObservedEligibleResponses);
    expect(measurementSummary.bodyCaptureCounts.capturedCompleteBodies).toBe(completedResponseCount);
    expect(measurementSummary.bodyCaptureCounts.failedCompleteBodyCaptures).toBe(0);
    expect(measurementSummary.bodyCaptureCounts.cancelledPartialBodies + measurementSummary.bodyCaptureCounts.failedPartialBodies).toBe(cancelledResponseCount + failedResponseCount);
    expect(speculativePrefetchRequests.length).toBe(0);
    expect(transferMeasurements.some((response) => response.kind === "http-document" && response.completion === "complete" && (response.encodedTransferBytes ?? 0) > 0)).toBe(true);
    expect(transferMeasurements.some((response) => response.kind === "rsc-navigation" && response.encodedBodyBytesReceived > 0)).toBe(true);
    expect(excludedResponses.some((response) => response.contentType.includes("text/markdown") && response.contentDisposition.toLowerCase().includes("attachment"))).toBe(true);
  });
});
