import { sql } from "drizzle-orm";
import { unresolvedDuplicatePairCtes } from "./unresolved-duplicate-pair-query";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";

type Row = Record<string, unknown>;

const rowList = (value: unknown) => value as unknown as Row[];
const numberValue = (value: unknown) => Number(value ?? 0);
const nullableString = (value: unknown) => (value == null ? null : String(value));

export const PROJECT_CARD_PAGE_SIZE = 24;

export type ProjectCard = {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  researchQuestionCount: number;
  firstResearchQuestion: string | null;
  paperCount: number;
  unscreenedPaperCount: number;
};

export type ProjectCardPage = {
  projects: ProjectCard[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

export type ProjectOverviewFacts = {
  project: { id: string; title: string; description: string | null };
  plan: {
    researchQuestionCount: number;
    searchStrategyCount: number;
    searchRunCount: number;
  };
  papers: { canonicalPaperCount: number; unscreenedPaperCount: number; maybePaperCount: number };
  screening: {
    unresolvedDuplicatePairCount: number;
    awaitingFullTextAssessmentCount: number;
    fullTextMaybeCount: number;
    fullTextConflictCount: number;
    finallyIncludedPaperCount: number;
    retrievalNotSoughtCount: number;
    retrievalPendingCount: number;
    retrievalUnavailableCount: number;
  };
  evidence: { evidenceCount: number; evidenceSetCount: number };
  extraction: {
    requiredFieldCount: number;
    missingRequiredExtractionPaperCount: number;
    aiSuggestionAwaitingReviewCount: number;
    activeAppraisalFrameworkCount: number;
    awaitingAppraisalPaperCount: number;
    completeCurrentAppraisalCount: number;
    nextAiSuggestionHref: string | null;
  };
  synthesis: {
    activePreparationCount: number;
    activeSynthesisStatementCount: number;
    finalizedAnswerCount: number;
    aiSuggestionAwaitingReviewCount: number;
    nextAiSuggestionHref: string | null;
    nextPreparationHref: string | null;
  };
  writing: {
    activeUnsupportedClaimCount: number;
    openEditorialThreadCount: number;
    snapshotCount: number;
    manuscriptCount: number;
  };
};

export type ProjectGuidanceAction = {
  key: string;
  label: string;
  href: string;
};

export type ProjectGuidanceFacts = {
  projectId?: string;
  researchQuestionCount: number;
  canonicalPaperCount: number;
  unresolvedDuplicatePairCount: number;
  unscreenedPaperCount: number;
  maybePaperCount: number;
  retrievalNotSoughtCount: number;
  retrievalPendingCount: number;
  retrievalUnavailableCount: number;
  awaitingFullTextAssessmentCount: number;
  fullTextMaybeCount: number;
  fullTextConflictCount: number;
  finallyIncludedPaperCount: number;
  requiredFieldCount: number;
  aiExtractionSuggestionCount: number;
  missingRequiredExtractionPaperCount: number;
  activeAppraisalFrameworkCount?: number;
  awaitingAppraisalPaperCount?: number;
  evidenceCount: number;
  evidenceSetCount: number;
  aiSynthesisSuggestionCount: number;
  activePreparationCount: number;
  activeUnsupportedClaimCount: number;
  openEditorialThreadCount: number;
  manuscriptWorkExists: boolean;
  nextAiExtractionHref?: string | null;
  nextAiSynthesisHref?: string | null;
  nextPreparationHref?: string | null;
};

function href(projectId: string | undefined, suffix: string) {
  return projectId ? `/projects/${projectId}${suffix}` : suffix || "/";
}

/**
 * Presentation-only guidance. It deliberately returns no completion state and
 * never writes canonical research data.
 */
export function deriveProjectGuidance(facts: ProjectGuidanceFacts): ProjectGuidanceAction[] {
  const actions: ProjectGuidanceAction[] = [];
  const add = (key: string, label: string, suffix: string, directHref?: string | null) => {
    actions.push({ key, label, href: directHref ?? href(facts.projectId, suffix) });
  };

  if (facts.researchQuestionCount === 0) add("research-question", "Define a research question", "/research-questions");
  if (facts.canonicalPaperCount === 0) add("papers", "Add or import Papers", "/papers");
  if (facts.unresolvedDuplicatePairCount > 0) add("duplicates", "Review possible duplicates", "/deduplication");
  if (facts.unscreenedPaperCount > 0 || facts.maybePaperCount > 0) add("title-abstract-screening", "Continue title/abstract screening", "/screening");
  if (facts.retrievalNotSoughtCount + facts.retrievalPendingCount + facts.retrievalUnavailableCount > 0) {
    add("full-text-retrieval", "Continue full-text retrieval", "/screening/full-text/retrieval");
  }
  if (facts.awaitingFullTextAssessmentCount + facts.fullTextMaybeCount + facts.fullTextConflictCount > 0) {
    add("full-text-screening", "Continue full-text screening", "/screening/full-text");
  }
  if (facts.finallyIncludedPaperCount > 0 && facts.requiredFieldCount === 0) {
    add("extraction-protocol", "Define the extraction protocol", "/extraction");
  }
  if (facts.aiExtractionSuggestionCount > 0) {
    add("ai-extraction", "Review the next AI extraction suggestion", "/extraction", facts.nextAiExtractionHref);
  }
  if (facts.missingRequiredExtractionPaperCount > 0) add("extraction", "Continue extraction", "/extraction");
  if ((facts.activeAppraisalFrameworkCount ?? 0) > 0 && (facts.awaitingAppraisalPaperCount ?? 0) > 0) {
    add("critical-appraisal", "Appraise included Papers", "/appraisal");
  } else if (facts.finallyIncludedPaperCount > 0 && (facts.activeAppraisalFrameworkCount ?? 0) === 0) {
    add("critical-appraisal-setup", "Set up critical appraisal", "/appraisal/frameworks/new");
  }
  if (facts.evidenceCount > 0 && facts.evidenceSetCount === 0) add("evidence-set", "Create an Evidence Set", "/evidence-sets");
  if (facts.aiSynthesisSuggestionCount > 0) {
    add("ai-synthesis", "Review the next AI synthesis suggestion", "/synthesis", facts.nextAiSynthesisHref);
  }
  if (facts.activePreparationCount > 0) add("synthesis-preparation", "Continue synthesis preparation", "/synthesis", facts.nextPreparationHref);
  if (facts.activeUnsupportedClaimCount > 0) add("claims", "Strengthen Claims", "/claims");
  if (facts.openEditorialThreadCount > 0) add("manuscript-review", "Continue manuscript review", "/manuscript/review");
  if (facts.manuscriptWorkExists) add("writing", "Continue writing", "/manuscript");

  return actions;
}

function mapProjectCard(row: Row): ProjectCard {
  return {
    id: String(row.id),
    title: String(row.title),
    description: nullableString(row.description),
    createdAt: row.created_at as Date,
    researchQuestionCount: numberValue(row.research_question_count),
    firstResearchQuestion: nullableString(row.first_research_question),
    paperCount: numberValue(row.paper_count),
    unscreenedPaperCount: numberValue(row.unscreened_paper_count),
  };
}

function mapOverviewFacts(
  projectRow: Row,
  extractionRow: Row,
  synthesisRow: Row,
): ProjectOverviewFacts {
  const projectId = String(projectRow.id);
  return {
    project: { id: projectId, title: String(projectRow.title), description: nullableString(projectRow.description) },
    plan: {
      researchQuestionCount: numberValue(projectRow.research_question_count),
      searchStrategyCount: numberValue(projectRow.search_strategy_count),
      searchRunCount: numberValue(projectRow.search_run_count),
    },
    papers: {
      canonicalPaperCount: numberValue(projectRow.paper_count),
      unscreenedPaperCount: numberValue(projectRow.unscreened_paper_count),
      maybePaperCount: numberValue(projectRow.maybe_paper_count),
    },
    screening: {
      unresolvedDuplicatePairCount: numberValue(projectRow.unresolved_duplicate_pair_count),
      awaitingFullTextAssessmentCount: numberValue(projectRow.awaiting_full_text_count),
      fullTextMaybeCount: numberValue(projectRow.full_text_maybe_count),
      fullTextConflictCount: numberValue(projectRow.full_text_conflict_count),
      finallyIncludedPaperCount: numberValue(projectRow.finally_included_count),
      retrievalNotSoughtCount: numberValue(projectRow.full_text_not_sought_count),
      retrievalPendingCount: numberValue(projectRow.full_text_pending_count),
      retrievalUnavailableCount: numberValue(projectRow.full_text_unavailable_count),
    },
    evidence: {
      evidenceCount: numberValue(projectRow.evidence_count),
      evidenceSetCount: numberValue(projectRow.evidence_set_count),
    },
    extraction: {
      requiredFieldCount: numberValue(extractionRow.required_field_count),
      missingRequiredExtractionPaperCount: numberValue(extractionRow.missing_required_paper_count),
      aiSuggestionAwaitingReviewCount: numberValue(extractionRow.ai_suggestion_count),
      activeAppraisalFrameworkCount: numberValue(extractionRow.active_appraisal_framework_count),
      awaitingAppraisalPaperCount: numberValue(extractionRow.awaiting_appraisal_paper_count),
      completeCurrentAppraisalCount: numberValue(extractionRow.complete_current_appraisal_count),
      nextAiSuggestionHref: extractionRow.next_ai_paper_id && extractionRow.next_ai_request_id
        ? `/projects/${projectId}/extraction/${String(extractionRow.next_ai_paper_id)}/suggestions/${String(extractionRow.next_ai_request_id)}`
        : null,
    },
    synthesis: {
      activePreparationCount: numberValue(synthesisRow.active_preparation_count),
      activeSynthesisStatementCount: numberValue(synthesisRow.active_synthesis_count),
      finalizedAnswerCount: numberValue(synthesisRow.finalized_answer_count),
      aiSuggestionAwaitingReviewCount: numberValue(synthesisRow.ai_suggestion_count),
      nextAiSuggestionHref: synthesisRow.next_ai_request_id
        ? `/projects/${projectId}/synthesis/preparations/${String(synthesisRow.next_ai_preparation_id)}`
        : null,
      nextPreparationHref: synthesisRow.next_preparation_id
        ? `/projects/${projectId}/synthesis/preparations/${String(synthesisRow.next_preparation_id)}`
        : null,
    },
    writing: {
      activeUnsupportedClaimCount: numberValue(synthesisRow.unsupported_claim_count),
      openEditorialThreadCount: numberValue(synthesisRow.open_thread_count),
      snapshotCount: numberValue(synthesisRow.snapshot_count),
      manuscriptCount: numberValue(synthesisRow.manuscript_count),
    },
  };
}

export function createProjectWorkspaceReadServices(db: Database) {
  async function listProjectCards(input: { page?: number; pageSize?: number } = {}): Promise<ProjectCardPage> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? PROJECT_CARD_PAGE_SIZE;
    if (!Number.isInteger(page) || page < 1) throw new DomainError("VALIDATION_ERROR", "Project page must be a positive integer");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PROJECT_CARD_PAGE_SIZE) throw new DomainError("VALIDATION_ERROR", "Project page size is out of bounds");
    const offset = (page - 1) * pageSize;
    const rows = rowList(await db.execute(sql`
      select
        p.id,
        p.title,
        p.description,
        p.created_at,
        (select count(*)::int from projects) as total_count,
        (select count(*)::int from research_questions rq where rq.project_id=p.id and rq.archived_at is null) as research_question_count,
        (select rq.label from research_questions rq where rq.project_id=p.id and rq.archived_at is null order by rq.sort_order asc, rq.created_at asc, rq.id asc limit 1) as first_research_question,
        (select count(*)::int from papers paper where paper.project_id=p.id) as paper_count,
        (select count(*)::int from papers paper where paper.project_id=p.id and not exists (select 1 from screening_decisions sd where sd.project_id=paper.project_id and sd.paper_id=paper.id and sd.stage='title_abstract')) as unscreened_paper_count
      from projects p
      order by p.created_at desc, p.id desc
      limit ${pageSize} offset ${offset}
    `));
    const totalCount = rows.length
      ? numberValue(rows[0].total_count)
      : numberValue(rowList(await db.execute(sql`select count(*)::int as total_count from projects`))[0]?.total_count);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    return {
      projects: rows.map(mapProjectCard),
      page,
      pageSize,
      totalCount,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    };
  }

  async function getProjectOverview(projectId: string): Promise<ProjectOverviewFacts> {
    const baseRows = rowList(await db.execute(sql`
      with current_screening as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from screening_decisions where project_id=${projectId} and stage='title_abstract'
        order by project_id, paper_id, sequence desc
      ), current_full_text as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions where project_id=${projectId}
        order by project_id, paper_id, sequence desc
      ), current_retrieval as (
        select distinct on (project_id, paper_id) project_id, paper_id, outcome
        from full_text_retrieval_attempts where project_id=${projectId}
        order by project_id, paper_id, sequence desc
        ), ${unresolvedDuplicatePairCtes(projectId)}
      select p.id, p.title, p.description,
        (select count(*)::int from research_questions rq where rq.project_id=p.id and rq.archived_at is null) as research_question_count,
        (select count(*)::int from search_strategies ss where ss.project_id=p.id and ss.archived_at is null) as search_strategy_count,
        (select count(*)::int from search_runs sr where sr.project_id=p.id) as search_run_count,
        (select count(*)::int from papers paper where paper.project_id=p.id) as paper_count,
        (select count(*)::int from papers paper where paper.project_id=p.id and not exists (select 1 from current_screening s where s.project_id=paper.project_id and s.paper_id=paper.id)) as unscreened_paper_count,
        (select count(*)::int from current_screening s where s.project_id=p.id and s.decision='maybe') as maybe_paper_count,
        (select count(*)::int from unresolved_candidate_pairs) as unresolved_duplicate_pair_count,
        (select count(*)::int from current_screening s where s.project_id=p.id and s.decision='include' and not exists (select 1 from current_full_text f where f.project_id=s.project_id and f.paper_id=s.paper_id)) as awaiting_full_text_count,
        (select count(*)::int from current_screening s join current_full_text f on f.project_id=s.project_id and f.paper_id=s.paper_id where s.project_id=p.id and s.decision='include' and f.decision='maybe') as full_text_maybe_count,
        (select count(*)::int from current_full_text f left join current_screening s on s.project_id=f.project_id and s.paper_id=f.paper_id where f.project_id=p.id and coalesce(s.decision,'') <> 'include') as full_text_conflict_count,
        (select count(*)::int from current_screening s join current_full_text f on f.project_id=s.project_id and f.paper_id=s.paper_id where s.project_id=p.id and s.decision='include' and f.decision='include') as finally_included_count,
        (select count(*)::int from current_screening s where s.project_id=p.id and s.decision='include' and not exists (select 1 from current_retrieval r where r.project_id=s.project_id and r.paper_id=s.paper_id)) as full_text_not_sought_count,
        (select count(*)::int from current_screening s join current_retrieval r on r.project_id=s.project_id and r.paper_id=s.paper_id where s.project_id=p.id and s.decision='include' and r.outcome='pending') as full_text_pending_count,
        (select count(*)::int from current_screening s join current_retrieval r on r.project_id=s.project_id and r.paper_id=s.paper_id where s.project_id=p.id and s.decision='include' and r.outcome='unavailable') as full_text_unavailable_count
        ,(select count(*)::int from evidence e where e.project_id=p.id) as evidence_count
        ,(select count(*)::int from evidence_sets es where es.project_id=p.id and es.archived_at is null) as evidence_set_count
      from projects p where p.id=${projectId} limit 1
    `));
    const projectRow = baseRows[0];
    if (!projectRow) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");

    const extractionRows = rowList(await db.execute(sql`
      with finally_included as (
        select s.paper_id
        from (select distinct on (project_id, paper_id) project_id, paper_id, decision from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id, paper_id, sequence desc) s
        join (select distinct on (project_id, paper_id) project_id, paper_id, decision from full_text_screening_decisions where project_id=${projectId} order by project_id, paper_id, sequence desc) f on f.project_id=s.project_id and f.paper_id=s.paper_id
        where s.decision='include' and f.decision='include'
      ), required_fields as (
        select id from extraction_fields where project_id=${projectId} and required=true and archived_at is null
      ), missing_papers as (
        select fi.paper_id
        from finally_included fi
        where exists (select 1 from required_fields rf where not exists (
          select 1 from extraction_values ev
          join lateral (select r.value_state from extraction_value_revisions r where r.project_id=ev.project_id and r.extraction_value_id=ev.id and r.finalized_at is not null order by r.sequence desc limit 1) current_revision on true
          where ev.project_id=${projectId} and ev.paper_id=fi.paper_id and ev.field_id=rf.id and current_revision.value_state in ('present','not_reported','not_applicable')
        ))
      ), ai_candidates as (
        select r.request_id, ar.paper_id
        from ai_extraction_results r join ai_extraction_requests ar on ar.project_id=r.project_id and ar.id=r.request_id
        where r.project_id=${projectId} and r.outcome='succeeded' and r.candidate_state='present'
          and not exists (select 1 from ai_extraction_decisions d where d.project_id=r.project_id and d.request_id=r.request_id)
        order by r.created_at asc, r.id asc
      ), latest_framework_versions as (
        select distinct on (project_id, framework_id) project_id, framework_id, id, overall_judgement_required
        from appraisal_framework_versions
        where project_id=${projectId} and finalized_at is not null
        order by project_id, framework_id, version_number desc
      ), active_appraisal_frameworks as (
        select f.id as framework_id
        from appraisal_frameworks f
        join latest_framework_versions v on v.project_id=f.project_id and v.framework_id=f.id
        where f.project_id=${projectId} and f.archived_at is null
      ), latest_appraisals as (
        select distinct on (project_id, appraisal_id) project_id, paper_id, framework_id, framework_version_id, id, overall_judgement_option_id
        from appraisal_revisions
        where project_id=${projectId} and finalized_at is not null
        order by project_id, appraisal_id, revision_number desc
      ), complete_current_appraisals as (
        select a.project_id, a.paper_id, a.framework_id
        from latest_appraisals a
        join appraisal_framework_versions v on v.project_id=a.project_id and v.id=a.framework_version_id
        where not exists (
          select 1 from appraisal_framework_items i
          where i.project_id=a.project_id and i.framework_version_id=a.framework_version_id and i.required=true
            and not exists (
              select 1 from appraisal_revision_responses r
              where r.project_id=a.project_id and r.revision_id=a.id and r.framework_item_id=i.id and r.selected_option_id is not null
            )
        )
        and (not v.overall_judgement_required or a.overall_judgement_option_id is not null)
      ), awaiting_appraisal_papers as (
        select distinct fi.paper_id
        from finally_included fi
        where exists (select 1 from active_appraisal_frameworks)
          and exists (
            select 1 from active_appraisal_frameworks af
            where not exists (
              select 1 from complete_current_appraisals ca
              where ca.project_id=${projectId} and ca.paper_id=fi.paper_id and ca.framework_id=af.framework_id
            )
          )
      ), complete_active_appraisals as (
        select count(*)::int as count
        from complete_current_appraisals ca
        join finally_included fi on fi.paper_id=ca.paper_id
        join active_appraisal_frameworks af on af.framework_id=ca.framework_id
      )
      select
        (select count(*)::int from required_fields) as required_field_count,
        (select count(*)::int from missing_papers) as missing_required_paper_count,
        (select count(*)::int from ai_candidates) as ai_suggestion_count,
        (select count(*)::int from active_appraisal_frameworks) as active_appraisal_framework_count,
        (select count(*)::int from awaiting_appraisal_papers) as awaiting_appraisal_paper_count,
        (select count from complete_active_appraisals) as complete_current_appraisal_count,
        (select paper_id from ai_candidates limit 1) as next_ai_paper_id,
        (select request_id from ai_candidates limit 1) as next_ai_request_id
    `));

    const synthesisRows = rowList(await db.execute(sql`
      with current_claims as (
        select distinct on (project_id, claim_id) project_id, claim_id, id, state
        from claim_revisions where project_id=${projectId} and finalized_at is not null
        order by project_id, claim_id, sequence desc
      ), current_synthesis as (
        select distinct on (project_id, synthesis_statement_id) project_id, synthesis_statement_id, id, state
        from synthesis_revisions where project_id=${projectId} and finalized_at is not null
        order by project_id, synthesis_statement_id, sequence desc
      ), current_review as (
        select distinct on (project_id, thread_id) project_id, thread_id, event_type
        from manuscript_review_events where project_id=${projectId}
        order by project_id, thread_id, sequence desc
      ), ai_candidates as (
        select r.request_id, ar.preparation_id
        from ai_synthesis_results r join ai_synthesis_requests ar on ar.project_id=r.project_id and ar.id=r.request_id
        where r.project_id=${projectId} and r.outcome='succeeded' and r.candidate_state='present'
          and not exists (select 1 from ai_synthesis_decisions d where d.project_id=r.project_id and d.request_id=r.request_id)
        order by r.created_at asc, r.id asc
      )
      select
        (select count(*)::int from synthesis_preparations where project_id=${projectId} and status='active') as active_preparation_count,
        (select count(*)::int from current_synthesis where state='active') as active_synthesis_count,
        (select count(*)::int from research_question_answers where project_id=${projectId} and finalized_at is not null) as finalized_answer_count,
        (select count(*)::int from ai_candidates) as ai_suggestion_count,
        (select request_id from ai_candidates limit 1) as next_ai_request_id,
        (select preparation_id from ai_candidates limit 1) as next_ai_preparation_id,
        (select id from synthesis_preparations where project_id=${projectId} and status='active' order by created_at asc, id asc limit 1) as next_preparation_id,
        (select count(*)::int from current_claims c where c.state='active' and not exists (select 1 from claim_revision_evidence_supports e where e.project_id=c.project_id and e.claim_revision_id=c.id) and not exists (select 1 from claim_revision_extraction_supports e where e.project_id=c.project_id and e.claim_revision_id=c.id) and not exists (select 1 from claim_revision_synthesis_supports s where s.project_id=c.project_id and s.claim_revision_id=c.id)) as unsupported_claim_count,
        (select count(*)::int from current_review where event_type <> 'resolved') as open_thread_count,
        (select count(*)::int from manuscript_snapshots where project_id=${projectId}) as snapshot_count,
        (select count(*)::int from manuscripts where project_id=${projectId}) as manuscript_count
    `));

    return mapOverviewFacts(projectRow, extractionRows[0] ?? {}, synthesisRows[0] ?? {});
  }

  return { listProjectCards, getProjectOverview };
}
