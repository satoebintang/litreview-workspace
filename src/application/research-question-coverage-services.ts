/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  evidenceSets,
  extractionFields,
  projects,
  researchQuestions,
} from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { derivePaperReviewStatus, isFinallyIncluded } from "@/domain/paper-review";
import type {
  ConvergenceState,
  CurrentQuestionLinks,
  ExtractionFieldCoverageState,
  ExtractionFieldPaperCoverage,
  LinkedClaimCoverage,
  LinkedEvidenceSetCoverage,
  LinkedExtractionFieldCoverage,
  LinkedSynthesisStatementCoverage,
  ProjectProtocolContext,
  ResearchQuestionMatrixProjection,
  ResearchQuestionMatrixRow,
  ResearchQuestionTraceabilityFlags,
  ResearchQuestionTraceabilityProjection,
  ScreeningDecisionValue,
  TraceabilityFlag,
} from "@/domain/types";
import { idSchema } from "@/domain/validation";
import {
  ResearchQuestionTraceabilityRepository,
  type DbOrTx,
} from "./research-question-traceability-repository";

function ensureId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) {
    throw new DomainError("VALIDATION_ERROR", "Identifier must be a valid UUID", result.error.issues);
  }
  return result.data;
}

export function createResearchQuestionCoverageServices(
  db: Database,
  traceabilityRepo: ResearchQuestionTraceabilityRepository,
) {
  async function requireProject(projectId: string, tx: DbOrTx = db) {
    ensureId(projectId);
    const [p] = await (tx as any)
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return p;
  }

  async function getProtocolContext(projectId: string): Promise<ProjectProtocolContext> {
    const [strategyRow, runRow] = await Promise.all([
      db.execute(sql`
        select count(*)::int as count
        from search_strategies
        where project_id = ${projectId} and archived_at is null
      `),
      db.execute(sql`
        select count(*)::int as count
        from search_runs
        where project_id = ${projectId}
      `),
    ]);
    return {
      searchStrategyCount: Number((strategyRow as any[])[0]?.count ?? 0),
      searchRunCount: Number((runRow as any[])[0]?.count ?? 0),
    };
  }

  async function getFinallyIncludedPapers(projectId: string): Promise<{ id: string; title: string }[]> {
    const rows = await db.execute(sql`
      with latest_ta as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from screening_decisions
        where project_id = ${projectId} and stage = 'title_abstract'
        order by project_id, paper_id, sequence desc
      ), latest_ft as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions
        where project_id = ${projectId}
        order by project_id, paper_id, sequence desc
      ), latest_retrieval as (
        select distinct on (project_id, paper_id) project_id, paper_id, outcome
        from full_text_retrieval_attempts
        where project_id = ${projectId}
        order by project_id, paper_id, sequence desc
      ), retrieval_history as (
        select distinct project_id, paper_id
        from full_text_retrieval_attempts
        where project_id = ${projectId}
      ), retrieval_success as (
        select distinct project_id, paper_id
        from full_text_retrieval_attempts
        where project_id = ${projectId} and outcome = 'retrieved'
      ), analytical_history as (
        select distinct project_id, paper_id
        from extraction_value_revisions
        where project_id = ${projectId} and finalized_at is not null
      )
      select p.id, p.title,
        ta.decision as title_abstract_decision,
        ft.decision as full_text_decision,
        lr.outcome as full_text_retrieval_state,
        (rh.paper_id is not null) as has_full_text_retrieval_attempts,
        (rs.paper_id is not null) as ever_retrieved,
        (ah.paper_id is not null) as has_analytical_history
      from papers p
      left join latest_ta ta on ta.project_id = p.project_id and ta.paper_id = p.id
      left join latest_ft ft on ft.project_id = p.project_id and ft.paper_id = p.id
      left join latest_retrieval lr on lr.project_id = p.project_id and lr.paper_id = p.id
      left join retrieval_history rh on rh.project_id = p.project_id and rh.paper_id = p.id
      left join retrieval_success rs on rs.project_id = p.project_id and rs.paper_id = p.id
      left join analytical_history ah on ah.project_id = p.project_id and ah.paper_id = p.id
      where p.project_id = ${projectId}
      order by p.created_at, p.id
    `);

    const included: { id: string; title: string }[] = [];
    for (const r of rows as any[]) {
      const taDecision = r.title_abstract_decision as ScreeningDecisionValue | null;
      const ftDecision = r.full_text_decision as ScreeningDecisionValue | null;
      const retrievalState = r.full_text_retrieval_state;
      const status = derivePaperReviewStatus({
        titleAbstractDecision: taDecision === "include" || taDecision === "exclude" || taDecision === "maybe" ? taDecision : null,
        fullTextDecision: ftDecision === "include" || ftDecision === "exclude" || ftDecision === "maybe" ? ftDecision : null,
        fullTextRetrievalState: retrievalState === "pending" || retrievalState === "unavailable" || retrievalState === "retrieved" ? retrievalState : "not_sought",
        everRetrieved: Boolean(r.ever_retrieved),
        hasFullTextRetrievalAttempts: Boolean(r.has_full_text_retrieval_attempts),
        hasAnalyticalHistory: Boolean(r.has_analytical_history),
      });
      if (isFinallyIncluded(status)) {
        included.push({ id: String(r.id), title: String(r.title) });
      }
    }
    return included;
  }

  async function resolveExtractionCoverage(
    projectId: string,
    fieldIds: string[],
    includedPapers: { id: string; title: string }[],
  ): Promise<LinkedExtractionFieldCoverage[]> {
    if (!fieldIds.length) return [];

    const fieldRows = await db
      .select()
      .from(extractionFields)
      .where(and(eq(extractionFields.projectId, projectId), inArray(extractionFields.id, fieldIds)))
      .orderBy(asc(extractionFields.sortOrder), asc(extractionFields.name));

    const fieldsById = new Map(fieldRows.map((f) => [f.id, f]));

    // Query latest finalized revision for each (paper, field)
    const revisionRows = await db.execute(sql`
      select distinct on (ev.paper_id, ev.field_id)
        ev.paper_id, ev.field_id,
        r.id as revision_id, r.sequence, r.value_state,
        r.text_value, r.number_value, r.boolean_value, r.option_id,
        opt.label as option_label
      from extraction_values ev
      join extraction_value_revisions r on r.project_id = ev.project_id and r.extraction_value_id = ev.id and r.finalized_at is not null
      left join extraction_options opt on opt.project_id = r.project_id and opt.id = r.option_id
      where ev.project_id = ${projectId}
        and ev.field_id in (${sql.join(fieldIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by ev.paper_id, ev.field_id, r.sequence desc
    `);

    const revisionMap = new Map<string, any>(); // key: `${paperId}:${fieldId}`
    for (const r of revisionRows as any[]) {
      revisionMap.set(`${r.paper_id}:${r.field_id}`, r);
    }

    const coverages: LinkedExtractionFieldCoverage[] = [];

    for (const fieldId of fieldIds) {
      const field = fieldsById.get(fieldId);
      if (!field) continue;

      const paperCoverage: ExtractionFieldPaperCoverage[] = [];
      let hasAnyNonClearedData = false;

      for (const paper of includedPapers) {
        const rev = revisionMap.get(`${paper.id}:${fieldId}`);
        if (!rev) {
          paperCoverage.push({
            paperId: paper.id,
            paperTitle: paper.title,
            status: "no_finalized_revision",
            revisionId: null,
            displayValue: null,
          });
        } else {
          const state = rev.value_state as ExtractionFieldCoverageState;
          let displayVal: string | null = null;
          if (state === "present") {
            displayVal =
              rev.text_value ??
              (rev.number_value != null ? String(Number(rev.number_value)) : null) ??
              (rev.boolean_value == null ? (rev.option_label as string | null) : String(rev.boolean_value));
            hasAnyNonClearedData = true;
          } else if (state === "not_reported") {
            displayVal = "Not Reported";
            hasAnyNonClearedData = true;
          } else if (state === "not_applicable") {
            displayVal = "Not Applicable";
            hasAnyNonClearedData = true;
          } else if (state === "cleared") {
            displayVal = null;
          }

          paperCoverage.push({
            paperId: paper.id,
            paperTitle: paper.title,
            status: state,
            revisionId: String(rev.revision_id),
            displayValue: displayVal,
          });
        }
      }

      coverages.push({
        fieldId: field.id,
        fieldName: field.name,
        fieldType: field.fieldType,
        archivedAt: field.archivedAt,
        paperCoverage,
        hasAnyNonClearedData,
      });
    }

    return coverages;
  }

  async function resolveEvidenceSetCoverage(
    projectId: string,
    setIds: string[],
  ): Promise<LinkedEvidenceSetCoverage[]> {
    if (!setIds.length) return [];

    const setRows = await db
      .select()
      .from(evidenceSets)
      .where(and(eq(evidenceSets.projectId, projectId), inArray(evidenceSets.id, setIds)))
      .orderBy(asc(evidenceSets.name));

    const setsById = new Map(setRows.map((s) => [s.id, s]));

    // Query latest composition revision per evidence set
    const compRevisions = await db.execute(sql`
      select distinct on (evidence_set_id)
        id as composition_revision_id, evidence_set_id, sequence
      from evidence_set_composition_revisions
      where project_id = ${projectId}
        and evidence_set_id in (${sql.join(setIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by evidence_set_id, sequence desc
    `);

    const compRevMap = new Map<string, string>();
    const compRevIds: string[] = [];
    for (const r of compRevisions as any[]) {
      compRevMap.set(String(r.evidence_set_id), String(r.composition_revision_id));
      compRevIds.push(String(r.composition_revision_id));
    }

    // If composition revisions exist, query member items and their current review status
    let memberRows: any[] = [];
    if (compRevIds.length > 0) {
      memberRows = (await db.execute(sql`
        with current_review as (
          select distinct on (project_id, evidence_id) project_id, evidence_id, decision
          from evidence_review_decisions
          where project_id = ${projectId}
          order by project_id, evidence_id, sequence desc
        )
        select
          cm.composition_revision_id,
          m.evidence_set_id,
          m.evidence_id,
          e.paper_id,
          cr.decision as review_decision
        from evidence_set_composition_members cm
        join evidence_set_memberships m
          on m.project_id = cm.project_id and m.evidence_set_id = cm.evidence_set_id and m.id = cm.membership_id
        join evidence e on e.project_id = m.project_id and e.id = m.evidence_id
        left join current_review cr on cr.project_id = e.project_id and cr.evidence_id = e.id
        where cm.project_id = ${projectId}
          and cm.composition_revision_id in (${sql.join(compRevIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `)) as any[];
    }

    const membersBySet = new Map<string, any[]>();
    for (const r of memberRows) {
      const setId = String(r.evidence_set_id);
      const list = membersBySet.get(setId) ?? [];
      list.push(r);
      membersBySet.set(setId, list);
    }

    const coverages: LinkedEvidenceSetCoverage[] = [];

    for (const setId of setIds) {
      const set = setsById.get(setId);
      if (!set) continue;

      const compRevId = compRevMap.get(setId) ?? null;
      const members = membersBySet.get(setId) ?? [];

      const distinctPapers = new Set<string>();
      const reviewCounts = {
        accepted: 0,
        needsReview: 0,
        unreviewed: 0,
        rejected: 0,
      };

      for (const m of members) {
        if (m.paper_id) distinctPapers.add(String(m.paper_id));
        const decision = m.review_decision;
        if (decision === "accepted") reviewCounts.accepted += 1;
        else if (decision === "needs_review") reviewCounts.needsReview += 1;
        else if (decision === "rejected") reviewCounts.rejected += 1;
        else reviewCounts.unreviewed += 1;
      }

      coverages.push({
        evidenceSetId: set.id,
        name: set.name,
        description: set.description ?? null,
        archivedAt: set.archivedAt,
        latestCompositionRevisionId: compRevId,
        memberCount: members.length,
        distinctPaperCount: distinctPapers.size,
        reviewCounts,
      });
    }

    return coverages;
  }

  async function resolveSynthesisCoverage(
    projectId: string,
    statementIds: string[],
  ): Promise<LinkedSynthesisStatementCoverage[]> {
    if (!statementIds.length) return [];

    // Query latest finalized revision per statement with fallback label for withdrawn statements
    const revisionRows = await db.execute(sql`
      with latest_rev as (
        select distinct on (synthesis_statement_id)
          id as revision_id, synthesis_statement_id, sequence, state, title, statement_text
        from synthesis_revisions
        where project_id = ${projectId}
          and synthesis_statement_id in (${sql.join(statementIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and finalized_at is not null
        order by synthesis_statement_id, sequence desc
      ),
      latest_labeled as (
        select distinct on (synthesis_statement_id)
          synthesis_statement_id, coalesce(title, statement_text) as fallback_label
        from synthesis_revisions
        where project_id = ${projectId}
          and synthesis_statement_id in (${sql.join(statementIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and finalized_at is not null
          and (title is not null or statement_text is not null)
        order by synthesis_statement_id, sequence desc
      )
      select r.*, l.fallback_label
      from latest_rev r
      left join latest_labeled l on l.synthesis_statement_id = r.synthesis_statement_id
    `);

    const latestRevsByStmt = new Map<string, any>();
    const activeRevisionIds: string[] = [];
    for (const r of revisionRows as any[]) {
      latestRevsByStmt.set(String(r.synthesis_statement_id), r);
      if (r.state === "active") {
        activeRevisionIds.push(String(r.revision_id));
      }
    }

    // Support counts for active revisions
    const supportCountMap = new Map<string, number>();
    if (activeRevisionIds.length > 0) {
      const supportRows = await db.execute(sql`
        select synthesis_revision_id, count(*)::int as count
        from synthesis_revision_supports
        where project_id = ${projectId}
          and synthesis_revision_id in (${sql.join(activeRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
        group by synthesis_revision_id
      `);
      for (const r of supportRows as any[]) {
        supportCountMap.set(String(r.synthesis_revision_id), Number(r.count));
      }
    }

    // Latest interpretation per exact active synthesis revision
    const interpMap = new Map<string, ConvergenceState>();
    if (activeRevisionIds.length > 0) {
      const interpretationRows = await db.execute(sql`
        select distinct on (synthesis_revision_id)
          id, synthesis_statement_id, synthesis_revision_id, convergence_state
        from synthesis_interpretations
        where project_id = ${projectId}
          and synthesis_revision_id in (${sql.join(activeRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and finalized_at is not null
        order by synthesis_revision_id, sequence desc
      `);

      for (const r of interpretationRows as any[]) {
        interpMap.set(String(r.synthesis_revision_id), r.convergence_state as ConvergenceState);
      }
    }

    const coverages: LinkedSynthesisStatementCoverage[] = [];

    for (const statementId of statementIds) {
      const latest = latestRevsByStmt.get(statementId);
      const isActive = latest?.state === "active";
      const activeRevId = isActive ? String(latest.revision_id) : null;
      const activeSeq = isActive ? Number(latest.sequence) : null;
      const supportCount = activeRevId ? (supportCountMap.get(activeRevId) ?? 0) : 0;
      const convergence = activeRevId ? (interpMap.get(activeRevId) ?? null) : null;
      const titleCandidate = latest?.title ?? latest?.statement_text ?? latest?.fallback_label ?? null;
      const title = titleCandidate != null ? String(titleCandidate) : null;

      coverages.push({
        statementId,
        title,
        currentActiveRevisionId: activeRevId,
        currentActiveSequence: activeSeq,
        latestRevisionSequence: latest ? Number(latest.sequence) : null,
        latestRevisionState: latest ? String(latest.state) : null,
        hasActiveRevision: isActive,
        supportCount,
        hasInterpretation: convergence !== null,
        currentInterpretationConvergence: convergence,
      });
    }

    return coverages;
  }

  async function resolveClaimCoverage(
    projectId: string,
    claimIds: string[],
  ): Promise<LinkedClaimCoverage[]> {
    if (!claimIds.length) return [];

    // Query latest finalized revision per claim with fallback text for withdrawn claims
    const revisionRows = await db.execute(sql`
      with latest_rev as (
        select distinct on (claim_id)
          id as revision_id, claim_id, sequence, state, claim_text
        from claim_revisions
        where project_id = ${projectId}
          and claim_id in (${sql.join(claimIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and finalized_at is not null
        order by claim_id, sequence desc
      ),
      latest_labeled as (
        select distinct on (claim_id)
          claim_id, claim_text
        from claim_revisions
        where project_id = ${projectId}
          and claim_id in (${sql.join(claimIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and finalized_at is not null
          and claim_text is not null
        order by claim_id, sequence desc
      )
      select r.*, l.claim_text as fallback_claim_text
      from latest_rev r
      left join latest_labeled l on l.claim_id = r.claim_id
    `);

    const latestRevsByClaim = new Map<string, any>();
    const activeRevisionIds: string[] = [];
    for (const r of revisionRows as any[]) {
      latestRevsByClaim.set(String(r.claim_id), r);
      if (r.state === "active") {
        activeRevisionIds.push(String(r.revision_id));
      }
    }

    // Support counts across evidence, extraction, synthesis supports
    const supportMap = new Map<string, boolean>();
    if (activeRevisionIds.length > 0) {
      const [evRows, exRows, synRows] = await Promise.all([
        db.execute(sql`
          select distinct claim_revision_id
          from claim_revision_evidence_supports
          where project_id = ${projectId}
            and claim_revision_id in (${sql.join(activeRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
        `),
        db.execute(sql`
          select distinct claim_revision_id
          from claim_revision_extraction_supports
          where project_id = ${projectId}
            and claim_revision_id in (${sql.join(activeRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
        `),
        db.execute(sql`
          select distinct claim_revision_id
          from claim_revision_synthesis_supports
          where project_id = ${projectId}
            and claim_revision_id in (${sql.join(activeRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
        `),
      ]);
      for (const r of evRows as any[]) supportMap.set(String(r.claim_revision_id), true);
      for (const r of exRows as any[]) supportMap.set(String(r.claim_revision_id), true);
      for (const r of synRows as any[]) supportMap.set(String(r.claim_revision_id), true);
    }

    // Manuscript placements: active placement, active item, non-archived section
    const placementRows = await db.execute(sql`
      select p.claim_id, p.claim_revision_id, p.removed_at as placement_removed_at,
             i.id as section_item_id, i.removed_at as item_removed_at,
             s.id as section_id, s.archived_at as section_archived_at,
             s.title as section_title, s.section_type
      from manuscript_claim_placements p
      left join manuscript_section_item_claims sic on sic.project_id = p.project_id and sic.placement_id = p.id
      left join manuscript_section_items i on i.project_id = p.project_id and i.id = sic.section_item_id
      left join manuscript_sections s on s.project_id = i.project_id and s.id = i.section_id
      where p.project_id = ${projectId}
        and p.claim_id in (${sql.join(claimIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);

    const historicalPlacementSet = new Set<string>();
    const currentPlacedMap = new Map<string, boolean>();
    const placementSectionsMap = new Map<string, Set<string>>();

    for (const r of placementRows as any[]) {
      const claimId = String(r.claim_id);
      historicalPlacementSet.add(claimId);

      const isActive =
        r.placement_removed_at == null &&
        r.section_item_id != null &&
        r.item_removed_at == null &&
        r.section_id != null &&
        r.section_archived_at == null;

      if (isActive) {
        const latest = latestRevsByClaim.get(claimId);
        if (latest?.state === "active" && String(r.claim_revision_id) === String(latest.revision_id)) {
          currentPlacedMap.set(claimId, true);
          const sections = placementSectionsMap.get(claimId) ?? new Set<string>();
          sections.add(String(r.section_title ?? r.section_type ?? "Section"));
          placementSectionsMap.set(claimId, sections);
        }
      }
    }

    const coverages: LinkedClaimCoverage[] = [];

    for (const claimId of claimIds) {
      const latest = latestRevsByClaim.get(claimId);
      const isActive = latest?.state === "active";
      const activeRevId = isActive ? String(latest.revision_id) : null;
      const activeSeq = isActive ? Number(latest.sequence) : null;
      const textCandidate = latest?.claim_text ?? latest?.fallback_claim_text ?? null;
      const claimText = textCandidate != null ? String(textCandidate) : null;
      const hasSupport = activeRevId ? (supportMap.get(activeRevId) ?? false) : false;
      const isPlaced = activeRevId ? (currentPlacedMap.get(claimId) ?? false) : false;
      const hasHistory = historicalPlacementSet.has(claimId);
      const sections = placementSectionsMap.get(claimId);

      coverages.push({
        claimId,
        currentActiveRevisionId: activeRevId,
        currentActiveSequence: activeSeq,
        latestRevisionSequence: latest ? Number(latest.sequence) : null,
        latestRevisionState: latest ? String(latest.state) : null,
        hasActiveRevision: isActive,
        claimText,
        hasSupport,
        currentClaimPlaced: isPlaced,
        hasAnyHistoricalPlacement: hasHistory,
        activePlacementSections: sections ? Array.from(sections) : [],
      });
    }

    return coverages;
  }

  function deriveFlags(
    currentLinks: CurrentQuestionLinks,
    extractionCoverage: LinkedExtractionFieldCoverage[],
    evidenceSetCoverage: LinkedEvidenceSetCoverage[],
    synthesisCoverage: LinkedSynthesisStatementCoverage[],
    claimCoverage: LinkedClaimCoverage[],
  ): ResearchQuestionTraceabilityFlags {
    // 1. Extraction flags
    const extractionFlags: TraceabilityFlag[] = [];
    if (currentLinks.extractionFieldIds.length === 0) {
      extractionFlags.push({ code: "no_linked_extraction_fields" });
    } else {
      for (const f of extractionCoverage) {
        if (!f.hasAnyNonClearedData) {
          extractionFlags.push({
            code: "linked_field_without_current_data",
            targetType: "extraction_field",
            targetId: f.fieldId,
            targetLabel: f.fieldName,
          });
        }
      }
    }

    // 2. Evidence set flags
    const evidenceSetFlags: TraceabilityFlag[] = [];
    if (currentLinks.evidenceSetIds.length === 0) {
      evidenceSetFlags.push({ code: "no_linked_evidence_sets" });
    } else {
      for (const s of evidenceSetCoverage) {
        if (s.memberCount === 0) {
          evidenceSetFlags.push({
            code: "linked_set_empty",
            targetType: "evidence_set",
            targetId: s.evidenceSetId,
            targetLabel: s.name,
          });
        }
        if (s.reviewCounts.rejected > 0) {
          evidenceSetFlags.push({
            code: "linked_set_contains_rejected_evidence",
            targetType: "evidence_set",
            targetId: s.evidenceSetId,
            targetLabel: s.name,
          });
        }
      }
    }

    // 3. Synthesis flags
    const synthesisFlags: TraceabilityFlag[] = [];
    if (currentLinks.synthesisStatementIds.length === 0) {
      synthesisFlags.push({ code: "no_linked_synthesis_statements" });
    } else {
      for (const s of synthesisCoverage) {
        const title = s.title ?? s.statementId;
        if (!s.hasActiveRevision) {
          // Suppression rule: only linked_statement_without_current_active_revision
          // Do not also emit missing-support or missing-interpretation
          synthesisFlags.push({
            code: "linked_statement_without_current_active_revision",
            targetType: "synthesis_statement",
            targetId: s.statementId,
            targetLabel: title,
          });
        } else {
          if (s.supportCount === 0) {
            synthesisFlags.push({
              code: "linked_current_synthesis_without_support",
              targetType: "synthesis_statement",
              targetId: s.statementId,
              targetLabel: title,
            });
          }
          if (!s.hasInterpretation) {
            synthesisFlags.push({
              code: "linked_current_synthesis_without_interpretation",
              targetType: "synthesis_statement",
              targetId: s.statementId,
              targetLabel: title,
            });
          }
        }
      }
    }

    // 4. Claim flags
    const claimFlags: TraceabilityFlag[] = [];
    if (currentLinks.claimIds.length === 0) {
      claimFlags.push({ code: "no_linked_claims" });
    } else {
      for (const c of claimCoverage) {
        const text = c.claimText ?? c.claimId;
        const shortLabel = text.length > 50 ? text.slice(0, 47) + "..." : text;
        if (!c.hasActiveRevision) {
          // Suppression rule: only linked_claim_without_current_active_revision
          // Do not also emit unsupported or not-placed
          claimFlags.push({
            code: "linked_claim_without_current_active_revision",
            targetType: "claim",
            targetId: c.claimId,
            targetLabel: shortLabel,
          });
        } else {
          if (!c.hasSupport) {
            claimFlags.push({
              code: "linked_current_claim_unsupported",
              targetType: "claim",
              targetId: c.claimId,
              targetLabel: shortLabel,
            });
          }
          if (!c.currentClaimPlaced) {
            claimFlags.push({
              code: "linked_current_claim_not_placed",
              targetType: "claim",
              targetId: c.claimId,
              targetLabel: shortLabel,
            });
          }
        }
      }
    }

    return {
      extraction: extractionFlags,
      evidenceSets: evidenceSetFlags,
      synthesis: synthesisFlags,
      claims: claimFlags,
    };
  }

  return {
    async getQuestionTraceability(
      projectId: string,
      questionId: string,
    ): Promise<ResearchQuestionTraceabilityProjection> {
      await requireProject(projectId);
      ensureId(questionId);

      const [question] = await db
        .select()
        .from(researchQuestions)
        .where(and(eq(researchQuestions.projectId, projectId), eq(researchQuestions.id, questionId)))
        .limit(1);
      if (!question) throw new DomainError("NOT_FOUND", "Research question was not found");

      // 1. Current links from single authoritative reducer
      const currentLinks = await traceabilityRepo.listCurrentLinksForQuestion(projectId, questionId);

      // 2. Protocols, included papers
      const [protocolContext, includedPapers] = await Promise.all([
        getProtocolContext(projectId),
        getFinallyIncludedPapers(projectId),
      ]);

      // 3. Factual coverage across 4 dimensions
      const [extractionCoverage, evidenceSetCoverage, synthesisCoverage, claimCoverage] =
        await Promise.all([
          resolveExtractionCoverage(projectId, currentLinks.extractionFieldIds, includedPapers),
          resolveEvidenceSetCoverage(projectId, currentLinks.evidenceSetIds),
          resolveSynthesisCoverage(projectId, currentLinks.synthesisStatementIds),
          resolveClaimCoverage(projectId, currentLinks.claimIds),
        ]);

      // 4. Flags
      const flags = deriveFlags(
        currentLinks,
        extractionCoverage,
        evidenceSetCoverage,
        synthesisCoverage,
        claimCoverage,
      );

      // 5. Histories
      const [fieldEvents, evidenceSetEvents, synthesisEvents, claimEvents] = await Promise.all([
        traceabilityRepo.listExtractionFieldEvents(projectId, questionId),
        traceabilityRepo.listEvidenceSetEvents(projectId, questionId),
        traceabilityRepo.listSynthesisStatementEvents(projectId, questionId),
        traceabilityRepo.listClaimEvents(projectId, questionId),
      ]);

      // 6. Candidate targets (for link modals/panels)
      const [allFields, allSets, allStmts, allClaims] = await Promise.all([
        db
          .select({
            id: extractionFields.id,
            name: extractionFields.name,
            fieldType: extractionFields.fieldType,
            archivedAt: extractionFields.archivedAt,
          })
          .from(extractionFields)
          .where(eq(extractionFields.projectId, projectId))
          .orderBy(asc(extractionFields.name)),
        db
          .select({
            id: evidenceSets.id,
            name: evidenceSets.name,
            archivedAt: evidenceSets.archivedAt,
          })
          .from(evidenceSets)
          .where(eq(evidenceSets.projectId, projectId))
          .orderBy(asc(evidenceSets.name)),
        db.execute(sql`
          select s.id,
            coalesce(r.title, 'Untitled Statement') as current_title,
            coalesce(r.state, 'draft') as current_state
          from synthesis_statements s
          left join lateral (
            select title, state from synthesis_revisions r
            where r.project_id = s.project_id and r.synthesis_statement_id = s.id and r.finalized_at is not null
            order by r.sequence desc limit 1
          ) r on true
          where s.project_id = ${projectId}
          order by s.created_at desc
        `),
        db.execute(sql`
          select c.id,
            coalesce(r.claim_text, 'Empty claim') as current_text,
            coalesce(r.state, 'draft') as current_state
          from claims c
          left join lateral (
            select claim_text, state from claim_revisions r
            where r.project_id = c.project_id and r.claim_id = c.id and r.finalized_at is not null
            order by r.sequence desc limit 1
          ) r on true
          where c.project_id = ${projectId}
          order by c.created_at desc
        `),
      ]);

      return {
        question: {
          id: question.id,
          projectId: question.projectId,
          identifier: question.identifier,
          label: question.label,
          sortOrder: question.sortOrder,
          archivedAt: question.archivedAt,
        },
        currentLinks,
        protocolContext,
        extractionCoverage,
        evidenceSetCoverage,
        synthesisCoverage,
        claimCoverage,
        flags,
        histories: {
          fieldEvents,
          evidenceSetEvents,
          synthesisEvents,
          claimEvents,
        },
        candidateTargets: {
          extractionFields: allFields,
          evidenceSets: allSets,
          synthesisStatements: (allStmts as any[]).map((r) => ({
            id: String(r.id),
            currentTitle: String(r.current_title),
            currentState: String(r.current_state),
            archivedAt: null,
          })),
          claims: (allClaims as any[]).map((r) => ({
            id: String(r.id),
            currentText: String(r.current_text),
            currentState: String(r.current_state),
          })),
        },
      };
    },

    async getResearchQuestionMatrix(projectId: string): Promise<ResearchQuestionMatrixProjection> {
      await requireProject(projectId);

      const [questions, protocolContext, includedPapers] = await Promise.all([
        db
          .select()
          .from(researchQuestions)
          .where(eq(researchQuestions.projectId, projectId))
          .orderBy(asc(researchQuestions.sortOrder), asc(researchQuestions.id)),
        getProtocolContext(projectId),
        getFinallyIncludedPapers(projectId),
      ]);

      if (!questions.length) {
        return {
          rows: [],
          protocolContext,
        };
      }

      // Single authoritative project-wide reducer
      const questionIds = questions.map((q) => q.id);
      const projectLinks = await traceabilityRepo.listCurrentLinksForProject(projectId, questionIds);

      // Collect all distinct target IDs linked across all questions to batch queries efficiently
      const allLinkedFieldIds = new Set<string>();
      const allLinkedSetIds = new Set<string>();
      const allLinkedStmtIds = new Set<string>();
      const allLinkedClaimIds = new Set<string>();

      for (const qId of questionIds) {
        const links = projectLinks.get(qId);
        if (links) {
          links.extractionFieldIds.forEach((id) => allLinkedFieldIds.add(id));
          links.evidenceSetIds.forEach((id) => allLinkedSetIds.add(id));
          links.synthesisStatementIds.forEach((id) => allLinkedStmtIds.add(id));
          links.claimIds.forEach((id) => allLinkedClaimIds.add(id));
        }
      }

      const [extractionCoverages, evidenceSetCoverages, synthesisCoverages, claimCoverages] =
        await Promise.all([
          resolveExtractionCoverage(projectId, Array.from(allLinkedFieldIds), includedPapers),
          resolveEvidenceSetCoverage(projectId, Array.from(allLinkedSetIds)),
          resolveSynthesisCoverage(projectId, Array.from(allLinkedStmtIds)),
          resolveClaimCoverage(projectId, Array.from(allLinkedClaimIds)),
        ]);

      const extractionMap = new Map(extractionCoverages.map((c) => [c.fieldId, c]));
      const setMap = new Map(evidenceSetCoverages.map((c) => [c.evidenceSetId, c]));
      const stmtMap = new Map(synthesisCoverages.map((c) => [c.statementId, c]));
      const claimMap = new Map(claimCoverages.map((c) => [c.claimId, c]));

      const rows: ResearchQuestionMatrixRow[] = questions.map((q) => {
        const links = projectLinks.get(q.id) ?? {
          extractionFieldIds: [],
          evidenceSetIds: [],
          synthesisStatementIds: [],
          claimIds: [],
        };

        const fieldCovs = links.extractionFieldIds
          .map((id) => extractionMap.get(id))
          .filter(Boolean) as LinkedExtractionFieldCoverage[];
        const setCovs = links.evidenceSetIds
          .map((id) => setMap.get(id))
          .filter(Boolean) as LinkedEvidenceSetCoverage[];
        const stmtCovs = links.synthesisStatementIds
          .map((id) => stmtMap.get(id))
          .filter(Boolean) as LinkedSynthesisStatementCoverage[];
        const claimCovs = links.claimIds
          .map((id) => claimMap.get(id))
          .filter(Boolean) as LinkedClaimCoverage[];

        const flags = deriveFlags(links, fieldCovs, setCovs, stmtCovs, claimCovs);

        const activeSynthesisStatements = stmtCovs.filter((s) => s.hasActiveRevision).length;
        const interpretations = stmtCovs.filter((s) => s.hasInterpretation).length;
        const activeClaims = claimCovs.filter((c) => c.hasActiveRevision).length;
        const currentManuscriptPlacements = claimCovs.filter((c) => c.currentClaimPlaced).length;

        return {
          question: {
            id: q.id,
            projectId: q.projectId,
            identifier: q.identifier,
            label: q.label,
            sortOrder: q.sortOrder,
            archivedAt: q.archivedAt,
          },
          counts: {
            linkedExtractionFields: links.extractionFieldIds.length,
            linkedEvidenceSets: links.evidenceSetIds.length,
            linkedSynthesisStatements: links.synthesisStatementIds.length,
            activeSynthesisStatements,
            interpretations,
            linkedClaims: links.claimIds.length,
            activeClaims,
            currentManuscriptPlacements,
          },
          flags,
        };
      });

      return {
        rows,
        protocolContext,
      };
    },
  };
}

export type ResearchQuestionCoverageServices = ReturnType<typeof createResearchQuestionCoverageServices>;
