/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { researchQuestions, screeningCriteria } from "@/db/schema";
import type { ReviewReportContributorSelector, ReviewReportContext, ReviewReportContributorResult, ReviewReportRun, ReviewReportSource } from "@/domain/review-report";
import { DeduplicationDecisionRepository } from "./deduplication-repositories";

function stringValue(value: unknown): string { return String(value ?? ""); }
function numberValue(value: unknown): number { return Number(value ?? 0); }

export class ReviewReportingRepository {
  private readonly deduplicationRepository: DeduplicationDecisionRepository;

  constructor(private readonly db: Database) {
    this.deduplicationRepository = new DeduplicationDecisionRepository(db);
  }

  async context(projectId: string): Promise<ReviewReportContext> {
    const [projectRows, questions, criteria, sources, runs, overlapRows] = await Promise.all([
      this.db.execute(sql`select id, title from projects where id = ${projectId}`),
      this.db.select().from(researchQuestions).where(and(eq(researchQuestions.projectId, projectId), sql`${researchQuestions.archivedAt} is null`)).orderBy(asc(researchQuestions.sortOrder), asc(researchQuestions.id)),
      this.db.select().from(screeningCriteria).where(eq(screeningCriteria.projectId, projectId)).orderBy(asc(screeningCriteria.sortOrder), asc(screeningCriteria.id)),
      this.sourceAggregates(projectId),
      this.runs(projectId),
      this.db.execute(sql`
        with latest_matches as (
          select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
          from retrieved_record_matches where project_id = ${projectId}
          order by project_id, retrieved_record_id, sequence desc
        ), paper_sources as (
          select lm.paper_id, count(distinct rr.search_source_id)::int as source_count
          from latest_matches lm join retrieved_records rr on rr.project_id = lm.project_id and rr.id = lm.retrieved_record_id
          where lm.action = 'linked' group by lm.paper_id
        ) select count(*)::int as overlap_count from paper_sources where source_count > 1
      `),
    ]);
    const project = (projectRows as unknown as Array<Record<string, unknown>>)[0];
    return {
      project: { id: stringValue(project?.id), title: stringValue(project?.title) },
      activeResearchQuestions: questions.map((row) => this.mapQuestion(row)),
      activeCriteria: criteria.filter((row) => !row.archivedAt).map((row) => this.mapCriterion(row)),
      sources,
      runs,
      overlappingPaperCount: numberValue((overlapRows as unknown as Array<Record<string, unknown>>)[0]?.overlap_count),
    };
  }

  private mapQuestion(row: any) {
    return { id: stringValue(row.id), projectId: stringValue(row.projectId ?? row.project_id), identifier: stringValue(row.identifier), label: stringValue(row.label), sortOrder: numberValue(row.sortOrder ?? row.sort_order), createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at, archivedAt: row.archivedAt ?? row.archived_at ?? null };
  }

  private mapCriterion(row: any) {
    return { id: stringValue(row.id), projectId: stringValue(row.projectId ?? row.project_id), type: row.type as "inclusion" | "exclusion", text: stringValue(row.text), sortOrder: numberValue(row.sortOrder ?? row.sort_order), createdAt: row.createdAt ?? row.created_at, archivedAt: row.archivedAt ?? row.archived_at ?? null };
  }

  async sourceAggregates(projectId: string): Promise<ReviewReportSource[]> {
    const [sourceRows, runRows] = await Promise.all([
      this.db.execute(sql`
        with latest_matches as (
          select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
          from retrieved_record_matches where project_id = ${projectId}
          order by project_id, retrieved_record_id, sequence desc
        ), run_aggregates as (
          select search_source_id,
            count(*)::int as run_count,
            coalesce(sum(reported_result_count), 0)::int as reported_results
          from search_runs
          where project_id = ${projectId}
          group by search_source_id
        ), record_aggregates as (
          select sr.search_source_id,
            count(distinct rr.id)::int as retrieved_records,
            count(distinct case when lm.action = 'linked' then rr.id end)::int as currently_resolved_records,
            count(distinct case when lm.action = 'linked' then lm.paper_id end)::int as acquisition_derived_papers
          from search_runs sr
          left join retrieved_records rr on rr.project_id = sr.project_id and rr.search_run_id = sr.id and rr.search_source_id = sr.search_source_id
          left join latest_matches lm on lm.project_id = rr.project_id and lm.retrieved_record_id = rr.id
          where sr.project_id = ${projectId}
          group by sr.search_source_id
        )
        select s.id, s.project_id, s.source_key, s.display_name, s.base_url, s.notes, s.created_at, s.updated_at, s.archived_at,
          ra.run_count, ra.reported_results,
          coalesce(da.retrieved_records, 0)::int as retrieved_records,
          coalesce(da.currently_resolved_records, 0)::int as currently_resolved_records,
          coalesce(da.acquisition_derived_papers, 0)::int as acquisition_derived_papers
        from search_sources s
        join run_aggregates ra on ra.search_source_id = s.id
        left join record_aggregates da on da.search_source_id = s.id
        where s.project_id = ${projectId}
        order by s.source_key, s.id
      `),
      this.db.execute(sql`select search_source_id, source_key_snapshot, source_display_name_snapshot from search_runs where project_id = ${projectId} order by sequence, id`),
    ]);
    const snapshots = new Map<string, Array<{ sourceKey: string; displayName: string }>>();
    for (const row of runRows as unknown as Array<Record<string, unknown>>) {
      const id = stringValue(row.search_source_id);
      const value = { sourceKey: stringValue(row.source_key_snapshot), displayName: stringValue(row.source_display_name_snapshot) };
      const list = snapshots.get(id) ?? [];
      if (!list.some((item) => item.sourceKey === value.sourceKey && item.displayName === value.displayName)) list.push(value);
      snapshots.set(id, list);
    }
    return (sourceRows as unknown as Array<Record<string, unknown>>).map((row) => ({
      source: { id: stringValue(row.id), projectId: stringValue(row.project_id), sourceKey: stringValue(row.source_key), displayName: stringValue(row.display_name), baseUrl: row.base_url == null ? null : stringValue(row.base_url), notes: row.notes == null ? null : stringValue(row.notes), createdAt: row.created_at as Date, updatedAt: row.updated_at as Date, archivedAt: row.archived_at as Date | null },
      observedSnapshots: snapshots.get(stringValue(row.id)) ?? [],
      runCount: numberValue(row.run_count), reportedResults: numberValue(row.reported_results), retrievedRecords: numberValue(row.retrieved_records), currentlyResolvedRecords: numberValue(row.currently_resolved_records), acquisitionDerivedPapers: numberValue(row.acquisition_derived_papers),
    }));
  }

  async runs(projectId: string): Promise<ReviewReportRun[]> {
    const rows = await this.db.execute(sql`
      select sr.id, sr.sequence, sr.project_id, sr.search_source_id, sr.source_key_snapshot, sr.source_display_name_snapshot,
        sr.strategy_id, sr.query_text, sr.filters_text_snapshot, sr.reported_result_count, sr.executed_at, sr.notes, sr.created_at,
        count(rr.id)::int as entered_record_count
      from search_runs sr left join retrieved_records rr on rr.project_id = sr.project_id and rr.search_run_id = sr.id
      where sr.project_id = ${projectId}
      group by sr.id order by sr.sequence, sr.id
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: stringValue(row.id), sequence: numberValue(row.sequence), projectId: stringValue(row.project_id), searchSourceId: stringValue(row.search_source_id), sourceKeySnapshot: stringValue(row.source_key_snapshot), sourceDisplayNameSnapshot: stringValue(row.source_display_name_snapshot), strategyId: stringValue(row.strategy_id), queryText: stringValue(row.query_text), filtersTextSnapshot: row.filters_text_snapshot == null ? null : stringValue(row.filters_text_snapshot), reportedResultCount: numberValue(row.reported_result_count), executedAt: row.executed_at as Date, notes: row.notes == null ? null : stringValue(row.notes), createdAt: row.created_at as Date, enteredRecordCount: numberValue(row.entered_record_count),
    }));
  }

  async exclusionReasons(projectId: string) {
    const rows = await this.db.execute(sql`
      with current_screening as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision, exclusion_criterion_id
        from screening_decisions where project_id = ${projectId} and stage = 'title_abstract'
        order by project_id, paper_id, sequence desc
      )
      select s.exclusion_criterion_id, c.text, c.archived_at, count(*)::int as count
      from current_screening s join screening_criteria c on c.project_id = s.project_id and c.id = s.exclusion_criterion_id and c.type = 'exclusion'
      where s.project_id = ${projectId} and s.decision = 'exclude' and s.exclusion_criterion_id is not null
      group by s.exclusion_criterion_id, c.text, c.archived_at order by c.text, s.exclusion_criterion_id
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({ criterionId: stringValue(row.exclusion_criterion_id), text: stringValue(row.text), archived: row.archived_at != null, count: numberValue(row.count) }));
  }

  async contributors(projectId: string, selector: ReviewReportContributorSelector): Promise<ReviewReportContributorResult> {
    if (selector.scope === "source") return this.sourceContributors(projectId, selector.sourceId, selector.metric);
    if (selector.scope === "exclusionReason") return this.exclusionContributors(projectId, selector.criterionId);
    if (selector.scope === "overlap") return this.overlapContributors(projectId);
    const metric = selector.metric;
    if (metric === "unresolvedDuplicatePairs") {
      const rows = await this.deduplicationRepository.listCandidates(projectId, false);
      const items = (rows as any[]).map((row) => ({ kind: "deduplicationPair" as const, id: `${row.left_record_id}:${row.right_record_id}`, label: `${row.left_title} ↔ ${row.right_title}`, contribution: 1, leftRecordId: String(row.left_record_id), rightRecordId: String(row.right_record_id) }));
      return { total: items.length, items };
    }
    const rows = await this.db.execute(this.metricSql(projectId, metric));
    const mapped = (rows as unknown as Array<Record<string, unknown>>).map((row) => this.mapMetricContributor(metric, row));
    return { total: mapped.reduce((sum, item) => sum + item.contribution, 0), items: mapped };
  }

  private metricSql(projectId: string, metric: string) {
    const latestMatches = sql`with latest_matches as (select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action from retrieved_record_matches where project_id = ${projectId} order by project_id, retrieved_record_id, sequence desc)`;
    const latestScreening = sql`with current_screening as (select distinct on (project_id, paper_id) project_id, paper_id, id, decision, exclusion_criterion_id from screening_decisions where project_id = ${projectId} and stage = 'title_abstract' order by project_id, paper_id, sequence desc)`;
    switch (metric) {
      case "distinctSearchRuns": case "reportedResultsTotal": return sql`select id, search_source_id, source_display_name_snapshot, sequence, reported_result_count, source_key_snapshot from search_runs where project_id = ${projectId} order by sequence, id`;
      case "retrievedRecords": return sql`select rr.id, rr.search_run_id, rr.search_source_id, rr.title from retrieved_records rr where rr.project_id = ${projectId} order by rr.id`;
      case "distinctSources": return sql`select distinct s.id, s.display_name from search_sources s join search_runs r on r.project_id = s.project_id and r.search_source_id = s.id where s.project_id = ${projectId} order by s.id`;
      case "currentlyResolvedRecords": return sql`${latestMatches} select rr.id, rr.search_run_id, rr.search_source_id, rr.title from retrieved_records rr join latest_matches lm on lm.project_id=rr.project_id and lm.retrieved_record_id=rr.id and lm.action='linked' where rr.project_id=${projectId} order by rr.id`;
      case "unresolvedRecords": return sql`${latestMatches} select rr.id, rr.search_run_id, rr.search_source_id, rr.title from retrieved_records rr left join latest_matches lm on lm.project_id=rr.project_id and lm.retrieved_record_id=rr.id and lm.action='linked' where rr.project_id=${projectId} and lm.retrieved_record_id is null order by rr.id`;
      case "acquisitionDerivedPapers": return sql`${latestMatches} select p.id, p.title from papers p where p.project_id=${projectId} and exists (select 1 from latest_matches lm where lm.project_id=p.project_id and lm.paper_id=p.id and lm.action='linked') order by p.id`;
      case "duplicateRecordsCollapsed": return sql`${latestMatches} select p.id, p.title, count(*)::int as record_count from papers p join latest_matches lm on lm.project_id=p.project_id and lm.paper_id=p.id and lm.action='linked' where p.project_id=${projectId} group by p.id, p.title having count(*) > 1 order by p.id`;
      case "historicalAcquisitionOnlyPapers": return sql`${latestMatches} select p.id, p.title from papers p where p.project_id=${projectId} and exists (select 1 from retrieved_record_matches hm where hm.project_id=p.project_id and hm.paper_id=p.id and hm.action='linked') and not exists (select 1 from latest_matches lm where lm.project_id=p.project_id and lm.paper_id=p.id and lm.action='linked') order by p.id`;
      case "manualPapers": return sql`select p.id, p.title from papers p where p.project_id=${projectId} and not exists (select 1 from retrieved_record_matches hm where hm.project_id=p.project_id and hm.paper_id=p.id and hm.action='linked') order by p.id`;
      case "sameWorkDecisionPairs": case "differentWorkDecisionPairs": return sql`with latest_decisions as (select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id) left_retrieved_record_id, right_retrieved_record_id, decision from retrieved_record_deduplication_decisions where project_id=${projectId} order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc) select left_retrieved_record_id, right_retrieved_record_id, decision from latest_decisions where decision=${metric === "sameWorkDecisionPairs" ? "same_work" : "different_work"} order by left_retrieved_record_id, right_retrieved_record_id`;
      case "papersInScreeningPopulation": return sql`select id, title from papers where project_id=${projectId} order by id`;
      case "unscreened": return sql`${latestScreening} select p.id, p.title from papers p left join current_screening s on s.project_id=p.project_id and s.paper_id=p.id where p.project_id=${projectId} and s.paper_id is null order by p.id`;
      case "included": case "excluded": case "maybe": return sql`${latestScreening} select p.id, p.title, s.id as decision_id, s.decision from papers p join current_screening s on s.project_id=p.project_id and s.paper_id=p.id where p.project_id=${projectId} and s.decision=${metric === "included" ? "include" : metric} order by p.id`;
      default: return sql`select id, title from papers where project_id=${projectId} order by id`;
    }
  }

  private mapMetricContributor(metric: string, row: Record<string, unknown>): any {
    if (metric === "distinctSources") return { kind: "searchSource", id: stringValue(row.id), label: stringValue(row.display_name), contribution: 1 };
    if (metric === "distinctSearchRuns" || metric === "reportedResultsTotal") return { kind: "searchRun", id: stringValue(row.id), label: `${stringValue(row.source_display_name_snapshot)} · Run ${numberValue(row.sequence)}`, contribution: metric === "reportedResultsTotal" ? numberValue(row.reported_result_count) : 1, sourceId: stringValue(row.search_source_id) };
    if (metric === "retrievedRecords" || metric === "currentlyResolvedRecords" || metric === "unresolvedRecords") return { kind: "retrievedRecord", id: stringValue(row.id), label: stringValue(row.title), contribution: 1, searchRunId: stringValue(row.search_run_id), sourceId: stringValue(row.search_source_id) };
    if (metric === "duplicateRecordsCollapsed") return { kind: "paper", id: stringValue(row.id), label: stringValue(row.title), contribution: numberValue(row.record_count) - 1, recordCount: numberValue(row.record_count) };
    if (metric === "sameWorkDecisionPairs" || metric === "differentWorkDecisionPairs") return { kind: "deduplicationPair", id: `${stringValue(row.left_retrieved_record_id)}:${stringValue(row.right_retrieved_record_id)}`, label: `${stringValue(row.left_retrieved_record_id)} ↔ ${stringValue(row.right_retrieved_record_id)}`, contribution: row.decision === (metric === "sameWorkDecisionPairs" ? "same_work" : "different_work") ? 1 : 0, leftRecordId: stringValue(row.left_retrieved_record_id), rightRecordId: stringValue(row.right_retrieved_record_id) };
    if (metric === "included" || metric === "excluded" || metric === "maybe") return { kind: "screeningDecision", id: stringValue(row.decision_id), label: stringValue(row.title), contribution: 1, paperId: stringValue(row.id), decision: stringValue(row.decision) };
    return { kind: "paper", id: stringValue(row.id), label: stringValue(row.title), contribution: 1 };
  }

  private async sourceContributors(projectId: string, sourceId: string, metric: string): Promise<ReviewReportContributorResult> {
    const rows = await this.db.execute(sql`select sr.id, sr.sequence, sr.source_display_name_snapshot, sr.reported_result_count, count(rr.id)::int as entered_record_count from search_runs sr left join retrieved_records rr on rr.project_id=sr.project_id and rr.search_run_id=sr.id where sr.project_id=${projectId} and sr.search_source_id=${sourceId} group by sr.id order by sr.sequence, sr.id`);
    const raw = rows as unknown as Array<Record<string, unknown>>;
    if (metric === "runs" || metric === "reportedResults") return { total: raw.reduce((sum, row) => sum + (metric === "runs" ? 1 : numberValue(row.reported_result_count)), 0), items: raw.map((row) => ({ kind: "searchRun" as const, id: stringValue(row.id), label: `${stringValue(row.source_display_name_snapshot)} · Run ${numberValue(row.sequence)}`, contribution: metric === "runs" ? 1 : numberValue(row.reported_result_count), sourceId })) };
    if (metric === "retrievedRecords") {
      const records = await this.db.execute(sql`select id, search_run_id, title from retrieved_records where project_id=${projectId} and search_source_id=${sourceId} order by id`);
      return { total: (records as unknown[]).length, items: (records as unknown as Array<Record<string, unknown>>).map((row) => ({ kind: "retrievedRecord" as const, id: stringValue(row.id), label: stringValue(row.title), contribution: 1, searchRunId: stringValue(row.search_run_id), sourceId })) };
    }
    const latest = await this.db.execute(sql`with latest_matches as (select distinct on (project_id,retrieved_record_id) project_id,retrieved_record_id,paper_id,action from retrieved_record_matches where project_id=${projectId} order by project_id,retrieved_record_id,sequence desc) select rr.id, rr.search_run_id, rr.title, lm.paper_id from retrieved_records rr join latest_matches lm on lm.project_id=rr.project_id and lm.retrieved_record_id=rr.id and lm.action='linked' where rr.project_id=${projectId} and rr.search_source_id=${sourceId} order by rr.id`);
    if (metric === "resolvedRecords") {
      const items = (latest as unknown as Array<Record<string, unknown>>).map((row) => ({ kind: "retrievedRecord" as const, id: stringValue(row.id), label: stringValue(row.title), contribution: 1, searchRunId: stringValue(row.search_run_id), sourceId }));
      return { total: items.length, items };
    }
    const groups = new Map<string, { title: string; count: number }>();
    for (const row of latest as unknown as Array<Record<string, unknown>>) { const id = stringValue(row.paper_id); const current = groups.get(id) ?? { title: stringValue(row.title), count: 0 }; current.count += 1; groups.set(id, current); }
    const items = Array.from(groups, ([id, value]) => ({ kind: "paper" as const, id, label: value.title, contribution: 1 }));
    return { total: items.length, items };
  }

  private async exclusionContributors(projectId: string, criterionId: string): Promise<ReviewReportContributorResult> {
    const rows = await this.db.execute(sql`with current_screening as (select distinct on (project_id,paper_id) project_id,paper_id,id,decision,exclusion_criterion_id from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id,paper_id,sequence desc) select p.id,p.title,s.id as decision_id from papers p join current_screening s on s.project_id=p.project_id and s.paper_id=p.id where p.project_id=${projectId} and s.decision='exclude' and s.exclusion_criterion_id=${criterionId} order by p.id`);
    const items = (rows as unknown as Array<Record<string, unknown>>).map((row) => ({ kind: "screeningDecision" as const, id: stringValue(row.decision_id), label: stringValue(row.title), contribution: 1, paperId: stringValue(row.id), decision: "exclude" }));
    return { total: items.length, items };
  }

  private async overlapContributors(projectId: string): Promise<ReviewReportContributorResult> {
    const rows = await this.db.execute(sql`with latest_matches as (select distinct on (project_id,retrieved_record_id) project_id,retrieved_record_id,paper_id,action from retrieved_record_matches where project_id=${projectId} order by project_id,retrieved_record_id,sequence desc), overlap as (select lm.paper_id,array_agg(distinct rr.search_source_id) as source_ids from latest_matches lm join retrieved_records rr on rr.project_id=lm.project_id and rr.id=lm.retrieved_record_id where lm.action='linked' group by lm.paper_id having count(distinct rr.search_source_id)>1) select p.id,p.title,o.source_ids from overlap o join papers p on p.project_id=${projectId} and p.id=o.paper_id order by p.id`);
    const items = (rows as unknown as Array<Record<string, unknown>>).map((row) => ({ kind: "paper" as const, id: stringValue(row.id), label: stringValue(row.title), contribution: 1, sourceIds: (row.source_ids as string[]) ?? [] }));
    return { total: items.length, items };
  }
}
