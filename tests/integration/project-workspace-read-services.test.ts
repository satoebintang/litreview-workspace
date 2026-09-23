import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { unresolvedDuplicatePairCtes } from "@/application/unresolved-duplicate-pair-query";
import { retrievedRecordDoiComparison } from "@/db/comparison-expressions";
import { normalizeDoiForComparison } from "@/domain/search-normalization";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice32_workspace_${Date.now()}`;
const DATABASE_URL = `${BASE_URL.replace(/\/[^/]+$/, "")}/${DATABASE_NAME}`;

describe("Slice 32 project workspace read models", () => {
  let appClient: postgres.Sql | undefined;
  let appDb: ReturnType<typeof createDb>["db"] | undefined;
  let admin: postgres.Sql | undefined;
  let services: ReturnType<typeof createReviewServices>;
  let ready = false;

  beforeAll(async () => {
    try {
      admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
      const created = createDb(DATABASE_URL);
      appClient = created.client;
      appDb = created.db;
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      services = createReviewServices(created.db);
      ready = true;
    } catch {
      ready = false;
    }
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("returns bounded deterministic project pages and stable first-question summaries", async () => {
    if (!ready) return;
    for (let index = 0; index < 25; index += 1) await services.createProject({ title: `Project ${index}` });
    const ordered = await services.createProject({ title: "Stable question project" });
    await services.createResearchQuestion(ordered.id, { identifier: "RQ2", label: "Created second", sortOrder: 0 });
    await services.createResearchQuestion(ordered.id, { identifier: "RQ1", label: "Created first", sortOrder: 0 });

    const firstPage = await services.listProjectCards({ page: 1 });
    const secondPage = await services.listProjectCards({ page: 2 });
    expect(firstPage.pageSize).toBe(24);
    expect(firstPage.projects).toHaveLength(24);
    expect(firstPage.totalCount).toBe(26);
    expect(secondPage.projects).toHaveLength(2);
    expect(firstPage.projects[0].title).toBe("Stable question project");

    const stable = firstPage.projects.find((project) => project.id === ordered.id);
    expect(stable?.firstResearchQuestion).toBe("Created second");
    expect(stable?.researchQuestionCount).toBe(2);
  });

  it("derives Overview facts from current research state without creating state", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: "Overview facts" });
    const paper = await services.addPaper(project.id, { title: "Included paper" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.createExtractionField(project.id, { name: "Outcome", fieldType: "short_text", required: true });

    const before = await appClient!`select (select count(*) from manuscripts where project_id=${project.id}) as manuscripts, (select count(*) from projects where id=${project.id}) as projects`;
    expect(await services.getDefaultManuscript(project.id)).toBeNull();
    const afterRead = await appClient!`select count(*) as manuscripts from manuscripts where project_id=${project.id}`;
    expect(Number(afterRead[0].manuscripts)).toBe(0);
    const overview = await services.getProjectOverview(project.id);
    const after = await appClient!`select (select count(*) from manuscripts where project_id=${project.id}) as manuscripts, (select count(*) from projects where id=${project.id}) as projects`;

    expect(overview.papers.canonicalPaperCount).toBe(1);
    expect(overview.screening.finallyIncludedPaperCount).toBe(1);
    expect(overview.extraction.requiredFieldCount).toBe(1);
    expect(overview.extraction.missingRequiredExtractionPaperCount).toBe(1);
    expect(after).toEqual(before);
  });

  it("preserves unresolved duplicate pair sets across signals, history, and seeded random records", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: "Overview duplicate candidates" });
    const sources = await services.listSearchSources(project.id);
    const sourceA = sources[0];
    const sourceB = sources[1] ?? await services.createSearchSource(project.id, { sourceKey: "slice34-secondary", displayName: "Slice 34 secondary" });

    async function makeRunPair(source: typeof sourceA) {
      const strategy = await services.createSearchStrategy(project.id, {
        searchSourceId: source.id,
        name: `Slice 34 duplicate check ${randomUUID()}`,
        queryText: "deduplication equivalence",
      });
      async function makeRun() {
        return services.createSearchRun(project.id, {
          searchSourceId: source.id,
          sourceKeySnapshot: source.sourceKey,
          sourceDisplayNameSnapshot: source.displayName,
          strategyId: strategy.id,
          queryText: strategy.queryText,
          reportedResultCount: 20,
          executedAt: new Date(),
        });
      }
      return [await makeRun(), await makeRun()] as const;
    }

    const [sourceARun1, sourceARun2] = await makeRunPair(sourceA);
    const [sourceBRun1, sourceBRun2] = await makeRunPair(sourceB);
    const runFor = (source: typeof sourceA, side: 0 | 1) =>
      source.id === sourceA.id ? [sourceARun1, sourceARun2][side] : [sourceBRun1, sourceBRun2][side];
    type RecordOptions = { title: string; sourceRecordId?: string | null; doi?: string | null; publicationYear?: number | null };
    async function addRecord(source: typeof sourceA, side: 0 | 1, input: RecordOptions) {
      return services.createRetrievedRecord(project.id, {
        ...input,
        searchSourceId: source.id,
        searchRunId: runFor(source, side).id,
        retrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
    }

    const doiLeft = await addRecord(sourceA, 0, { title: "DOI signal left", sourceRecordId: "doi-left", doi: " 10.1234/slice34-doi ", publicationYear: 2019 });
    const doiRight = await addRecord(sourceA, 1, { title: "DOI signal right", sourceRecordId: "doi-right", doi: "https://doi.org/10.1234/slice34-doi", publicationYear: 2020 });
    const sourceLeft = await addRecord(sourceA, 0, { title: "Source signal left", sourceRecordId: "shared-source-key" });
    const sourceRight = await addRecord(sourceA, 1, { title: "Source signal right", sourceRecordId: "shared-source-key" });
    const titleLeft = await addRecord(sourceA, 0, { title: "  A   title-year   study ", sourceRecordId: "title-left", publicationYear: 2022 });
    const titleRight = await addRecord(sourceA, 1, { title: "a title-year study", sourceRecordId: "title-right", publicationYear: 2022 });
    const overlapLeft = await addRecord(sourceA, 0, { title: "Overlap study", sourceRecordId: "overlap-key", doi: "DOI: 10.1234/overlap", publicationYear: 2021 });
    const overlapRight = await addRecord(sourceA, 1, { title: " overlap   STUDY ", sourceRecordId: "overlap-key", doi: "https://dx.doi.org/10.1234/overlap", publicationYear: 2021 });

    const historyDoiLeft = await addRecord(sourceA, 0, { title: "History DOI left", sourceRecordId: "history-doi-left", doi: "10.1234/history-doi" });
    const historyDoiRight = await addRecord(sourceA, 1, { title: "History DOI right", sourceRecordId: "history-doi-right", doi: "10.1234/history-doi" });
    await services.decideDifferentWork(project.id, historyDoiLeft.id, historyDoiRight.id, "Reviewed as distinct works");

    const historySourceLeft = await addRecord(sourceA, 0, { title: "History source left", sourceRecordId: "history-source-key" });
    const historySourceRight = await addRecord(sourceA, 1, { title: "History source right", sourceRecordId: "history-source-key" });
    await services.confirmSameWork(project.id, historySourceLeft.id, historySourceRight.id, "Initial same-work review");
    await services.decideDifferentWork(project.id, historySourceLeft.id, historySourceRight.id, "Later correction to distinct works");
    expect(await services.listDeduplicationHistory(project.id, historySourceLeft.id, historySourceRight.id)).toHaveLength(2);

    const differentYearLeft = await addRecord(sourceA, 0, { title: "Same title different year", sourceRecordId: "different-year-left", publicationYear: 2020 });
    const differentYearRight = await addRecord(sourceA, 1, { title: " same   title DIFFERENT year ", sourceRecordId: "different-year-right", publicationYear: 2021 });
    const differentSourceLeft = await addRecord(sourceA, 0, { title: "Different source left", sourceRecordId: "cross-source-key" });
    const differentSourceRight = await addRecord(sourceB, 0, { title: "Different source right", sourceRecordId: "cross-source-key" });
    const nullLeft = await addRecord(sourceA, 0, { title: "Null signal left", sourceRecordId: null, doi: null, publicationYear: null });
    const nullRight = await addRecord(sourceA, 1, { title: "Null signal right", sourceRecordId: null, doi: null, publicationYear: null });

    const blankDoiLeftId = randomUUID();
    const blankDoiRightId = randomUUID();
    await appClient!`
      insert into retrieved_records (id, project_id, search_run_id, search_source_id, source_record_id, title, doi, publication_year, retrieved_at)
      values
        (${blankDoiLeftId}, ${project.id}, ${sourceARun1.id}, ${sourceA.id}, null, 'Blank DOI left', '   ', null, '2026-01-01T00:00:00.000Z'),
        (${blankDoiRightId}, ${project.id}, ${sourceARun2.id}, ${sourceA.id}, null, 'Blank DOI right', '', null, '2026-01-01T00:00:00.000Z')
    `;

    let randomState = 0x3434;
    const nextRandom = () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return (randomState >>> 0) / 0x1_0000_0000;
    };
    const randomPick = <T,>(values: readonly T[]) => values[Math.floor(nextRandom() * values.length)];
    const doiPool = [null, null, "10.1234/random-a", "https://doi.org/10.1234/random-a", "10.1234/random-b", "10.1234/random-c"] as const;
    const titlePool = ["Random Alpha", "  random   ALPHA ", "Random Beta", "Random Gamma", "Random Delta"] as const;
    const yearPool = [null, 2020, 2021, 2022] as const;
    for (let pairIndex = 0; pairIndex < 20; pairIndex += 1) {
      const sharedSourceKey = nextRandom() < 0.35;
      const firstSource = randomPick([sourceA, sourceB] as const);
      const secondSource = randomPick([sourceA, sourceB] as const);
      const doiValues = [randomPick(doiPool), randomPick(doiPool)] as const;
      const titles = [randomPick(titlePool), randomPick(titlePool)] as const;
      const years = [randomPick(yearPool), randomPick(yearPool)] as const;
      const sourceKey = `random-source-${pairIndex}`;
      await addRecord(firstSource, 0, {
        title: titles[0],
        sourceRecordId: sharedSourceKey ? sourceKey : `random-source-${pairIndex}-left`,
        doi: doiValues[0],
        publicationYear: years[0],
      });
      await addRecord(secondSource, 1, {
        title: titles[1],
        sourceRecordId: sharedSourceKey ? sourceKey : `random-source-${pairIndex}-right`,
        doi: doiValues[1],
        publicationYear: years[1],
      });
    }

    const legacyRows = await appDb!.execute(sql`
      with current_decisions as (
        select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
          project_id, left_retrieved_record_id, right_retrieved_record_id, decision
        from retrieved_record_deduplication_decisions
        where project_id = ${project.id}
        order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc
      ), candidate_pairs as (
        select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
        from retrieved_records a
        join retrieved_records b on b.project_id = a.project_id and a.id < b.id
        left join current_decisions d
          on d.project_id = a.project_id
          and d.left_retrieved_record_id = a.id
          and d.right_retrieved_record_id = b.id
        where a.project_id = ${project.id}
          and d.decision is null
          and (
            (a.doi is not null and b.doi is not null and btrim(a.doi) <> '' and btrim(b.doi) <> ''
              and btrim(lower(regexp_replace(regexp_replace(btrim(a.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))
                = btrim(lower(regexp_replace(regexp_replace(btrim(b.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))))
            or (a.source_record_id is not null and b.source_record_id is not null
              and btrim(a.source_record_id) <> '' and btrim(b.source_record_id) <> ''
              and a.search_source_id = b.search_source_id and a.source_record_id = b.source_record_id)
            or (a.publication_year is not null and a.publication_year = b.publication_year
              and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g'))
                = lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g')))
          )
      )
      select left_retrieved_record_id, right_retrieved_record_id
      from candidate_pairs
      order by left_retrieved_record_id, right_retrieved_record_id
    `) as unknown as Array<Record<string, unknown>>;
    const newRows = await appDb!.execute(sql`
      with ${unresolvedDuplicatePairCtes(project.id)}
      select left_retrieved_record_id, right_retrieved_record_id
      from unresolved_candidate_pairs
      order by left_retrieved_record_id, right_retrieved_record_id
    `) as unknown as Array<Record<string, unknown>>;
    const pairKey = (left: string, right: string) => left < right ? `${left}:${right}` : `${right}:${left}`;
    const asPairSet = (rows: Array<Record<string, unknown>>) =>
      new Set(rows.map((row) => pairKey(String(row.left_retrieved_record_id), String(row.right_retrieved_record_id))));
    const legacyPairs = asPairSet(legacyRows);
    const newPairs = asPairSet(newRows);
    expect(newPairs).toEqual(legacyPairs);
    expect(newRows.length).toBe(newPairs.size);

    for (const pair of [[doiLeft, doiRight], [sourceLeft, sourceRight], [titleLeft, titleRight], [overlapLeft, overlapRight]] as const) {
      expect(newPairs.has(pairKey(pair[0].id, pair[1].id))).toBe(true);
    }
    for (const pair of [
      [historyDoiLeft, historyDoiRight], [historySourceLeft, historySourceRight],
      [differentYearLeft, differentYearRight], [differentSourceLeft, differentSourceRight],
      [nullLeft, nullRight],
    ] as const) {
      expect(newPairs.has(pairKey(pair[0].id, pair[1].id))).toBe(false);
    }
    expect(newPairs.has(pairKey(blankDoiLeftId, blankDoiRightId))).toBe(false);

    const parityInputs = [" DOI: 10.1000/parity ", "https://doi.org/10.1000/parity", "https://dx.doi.org/10.1000/parity"];
    for (const input of parityInputs) {
      const rows = await appDb!.execute(sql`select ${retrievedRecordDoiComparison(sql`${input}`)} as normalized_doi`) as unknown as Array<Record<string, unknown>>;
      expect(rows[0].normalized_doi).toBe(normalizeDoiForComparison(input));
    }

    const indexRows = await appClient!`
      select c.relname as index_name,
        pg_get_expr(i.indexprs, i.indrelid) as index_expression,
        pg_get_expr(i.indpred, i.indrelid) as index_predicate,
        pg_get_indexdef(i.indexrelid) as index_definition
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname in (
        'retrieved_records_project_doi_comparison_idx',
        'retrieved_records_project_source_record_comparison_idx'
      )
    `;
    expect(indexRows).toHaveLength(2);
    const doiIndex = indexRows.find((row) => row.index_name === "retrieved_records_project_doi_comparison_idx")!;
    const sourceIndex = indexRows.find((row) => row.index_name === "retrieved_records_project_source_record_comparison_idx")!;
    const compactSql = (value: unknown) => String(value).replaceAll('"', "").replace(/::text/g, "").replace(/\s+/g, "").toLowerCase();
    const expectedDoiIndexExpression = new PgDialect().sqlToQuery(retrievedRecordDoiComparison(sql.raw("doi"))).sql;
    expect(compactSql(doiIndex.index_expression)).toBe(compactSql(expectedDoiIndexExpression));
    expect(compactSql(sourceIndex.index_definition)).toContain("(project_id,search_source_id,source_record_id)");
    expect(compactSql(sourceIndex.index_predicate)).toContain("source_record_idisnotnull");
    expect(compactSql(sourceIndex.index_predicate)).toContain("btrim(source_record_id)<>''");

    const executeSpy = vi.spyOn(appDb!, "execute");
    const overview = await services.getProjectOverview(project.id);
    expect(overview.screening.unresolvedDuplicatePairCount).toBe(newPairs.size);
    expect(executeSpy).toHaveBeenCalledTimes(3);
    executeSpy.mockRestore();
  });
});
