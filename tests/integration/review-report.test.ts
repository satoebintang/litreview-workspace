/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createBoundedReviewReportingServices } from "@/application/bounded-review-reporting-services";
import { serializeReviewFlowMarkdown } from "@/application/review-reporting";
import { REVIEW_REPORT_METRIC_KEYS, type ReviewReportContributorSelector } from "@/domain/review-report";
import type { Database } from "@/db/client";
import { schema } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice11_report_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
let services!: ReturnType<typeof createReviewServices>;
let appClient!: postgres.Sql;
let projectId = "";
let ready = false;

describe("Slice 11 review report projection", () => {
  beforeAll(async () => {
    try {
      const admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      await admin.end();
      const created = createDb(TEST_DB_URL);
      services = createReviewServices(created.db);
      appClient = created.client;
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      projectId = (await services.createProject({ title: "Report projection" })).id;
      ready = true;
    } catch { ready = false; }
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    const admin = postgres(BASE_URL, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  it("derives source snapshots, overlap, current screening, and deterministic Markdown", async () => {
    if (!ready) return;
    const sources = await services.listSearchSources(projectId);
    const first = sources[0];
    const second = sources[1];
    const strategyA = await services.createSearchStrategy(projectId, { searchSourceId: first.id, name: "A", queryText: "alpha" });
    const strategyB = await services.createSearchStrategy(projectId, { searchSourceId: second.id, name: "B", queryText: "beta" });
    const runA = await services.createSearchRun(projectId, { searchSourceId: first.id, sourceKeySnapshot: first.sourceKey, sourceDisplayNameSnapshot: first.displayName, strategyId: strategyA.id, queryText: "alpha", reportedResultCount: 10, executedAt: new Date("2026-01-01T00:00:00Z") });
    const runB = await services.createSearchRun(projectId, { searchSourceId: second.id, sourceKeySnapshot: second.sourceKey, sourceDisplayNameSnapshot: second.displayName, strategyId: strategyB.id, queryText: "beta", reportedResultCount: 1, executedAt: new Date("2026-01-02T00:00:00Z") });
    const recordA = await services.createRetrievedRecord(projectId, { searchRunId: runA.id, searchSourceId: first.id, title: "Shared paper", retrievedAt: new Date("2026-01-01T01:00:00Z") });
    const recordA2 = await services.createRetrievedRecord(projectId, { searchRunId: runA.id, searchSourceId: first.id, title: "Shared paper second result", retrievedAt: new Date("2026-01-01T01:01:00Z") });
    const recordB = await services.createRetrievedRecord(projectId, { searchRunId: runB.id, searchSourceId: second.id, title: "Shared paper copy", retrievedAt: new Date("2026-01-02T01:00:00Z") });
    const paper = await services.addPaper(projectId, { title: "Shared paper" });
    await services.linkRetrievedRecordToPaper(projectId, recordA.id, paper.id);
    await services.linkRetrievedRecordToPaper(projectId, recordA2.id, paper.id);
    await services.linkRetrievedRecordToPaper(projectId, recordB.id, paper.id);
    const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Wrong population" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });

    const report = await services.getReviewReport(projectId);
    expect(report.identification.metrics.find((item: any) => item.key === "reportedResultsTotal")).toMatchObject({ value: 11, support: "supported" });
    expect(report.identification.metrics.find((item: any) => item.key === "retrievedRecords")).toMatchObject({ value: 3 });
    const firstSource = report.identification.bySource.find((source: any) => source.source.id === first.id);
    expect(firstSource).toMatchObject({ reportedResults: 10, retrievedRecords: 2 });
    expect(report.identification.overlappingPaperCount).toBe(1);
    expect(report.limitations.some((item: any) => item.code === "reported_results_exceed_entered_records")).toBe(true);
    expect(report.limitations.some((item: any) => item.code === "cross_source_paper_overlap")).toBe(true);
    expect(report.screening.exclusionReasons).toMatchObject([{ text: "Wrong population", count: 1 }]);
    const runContributor = await services.listReviewReportContributors(projectId, { scope: "metric", metric: "reportedResultsTotal" });
    expect(runContributor.total).toBe(11);
    const overlapContributor = await services.listReviewReportContributors(projectId, { scope: "overlap" });
    expect(overlapContributor.total).toBe(1);
    const markdown = serializeReviewFlowMarkdown(report);
    expect(markdown).toContain("Results reported by recorded searches: 11");
    expect(markdown).toContain("Full-text eligibility");
    expect(markdown).not.toContain("generatedAt");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown).toBe(serializeReviewFlowMarkdown(report));
    await services.updateSearchSource(projectId, first.id, { displayName: "Renamed current source" });
    const afterRename = await services.getReviewReport(projectId);
    const renamedMarkdown = serializeReviewFlowMarkdown(afterRename);
    expect(renamedMarkdown).toContain(`#### ${first.displayName} (${first.sourceKey})`);
    expect(renamedMarkdown).toContain("Current SearchSource configuration: Renamed current source");

    const renamedSource = await services.getSearchSource(projectId, first.id);
    await services.createSearchRun(projectId, { searchSourceId: first.id, sourceKeySnapshot: renamedSource.sourceKey, sourceDisplayNameSnapshot: renamedSource.displayName, strategyId: strategyA.id, queryText: "alpha", reportedResultCount: 2, executedAt: new Date("2026-01-03T00:00:00Z") });
    const interactive = await services.getInteractiveReviewReport(projectId);
    const compactSource = interactive.identification.bySource.find((source: any) => source.source.id === first.id)!;
    expect(interactive.identification.runs).toEqual([]);
    expect(compactSource.observedSnapshots).toEqual([{ sourceKey: first.sourceKey, displayName: first.displayName }]);
    expect(compactSource.historicalSnapshotCount).toBe(2);
    const complete = await services.getReviewReport(projectId);
    const completeMarkdown = serializeReviewFlowMarkdown(complete);
    expect(complete.identification.runs).toHaveLength(3);
    expect(completeMarkdown).toContain(`- Historical run labels: ${first.displayName} [${first.sourceKey}]; Renamed current source [${first.sourceKey}]`);
    expect(completeMarkdown).toContain("## Immutable SearchRun Appendix");
  });

  it("bounds summary, context, and every contributor selector while matching released readers", async () => {
    if (!ready) return;
    const blankTitlePairs = await appClient.unsafe(`
      with sample(id, title, publication_year) as (
        values (1, '', 2024), (2, '   ', 2024), (3, 'Different title', 2024)
      ), normalized as (
        select id, publication_year, lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g')) as title_key
        from sample
      ), legacy_pairs as (
        select a.id as left_id, b.id as right_id
        from sample a join sample b on a.id < b.id and a.publication_year is not null
          and b.publication_year = a.publication_year
          and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g'))
            = lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g'))
      ), duplicate_keys as (
        select publication_year, title_key from normalized
        group by publication_year, title_key having count(*) > 1
      ), grouped_pairs as (
        select a.id as left_id, b.id as right_id
        from duplicate_keys k
        join normalized a on a.publication_year = k.publication_year and a.title_key = k.title_key
        join normalized b on b.publication_year = k.publication_year and b.title_key = k.title_key and a.id < b.id
      )
      select
        (select json_agg(json_build_array(left_id, right_id) order by left_id, right_id) from legacy_pairs) as legacy_pairs,
        (select json_agg(json_build_array(left_id, right_id) order by left_id, right_id) from grouped_pairs) as grouped_pairs
    `) as unknown as Array<{ legacy_pairs: unknown; grouped_pairs: unknown }>;
    expect(blankTitlePairs[0]?.legacy_pairs).toEqual([[1, 2]]);
    expect(blankTitlePairs[0]?.grouped_pairs).toEqual(blankTitlePairs[0]?.legacy_pairs);

    const project = await services.createProject({ title: "Bounded report equivalence" });
    const sources = await services.listSearchSources(project.id);
    const sourceA = sources[0];
    const sourceB = sources[1];
    const strategyA = await services.createSearchStrategy(project.id, { searchSourceId: sourceA.id, name: "Bounded A", queryText: "bounded-a" });
    const strategyB = await services.createSearchStrategy(project.id, { searchSourceId: sourceB.id, name: "Bounded B", queryText: "bounded-b" });
    const run = async (source: typeof sourceA, strategy: typeof strategyA, reportedResultCount: number, offset: number) => services.createSearchRun(project.id, {
      searchSourceId: source.id,
      sourceKeySnapshot: source.sourceKey,
      sourceDisplayNameSnapshot: source.displayName,
      strategyId: strategy.id,
      queryText: strategy.queryText,
      reportedResultCount,
      executedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, offset)),
    });
    const zeroRun = await run(sourceA, strategyA, 0, 1);
    const runA = await run(sourceA, strategyA, 7, 2);
    const runB = await run(sourceB, strategyB, 5, 3);

    const record = async (searchRun: typeof runA, source: typeof sourceA, title: string, extra: { doi?: string; sourceRecordId?: string; publicationYear?: number } = {}) => services.createRetrievedRecord(project.id, {
      searchRunId: searchRun.id,
      searchSourceId: source.id,
      title,
      retrievedAt: new Date("2026-01-02T00:00:00Z"),
      ...extra,
    });
    const sharedPaper = await services.addPaper(project.id, { title: "Shared current Paper" });
    const sharedA1 = await record(runA, sourceA, "Source A first linked title");
    const sharedA2 = await record(runA, sourceA, "Source A second linked title");
    const sharedB = await record(runB, sourceB, "Source B linked title");
    await services.linkRetrievedRecordToPaper(project.id, sharedA1.id, sharedPaper.id);
    await services.linkRetrievedRecordToPaper(project.id, sharedA2.id, sharedPaper.id);
    await services.linkRetrievedRecordToPaper(project.id, sharedB.id, sharedPaper.id);

    const formerPaper = await services.addPaper(project.id, { title: "Historical-only Paper" });
    const historicalRecord = await record(runA, sourceA, "Eventually unlinked title");
    await services.linkRetrievedRecordToPaper(project.id, historicalRecord.id, formerPaper.id);
    await services.unlinkRetrievedRecordFromPaper(project.id, historicalRecord.id, formerPaper.id);

    const makePair = async (prefix: string, extras: { doi?: string; publicationYear?: number; title: string }) => {
      const left = await record(runA, sourceA, `${prefix} left`, { ...extras, sourceRecordId: `${prefix}-left` });
      const right = await record(runA, sourceA, `${prefix} right`, { ...extras, sourceRecordId: `${prefix}-right` });
      return [left, right] as const;
    };
    const unresolvedStrong = await makePair("unresolved-strong", { title: "Unique strong left", doi: "10.5555/slice50-strong-unresolved" });
    const unresolvedPossible = await Promise.all([
      record(runA, sourceA, "Possible duplicate title", { publicationYear: 2024, sourceRecordId: "unresolved-possible-left" }),
      record(runA, sourceA, "  possible   duplicate title ", { publicationYear: 2024, sourceRecordId: "unresolved-possible-right" }),
    ]);
    const multiSignalPair = await Promise.all([
      record(runA, sourceA, "  Multi-signal candidate title ", { doi: "doi:10.5555/multi-signal", publicationYear: 2024, sourceRecordId: "multi-signal-record" }),
      record(zeroRun, sourceA, "multi-signal   candidate title", { doi: "https://doi.org/10.5555/multi-signal", publicationYear: 2024, sourceRecordId: "multi-signal-record" }),
    ]);
    const canonicalMultiSignalIds = multiSignalPair.map(({ id }) => id).sort();
    const queuedMultiSignal = (await services.listDeduplicationQueue(project.id)).find((item: any) =>
      item.leftRetrievedRecord?.id === canonicalMultiSignalIds[0] && item.rightRetrievedRecord?.id === canonicalMultiSignalIds[1]);
    expect(queuedMultiSignal).toMatchObject({ strength: "strong", reasons: ["normalized_doi", "same_source_record_id", "normalized_title_year"] });
    const sameWorkPair = await makePair("same-work", { title: "Same work candidate", doi: "10.5555/slice50-same-work" });
    const differentWorkPair = await makePair("different-work", { title: "Different work candidate", doi: "10.5555/slice50-different-work" });
    await services.confirmSameWork(project.id, sameWorkPair[0].id, sameWorkPair[1].id);
    await services.decideDifferentWork(project.id, differentWorkPair[0].id, differentWorkPair[1].id);
    await services.confirmSameWork(project.id, differentWorkPair[0].id, differentWorkPair[1].id);
    await services.decideDifferentWork(project.id, sameWorkPair[0].id, sameWorkPair[1].id);

    const taCriterionIds: string[] = [];
    const taPapers: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const criterion = await services.createScreeningCriterion(project.id, { type: "exclusion", text: `TA criterion ${String(index).padStart(2, "0")}${index === 0 ? ` ${"x".repeat(700)}` : ""}` });
      const paper = await services.addPaper(project.id, { title: `TA reason paper ${String(index).padStart(2, "0")}` });
      await services.recordScreeningDecision(project.id, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });
      taCriterionIds.push(criterion.id);
      taPapers.push(paper.id);
    }
    await services.archiveScreeningCriterion(project.id, taCriterionIds[0]);

    const ftCriterionIds: string[] = [];
    const ftPapers: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const criterion = await services.createFullTextScreeningCriterion(project.id, { text: `FT criterion ${String(index).padStart(2, "0")}${index === 0 ? ` ${"y".repeat(700)}` : ""}` });
      const paper = await services.addPaper(project.id, { title: `FT reason paper ${String(index).padStart(2, "0")}` });
      await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date("2026-01-03T00:00:00Z") });
      await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });
      ftCriterionIds.push(criterion.id);
      ftPapers.push(paper.id);
    }
    await services.archiveFullTextScreeningCriterion(project.id, ftCriterionIds[0]);

    const currentRetrieved = await services.addPaper(project.id, { title: "Current retrieved" });
    await services.recordScreeningDecision(project.id, currentRetrieved.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, currentRetrieved.id, { outcome: "retrieved", attemptedAt: new Date("2026-01-04T00:00:00Z") });
    const currentUnavailable = await services.addPaper(project.id, { title: "Current unavailable after success" });
    await services.recordScreeningDecision(project.id, currentUnavailable.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, currentUnavailable.id, { outcome: "retrieved", attemptedAt: new Date("2026-01-04T00:00:00Z") });
    await services.recordFullTextRetrievalAttempt(project.id, currentUnavailable.id, { outcome: "unavailable", attemptedAt: new Date("2026-01-05T00:00:00Z") });
    const conflictedPaper = await services.addPaper(project.id, { title: "Current retrieval conflict" });
    await services.recordScreeningDecision(project.id, conflictedPaper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, conflictedPaper.id, { outcome: "retrieved", attemptedAt: new Date("2026-01-06T00:00:00Z") });
    await services.recordFullTextScreeningDecision(project.id, conflictedPaper.id, { decision: "maybe" });
    await services.recordScreeningDecision(project.id, conflictedPaper.id, { decision: "exclude", exclusionCriterionId: taCriterionIds[1] });

    const legacyFullTextPaper = await services.addPaper(project.id, { title: "Legacy full-text awaiting Paper" });
    await services.recordScreeningDecision(project.id, legacyFullTextPaper.id, { decision: "include" });
    // A current TA include with no full-text event keeps the released legacy blank decision identity.

    const randomizedHistoryPaper = await services.addPaper(project.id, { title: "Deterministic decision history" });
    for (const decision of ["exclude", "maybe", "include", "exclude", "include"] as const) {
    await services.recordScreeningDecision(project.id, randomizedHistoryPaper.id, decision === "exclude"
      ? { decision, exclusionCriterionId: taCriterionIds[2] }
      : { decision });
    }
    let screeningHistorySeed = 0x50c0ffee;
    const nextScreeningHistoryInt = (maximum: number) => {
      screeningHistorySeed = (Math.imul(screeningHistorySeed, 1_664_525) + 1_013_904_223) >>> 0;
      return screeningHistorySeed % maximum;
    };
    const randomHistoryDecisions = ["exclude", "maybe", "include"] as const;
    for (let paperIndex = 0; paperIndex < 12; paperIndex += 1) {
      const paper = await services.addPaper(project.id, { title: `Seeded screening history ${paperIndex + 1}` });
      const historyLength = 2 + nextScreeningHistoryInt(5);
      for (let eventIndex = 0; eventIndex < historyLength; eventIndex += 1) {
        const decision = randomHistoryDecisions[nextScreeningHistoryInt(randomHistoryDecisions.length)]!;
        if (decision === "exclude") {
          await services.recordScreeningDecision(project.id, paper.id, {
            decision,
            exclusionCriterionId: taCriterionIds[1 + nextScreeningHistoryInt(4)]!,
          });
        } else {
          await services.recordScreeningDecision(project.id, paper.id, { decision });
        }
      }
    }
    const questionIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const question = await services.createResearchQuestion(project.id, {
        identifier: `RQ${String(index + 1).padStart(2, "0")}`,
        label: index === 0 ? `Question ${index} ${"z".repeat(700)}` : `Question ${index}`,
      });
      questionIds.push(question.id);
    }
    await services.reorderResearchQuestions(project.id, questionIds);
    await services.updateSearchSource(project.id, sourceA.id, { displayName: "Renamed bounded source A" });
    await services.archiveSearchStrategy(project.id, strategyA.id);
    await services.archiveSearchSource(project.id, sourceA.id);

    const trackedQueries: string[] = [];
    const trackedDb = drizzle(appClient, { schema, logger: { logQuery(query) { trackedQueries.push(query); } } }) as Database;
    const bounded = createBoundedReviewReportingServices(trackedDb);
    const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const executeWithinBudget = async <T>(limit: number, fn: () => Promise<T>) => {
      trackedQueries.length = 0;
      const value = await fn();
      expect(trackedQueries.filter((query) => /^\s*(select|with)\b/i.test(query)).length).toBeLessThanOrEqual(limit);
      return value;
    };

    const summary = await executeWithinBudget(4, () => bounded.getInteractiveReviewReportSummary(project.id));
    expect(serializedBytes(summary)).toBeLessThanOrEqual(256 * 1024);
    expect(summary.contextCounts.activeResearchQuestions).toBe(12);
    expect(summary.contextCounts.representedSearchSources).toBe(2);
    expect(summary.screening.exclusionReasons.items).toHaveLength(10);
    expect(summary.screening.exclusionReasons.hasMore).toBe(true);
    expect(summary.fullTextEligibility.exclusionReasons.items).toHaveLength(10);
    expect(summary.fullTextEligibility.exclusionReasons.hasMore).toBe(true);
    expect(summary.identification.overlappingPaperCount).toBe(1);
    expect(summary.limitations.some((item) => item.code === "cross_source_paper_overlap")).toBe(true);
    expect(summary.screening.exclusionReasons.items.find((item) => item.criterionId === taCriterionIds[0])).toMatchObject({ archived: true, textTruncated: true });

    const traverseContext = async (kind: "questions" | "screening-criteria" | "full-text-criteria" | "sources" | "exclusion-reasons" | "full-text-exclusion-reasons") => {
      const items: any[] = [];
      let cursor: string | null = null;
      let count = 0;
      do {
        const page = await executeWithinBudget(2, () => bounded.listReviewReportContextPage(project.id, kind, { pageSize: 4, cursor }));
        expect(page.items.length).toBeLessThanOrEqual(4);
        expect(serializedBytes(page)).toBeLessThanOrEqual(128 * 1024);
        items.push(...page.items);
        cursor = page.nextCursor;
        count += 1;
        expect(count).toBeLessThan(10);
      } while (cursor);
      return items;
    };
    const legacyReport = await services.getInteractiveReviewReport(project.id);
    const summaryMetrics = [
      ...summary.identification.metrics,
      ...summary.deduplication.metrics,
      ...summary.screening.metrics,
      ...summary.fullTextRetrieval.metrics,
      ...summary.fullTextEligibility.metrics,
      ...summary.finalEligibility.metrics,
    ];
    const legacyMetrics = [
      ...legacyReport.identification.metrics,
      ...legacyReport.deduplication.metrics,
      ...legacyReport.screening.metrics,
      ...legacyReport.fullTextRetrieval.metrics,
      ...legacyReport.fullTextEligibility.metrics,
      ...legacyReport.finalEligibility.metrics,
    ];
    expect(summaryMetrics).toEqual(legacyMetrics);
    expect(summary.supportMatrix).toEqual(legacyReport.supportMatrix);
    expect(summary.limitations).toEqual(legacyReport.limitations);
    expect(summary.identification.overlappingPaperCount).toBe(legacyReport.identification.overlappingPaperCount);
    expect(summary.contextCounts).toEqual({
      activeResearchQuestions: legacyReport.activeResearchQuestions.length,
      activeScreeningCriteria: legacyReport.activeCriteria.length,
      activeFullTextCriteria: legacyReport.activeFullTextCriteria.length,
      representedSearchSources: legacyReport.identification.bySource.length,
    });
    const questions = await traverseContext("questions");
    const screeningCriteria = await traverseContext("screening-criteria");
    const fullTextCriteria = await traverseContext("full-text-criteria");
    const representedSources = await traverseContext("sources");
    const taReasons = await traverseContext("exclusion-reasons");
    const ftReasons = await traverseContext("full-text-exclusion-reasons");
    expect(questions.map((item) => item.id)).toEqual(legacyReport.activeResearchQuestions.map((item: any) => item.id));
    expect(screeningCriteria.map((item) => item.id)).toEqual(legacyReport.activeCriteria.map((item: any) => item.id));
    expect(fullTextCriteria.map((item) => item.id)).toEqual(legacyReport.activeFullTextCriteria.map((item: any) => item.id));
    expect(representedSources.map((item) => item.id)).toEqual(legacyReport.identification.bySource.map((item: any) => item.source.id));
    expect(taReasons.map(({ criterionId, archived, count }) => ({ criterionId, archived, count }))).toEqual(legacyReport.screening.exclusionReasons.map(({ criterionId, archived, count }: any) => ({ criterionId, archived, count })));
    expect(ftReasons.map(({ criterionId, archived, count }) => ({ criterionId, archived, count }))).toEqual(legacyReport.fullTextEligibility.exclusionReasons.map(({ criterionId, archived, count }: any) => ({ criterionId, archived, count })));
    expect(taReasons.find((item) => item.criterionId === taCriterionIds[0])).toMatchObject({ archived: true, textTruncated: true });
    expect(ftReasons.find((item) => item.criterionId === ftCriterionIds[0])).toMatchObject({ archived: true, textTruncated: true });
    const firstQuestions = await bounded.listReviewReportContextPage(project.id, "questions");
    expect(firstQuestions).toMatchObject({ pageSize: 10, hasMore: true });
    expect(firstQuestions.items).toHaveLength(10);
    expect(firstQuestions.items[0]).toMatchObject({ kind: "question", labelTruncated: true });
    expect(representedSources.find((item) => item.id === sourceA.id)).toMatchObject({ archived: true, displayName: "Renamed bounded source A" });
    expect(screeningCriteria.some((item) => item.id === taCriterionIds[0])).toBe(false);
    expect(taReasons.some((item) => item.criterionId === taCriterionIds[0] && item.archived)).toBe(true);

    const comparable = (item: any) => ({
      kind: item.kind,
      id: item.id,
      label: item.label,
      contribution: item.contribution,
      paperId: item.paperId ?? (item.kind === "paper" ? item.id : null),
      decision: item.decision ?? "",
      leftRecordId: item.leftRecordId ?? null,
      rightRecordId: item.rightRecordId ?? null,
      searchRunId: item.searchRunId ?? null,
      sourceId: item.sourceId ?? null,
      recordCount: item.recordCount ?? null,
    });
    const collectContributors = async (selector: ReviewReportContributorSelector) => {
      const items: any[] = [];
      let cursor: string | null = null;
      let total: number | undefined;
      let calls = 0;
      do {
        const page = await executeWithinBudget(2, () => bounded.listReviewReportContributorPage(project.id, selector, { pageSize: 2, cursor }));
        expect(page.items.length).toBeLessThanOrEqual(2);
        expect(serializedBytes(page)).toBeLessThanOrEqual(256 * 1024);
        total = page.contributionTotal;
        items.push(...page.items);
        cursor = page.nextCursor;
        calls += 1;
        expect(calls).toBeLessThan(40);
      } while (cursor);
      return { items, total };
    };
    for (const metric of REVIEW_REPORT_METRIC_KEYS) {
      const selector = { scope: "metric", metric } as const;
      const legacy = await services.listReviewReportContributors(project.id, selector);
      const boundedPage = await collectContributors(selector);
      expect(boundedPage.total, metric).toBe(legacy.total);
      expect(boundedPage.items.map(comparable), metric).toEqual(legacy.items.map(comparable));
    }
    const zeroRunPage = await bounded.listReviewReportContributorPage(project.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 50 });
    expect(zeroRunPage.items.find((item) => item.id === zeroRun.id)).toMatchObject({ kind: "searchRun", contribution: 0 });
    expect(zeroRunPage.contributionTotal).toBe(12);
    const paginationProject = await services.createProject({ title: "Wrong-scope and BIGINT report pagination" });
    const liveRunFirstPage = await executeWithinBudget(2, () => bounded.listReviewReportContributorPage(project.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 2 }));
    expect(liveRunFirstPage.nextCursor).not.toBeNull();
    await expect(bounded.listReviewReportContributorPage(paginationProject.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 2, cursor: liveRunFirstPage.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bounded.listReviewReportContributorPage(project.id, { scope: "metric", metric: "distinctSearchRuns" }, { pageSize: 2, cursor: liveRunFirstPage.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bounded.listReviewReportContributorPage(project.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 3, cursor: liveRunFirstPage.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const appendedZeroRun = await run(sourceB, strategyB, 0, 4);
    const liveRunNextPage = await executeWithinBudget(2, () => bounded.listReviewReportContributorPage(project.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 2, cursor: liveRunFirstPage.nextCursor }));
    expect(liveRunNextPage.items.some((item) => item.id === appendedZeroRun.id)).toBe(true);
    const paginationSources = await services.listSearchSources(paginationProject.id);
    const paginationSource = paginationSources[0]!;
    const paginationStrategy = await services.createSearchStrategy(paginationProject.id, {
      searchSourceId: paginationSource.id,
      name: "BIGINT sequence ordering",
      queryText: "bounded-report-bigint-sequence",
    });
    const sequenceLow = "9007199254740992";
    const sequenceHigh = "9007199254740993";
    const sequenceLowId = "00000000-0000-4000-8000-000000000002";
    const sequenceHighId = "00000000-0000-4000-8000-000000000001";
    expect(sequenceLowId.localeCompare(sequenceHighId)).toBeGreaterThan(0);
    await appClient`
      insert into search_runs (
        id, sequence, project_id, search_source_id, source_key_snapshot,
        source_display_name_snapshot, strategy_id, query_text, reported_result_count, executed_at
      ) overriding system value values (
        ${sequenceLowId}::uuid, ${sequenceLow}::bigint, ${paginationProject.id}::uuid, ${paginationSource.id}::uuid,
        ${paginationSource.sourceKey}, ${paginationSource.displayName}, ${paginationStrategy.id}::uuid,
        'bounded-report-bigint-sequence', 3, ${"2026-02-01T00:00:00Z"}::timestamptz
      )
    `;
    await appClient`
      insert into search_runs (
        id, sequence, project_id, search_source_id, source_key_snapshot,
        source_display_name_snapshot, strategy_id, query_text, reported_result_count, executed_at
      ) overriding system value values (
        ${sequenceHighId}::uuid, ${sequenceHigh}::bigint, ${paginationProject.id}::uuid, ${paginationSource.id}::uuid,
        ${paginationSource.sourceKey}, ${paginationSource.displayName}, ${paginationStrategy.id}::uuid,
        'bounded-report-bigint-sequence', 8, ${"2026-02-02T00:00:00Z"}::timestamptz
      )
    `;
    const bigintFirstPage = await bounded.listReviewReportContributorPage(paginationProject.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 1 });
    expect(bigintFirstPage.contributionTotal).toBe(11);
    expect(bigintFirstPage.hasMore).toBe(true);
    expect(bigintFirstPage.nextCursor).toBeTruthy();
    expect(bigintFirstPage.items.map((item) => item.id)).toEqual([sequenceLowId]);
    expect(bigintFirstPage.items[0]?.label).toContain(`Run ${sequenceLow}`);
    const bigintSecondPage = await bounded.listReviewReportContributorPage(paginationProject.id, { scope: "metric", metric: "reportedResultsTotal" }, { pageSize: 1, cursor: bigintFirstPage.nextCursor });
    expect(bigintSecondPage.contributionTotal).toBe(11);
    expect(bigintSecondPage.hasMore).toBe(false);
    expect(bigintSecondPage.nextCursor).toBeNull();
    expect(bigintSecondPage.items.map((item) => item.id)).toEqual([sequenceHighId]);
    expect(bigintSecondPage.items[0]?.label).toContain(`Run ${sequenceHigh}`);
    for (const source of [sourceA, sourceB]) {
      for (const metric of ["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"] as const) {
        const selector = { scope: "source", sourceId: source.id, metric } as const;
        const legacy = await services.listReviewReportContributors(project.id, selector);
        const actual = await collectContributors(selector);
        expect(actual.total, `${source.id}:${metric}`).toBe(legacy.total);
        expect(actual.items.map(comparable), `${source.id}:${metric}`).toEqual(legacy.items.map(comparable));
      }
    }
    for (const selector of [
      { scope: "exclusionReason", criterionId: taCriterionIds[0] },
      { scope: "fullTextExclusionReason", criterionId: ftCriterionIds[0] },
      { scope: "overlap" },
    ] as const) {
      const legacy = await services.listReviewReportContributors(project.id, selector);
      const actual = await collectContributors(selector);
      expect(actual.total, selector.scope).toBe(legacy.total);
      expect(actual.items.map(comparable), selector.scope).toEqual(legacy.items.map(comparable));
    }
    const legacyEligible = await services.listReviewReportContributors(project.id, { scope: "metric", metric: "fullTextEligible" });
    const boundedEligible = await collectContributors({ scope: "metric", metric: "fullTextEligible" });
    expect(legacyEligible.items.length).toBeGreaterThan(0);
    expect(boundedEligible.items.filter((item) => item.kind === "fullTextScreeningDecision").every((item) => item.id === "" && item.decision === "")).toBe(true);
    expect(boundedEligible.items.filter((item) => item.kind === "fullTextScreeningDecision").every((item) => Boolean(item.paperId))).toBe(true);
    const legacyAwaiting = await services.listReviewReportContributors(project.id, { scope: "metric", metric: "fullTextAwaiting" });
    const boundedAwaiting = await collectContributors({ scope: "metric", metric: "fullTextAwaiting" });
    expect(legacyAwaiting.items.some((item: any) => item.id === "" && item.decision === "")).toBe(true);
    expect(boundedAwaiting.items.filter((item) => item.kind === "fullTextScreeningDecision").every((item) => item.id === "" && item.decision === "")).toBe(true);
    for (const metric of ["fullTextRetrieved", "fullTextUnavailable"] as const) {
      const legacy = await services.listReviewReportContributors(project.id, { scope: "metric", metric });
      const actual = await collectContributors({ scope: "metric", metric });
      expect(actual.items.map(comparable), metric).toEqual(legacy.items.map(comparable));
      expect(actual.items.every((item) => item.kind === "fullTextScreeningDecision" && item.id === "" && item.decision === ""), metric).toBe(true);
    }

    const firstQuestionPage = await bounded.listReviewReportContextPage(project.id, "questions", { pageSize: 4 });
    await expect(bounded.listReviewReportContextPage(paginationProject.id, "questions", { pageSize: 4, cursor: firstQuestionPage.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await services.createResearchQuestion(project.id, { identifier: "RQ-LIVE", label: "Added after first page" });
    const liveNextPage = await bounded.listReviewReportContextPage(project.id, "questions", { pageSize: 4, cursor: firstQuestionPage.nextCursor });
    expect(liveNextPage.items.every((item) => item.kind === "question" && !firstQuestionPage.items.some((first) => first.kind === "question" && first.id === item.id))).toBe(true);
    await expect(bounded.listReviewReportContextPage(project.id, "sources", { pageSize: 4, cursor: firstQuestionPage.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bounded.listReviewReportContextPage(project.id, "questions", { pageSize: 25, cursor: firstQuestionPage.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bounded.listReviewReportContextPage(project.id, "questions", { cursor: "!!!" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bounded.listReviewReportContributorPage(project.id, { scope: "metric", metric: "included" }, { cursor: "!!!" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const clamped = await bounded.listReviewReportContextPage(project.id, "questions", { pageSize: 100 });
    expect(clamped.pageSize).toBe(25);
    expect(clamped.items.length).toBeLessThanOrEqual(25);
    expect(unresolvedStrong).toHaveLength(2);
    expect(unresolvedPossible).toHaveLength(2);
    expect(taPapers).toHaveLength(12);
    expect(ftPapers).toHaveLength(12);
  });
});
