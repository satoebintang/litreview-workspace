import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import type {
  AnswerClaimManuscriptContext,
  AnswerManuscriptOption,
  AnswerManuscriptPlacementLocation,
  AnswerManuscriptSectionOption,
  AnswerSynthesisManuscriptContext,
  ApplyResearchQuestionAnswerToSectionInput,
  ResearchQuestionAnswerManuscriptProjection,
  ResearchQuestionAnswerSnapshot,
} from "@/domain/types";
import {
  applyResearchQuestionAnswerToSectionSchema,
  idSchema,
  type ValidatedApplyResearchQuestionAnswerToSectionInput,
} from "@/domain/validation";
import type { DbTransaction } from "./research-question-traceability-repository";
import type {
  AnswerClaimRevisionResolution,
  AnswerClaimRevisionResolver,
} from "./research-question-answer-write-services";
import {
  loadActiveSectionItems,
  lockSection,
  planSectionBlock,
  writeSectionBlock,
} from "./manuscript-writer";

type Row = Record<string, unknown>;

const rows = (value: unknown) => value as unknown as Row[];

function date(value: unknown): Date | null {
  if (value == null) return null;
  return value instanceof Date ? new Date(value.getTime()) : new Date(value as string | number);
}

function requiredDate(value: unknown): Date {
  const parsed = date(value);
  if (!parsed) throw new DomainError("DATABASE_CONSTRAINT", "Database returned a null timestamp");
  return parsed;
}

function ensureId(value: string, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a valid UUID`, parsed.error.issues);
  return parsed.data;
}

function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Input failed validation", result.error.issues);
  return result.data;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String((error as { message?: unknown } | null)?.message ?? error);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isCurrentResolution(resolution: AnswerClaimRevisionResolution, revisionId: string): boolean {
  if (resolution.currentRevisionId != null) return resolution.currentRevisionId === revisionId;
  return resolution.isCurrentRevision === true;
}

function idList(values: string[]) {
  return sql.join(values.map((value) => sql`${value}::uuid`), sql`, `);
}

type ManuscriptRows = {
  manuscripts: AnswerManuscriptOption[];
  sectionsByManuscript: Map<string, AnswerManuscriptSectionOption[]>;
};

type PlacementRow = {
  placementId: string;
  sectionItemId: string | null;
  manuscriptId: string;
  manuscriptTitle: string;
  sectionId: string;
  sectionTitle: string;
  claimId: string;
  claimRevisionId: string;
  claimRevisionSequence: number;
  removedAt: Date | null;
};

interface ResearchQuestionAnswerManuscriptDependencies {
  getAnswerSnapshot: (projectId: string, questionId: string, answerId: string) => Promise<ResearchQuestionAnswerSnapshot>;
  resolveClaimRevision: AnswerClaimRevisionResolver;
}

function placementLocation(row: PlacementRow): AnswerManuscriptPlacementLocation {
  return {
    placementId: row.placementId,
    sectionItemId: row.sectionItemId,
    manuscriptId: row.manuscriptId,
    manuscriptTitle: row.manuscriptTitle,
    sectionId: row.sectionId,
    sectionTitle: row.sectionTitle,
    claimRevisionId: row.claimRevisionId,
    claimRevisionSequence: row.claimRevisionSequence,
    removedAt: row.removedAt,
  };
}

export function createResearchQuestionAnswerManuscriptServices(
  db: Database,
  dependencies: ResearchQuestionAnswerManuscriptDependencies,
) {
  async function question(projectId: string, questionId: string): Promise<Row> {
    const result = rows(await db.execute(sql`
      select id, project_id, identifier, label, archived_at
      from research_questions
      where project_id=${projectId} and id=${questionId}
      limit 1
    `));
    const row = result[0];
    if (!row) throw new DomainError("NOT_FOUND", "Research question was not found");
    return row;
  }

  async function loadManuscripts(projectId: string): Promise<ManuscriptRows> {
    const [manuscriptRows, sectionRows] = await Promise.all([
      db.execute(sql`
        select id, title, is_default, citation_style
        from manuscripts
        where project_id=${projectId}
        order by is_default desc, title, id
      `),
      db.execute(sql`
        select id, manuscript_id, title, section_type, sort_order
        from manuscript_sections
        where project_id=${projectId} and archived_at is null
        order by manuscript_id, sort_order, id
      `),
    ]);
    const sectionsByManuscript = new Map<string, AnswerManuscriptSectionOption[]>();
    for (const row of rows(sectionRows)) {
      const manuscriptId = String(row.manuscript_id);
      const section = {
        id: String(row.id),
        title: String(row.title),
        sectionType: String(row.section_type) as AnswerManuscriptSectionOption["sectionType"],
        sortOrder: Number(row.sort_order),
      } satisfies AnswerManuscriptSectionOption;
      sectionsByManuscript.set(manuscriptId, [...(sectionsByManuscript.get(manuscriptId) ?? []), section]);
    }
    const manuscripts = rows(manuscriptRows).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      isDefault: Boolean(row.is_default),
      citationStyle: String(row.citation_style ?? "numeric") as AnswerManuscriptOption["citationStyle"],
      sections: sectionsByManuscript.get(String(row.id)) ?? [],
    }));
    return { manuscripts, sectionsByManuscript };
  }

  async function loadPlacementRows(projectId: string, claimIds: string[]): Promise<PlacementRow[]> {
    if (!claimIds.length) return [];
    const result = await db.execute(sql`
      select p.id as placement_id,
             i.id as section_item_id,
             p.manuscript_id,
             m.title as manuscript_title,
             p.section_id,
             s.title as section_title,
             p.claim_id,
             p.claim_revision_id,
             r.sequence as claim_revision_sequence,
             coalesce(p.removed_at, i.removed_at) as removed_at
      from manuscript_claim_placements p
      join manuscripts m
        on m.project_id=p.project_id and m.id=p.manuscript_id
      join manuscript_sections s
        on s.project_id=p.project_id and s.manuscript_id=p.manuscript_id and s.id=p.section_id
      join claim_revisions r
        on r.project_id=p.project_id and r.id=p.claim_revision_id
      left join manuscript_section_items i
        on i.project_id=p.project_id and i.manuscript_id=p.manuscript_id
       and i.section_id=p.section_id and i.id=p.id
      where p.project_id=${projectId}
        and p.claim_id in (${idList(claimIds)})
      order by p.claim_id, p.created_at, p.id
    `);
    return rows(result).map((row) => ({
      placementId: String(row.placement_id),
      sectionItemId: row.section_item_id == null ? null : String(row.section_item_id),
      manuscriptId: String(row.manuscript_id),
      manuscriptTitle: String(row.manuscript_title),
      sectionId: String(row.section_id),
      sectionTitle: String(row.section_title),
      claimId: String(row.claim_id),
      claimRevisionId: String(row.claim_revision_id),
      claimRevisionSequence: Number(row.claim_revision_sequence),
      removedAt: date(row.removed_at),
    }));
  }

  async function loadClaimFacts(projectId: string, revisionIds: string[]) {
    if (!revisionIds.length) return new Map<string, { supportCount: number; citationCandidateCount: number }>();
    const revisions = idList(revisionIds);
    const [supportRows, citationRows] = await Promise.all([
      db.execute(sql`
        select r.id,
          (select count(*) from claim_revision_evidence_supports s where s.project_id=r.project_id and s.claim_revision_id=r.id)
          + (select count(*) from claim_revision_extraction_supports s where s.project_id=r.project_id and s.claim_revision_id=r.id)
          + (select count(*) from claim_revision_synthesis_supports s where s.project_id=r.project_id and s.claim_revision_id=r.id) as support_count
        from claim_revisions r
        where r.project_id=${projectId} and r.id in (${revisions})
      `),
      db.execute(sql`
        with candidate_papers as (
          select s.claim_revision_id, e.paper_id
          from claim_revision_evidence_supports s
          join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
          where s.project_id=${projectId} and s.claim_revision_id in (${revisions})
          union
          select s.claim_revision_id, x.paper_id
          from claim_revision_extraction_supports s
          join extraction_value_revisions x on x.project_id=s.project_id and x.id=s.extraction_revision_id
          where s.project_id=${projectId} and s.claim_revision_id in (${revisions})
          union
          select s.claim_revision_id, x.paper_id
          from claim_revision_synthesis_supports s
          join synthesis_revision_supports ss on ss.project_id=s.project_id and ss.synthesis_revision_id=s.synthesis_revision_id
          join extraction_value_revisions x on x.project_id=ss.project_id and x.id=ss.extraction_revision_id
          where s.project_id=${projectId} and s.claim_revision_id in (${revisions})
        )
        select claim_revision_id, count(*) as citation_candidate_count
        from candidate_papers
        group by claim_revision_id
      `),
    ]);
    const result = new Map<string, { supportCount: number; citationCandidateCount: number }>();
    for (const row of rows(supportRows)) result.set(String(row.id), { supportCount: Number(row.support_count ?? 0), citationCandidateCount: 0 });
    for (const row of rows(citationRows)) {
      const current = result.get(String(row.claim_revision_id)) ?? { supportCount: 0, citationCandidateCount: 0 };
      current.citationCandidateCount = Number(row.citation_candidate_count ?? 0);
      result.set(String(row.claim_revision_id), current);
    }
    return result;
  }

  async function loadSynthesisFacts(projectId: string, revisionIds: string[]) {
    if (!revisionIds.length) return new Map<string, { supportCount: number; interpretation: AnswerSynthesisManuscriptContext["interpretation"] }>();
    const revisions = idList(revisionIds);
    const [supportRows, interpretationRows] = await Promise.all([
      db.execute(sql`
        select synthesis_revision_id, count(*) as support_count
        from synthesis_revision_supports
        where project_id=${projectId} and synthesis_revision_id in (${revisions})
        group by synthesis_revision_id
      `),
      db.execute(sql`
        select distinct on (synthesis_revision_id)
          synthesis_revision_id, convergence_state, summary, finalized_at
        from synthesis_interpretations
        where project_id=${projectId}
          and synthesis_revision_id in (${revisions})
          and finalized_at is not null
        order by synthesis_revision_id, sequence desc, id desc
      `),
    ]);
    const result = new Map<string, { supportCount: number; interpretation: AnswerSynthesisManuscriptContext["interpretation"] }>();
    for (const row of rows(supportRows)) result.set(String(row.synthesis_revision_id), { supportCount: Number(row.support_count ?? 0), interpretation: null });
    for (const row of rows(interpretationRows)) {
      const current = result.get(String(row.synthesis_revision_id)) ?? { supportCount: 0, interpretation: null };
      current.interpretation = {
        convergenceState: String(row.convergence_state) as NonNullable<AnswerSynthesisManuscriptContext["interpretation"]>["convergenceState"],
        summary: String(row.summary),
        finalizedAt: requiredDate(row.finalized_at),
      };
      result.set(String(row.synthesis_revision_id), current);
    }
    return result;
  }

  async function getResearchQuestionAnswerManuscriptProjection(
    projectId: string,
    researchQuestionId: string,
    answerId: string,
    selection?: { manuscriptId?: string; sectionId?: string },
  ): Promise<ResearchQuestionAnswerManuscriptProjection> {
    const project = ensureId(projectId, "Project ID");
    const questionId = ensureId(researchQuestionId, "Research question ID");
    const exactAnswerId = ensureId(answerId, "Answer ID");
    const questionRow = await question(project, questionId);
    const answer = await dependencies.getAnswerSnapshot(project, questionId, exactAnswerId);
    const { manuscripts, sectionsByManuscript } = await loadManuscripts(project);

    const requestedManuscriptId = selection?.manuscriptId ? ensureId(selection.manuscriptId, "Manuscript ID") : undefined;
    const requestedSectionId = selection?.sectionId ? ensureId(selection.sectionId, "Section ID") : undefined;
    const selectedManuscript = requestedManuscriptId
      ? manuscripts.find((item) => item.id === requestedManuscriptId)
      : manuscripts[0];
    if (requestedManuscriptId && !selectedManuscript) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
    const selectedSections = selectedManuscript ? sectionsByManuscript.get(selectedManuscript.id) ?? [] : [];
    if (requestedSectionId && !selectedSections.some((section) => section.id === requestedSectionId)) {
      throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to the selected Manuscript");
    }
    const selectedSectionId = requestedSectionId ?? selectedSections[0]?.id ?? null;
    const claimIds = sortedUnique(answer.claimContexts.map((context) => context.claimId));
    const revisionIds = sortedUnique(answer.claimContexts.map((context) => context.claimRevisionId));
    const synthesisRevisionIds = sortedUnique(answer.synthesisContexts.map((context) => context.synthesisRevisionId));
    const [placementRows, claimFacts, synthesisFacts] = await Promise.all([
      loadPlacementRows(project, claimIds),
      loadClaimFacts(project, revisionIds),
      loadSynthesisFacts(project, synthesisRevisionIds),
    ]);
    const placementsByClaim = new Map<string, PlacementRow[]>();
    for (const row of placementRows) placementsByClaim.set(row.claimId, [...(placementsByClaim.get(row.claimId) ?? []), row]);
    const claimContexts: AnswerClaimManuscriptContext[] = answer.claimContexts.map((context) => {
      const facts = claimFacts.get(context.claimRevisionId) ?? { supportCount: 0, citationCandidateCount: 0 };
      const exactActivePlacements: AnswerManuscriptPlacementLocation[] = [];
      const newerActivePlacements: AnswerManuscriptPlacementLocation[] = [];
      const olderActivePlacements: AnswerManuscriptPlacementLocation[] = [];
      const historicalPlacements: AnswerManuscriptPlacementLocation[] = [];
      for (const row of placementsByClaim.get(context.claimId) ?? []) {
        const location = placementLocation(row);
        if (row.removedAt) {
          historicalPlacements.push(location);
        } else if (row.claimRevisionId === context.claimRevisionId) {
          exactActivePlacements.push(location);
        } else if (row.claimRevisionSequence > context.claimRevisionSequence) {
          newerActivePlacements.push(location);
        } else {
          olderActivePlacements.push(location);
        }
      }
      const blockReason = !context.isCurrentRevision
        ? "superseded_context"
        : context.currentRevisionState !== "active"
          ? "withdrawn_claim"
          : context.supportStatus !== "supported"
            ? "unsupported_claim"
            : selectedSectionId && exactActivePlacements.some((location) => location.sectionId === selectedSectionId)
              ? "already_in_target_section"
              : null;
      return {
        claimId: context.claimId,
        claimRevisionId: context.claimRevisionId,
        claimRevisionSequence: context.claimRevisionSequence,
        claimText: context.claimText,
        claimRevisionState: context.claimRevisionState,
        isCurrentRevision: context.isCurrentRevision,
        currentRevisionId: context.currentRevisionId,
        currentRevisionSequence: context.currentRevisionSequence,
        currentClaimState: context.currentRevisionState,
        isCurrentlyLinked: context.isCurrentlyLinked,
        supportStatus: context.supportStatus,
        supportCount: facts.supportCount,
        citationCandidateCount: facts.citationCandidateCount,
        exactActivePlacements,
        newerActivePlacements,
        olderActivePlacements,
        historicalPlacements,
        selectable: blockReason == null,
        selectionBlockReason: blockReason,
      };
    });
    const synthesisFactsById = synthesisFacts;
    const synthesisContexts: AnswerSynthesisManuscriptContext[] = answer.synthesisContexts.map((context) => ({
      synthesisStatementId: context.synthesisStatementId,
      synthesisRevisionId: context.synthesisRevisionId,
      synthesisRevisionSequence: context.synthesisRevisionSequence,
      title: context.title,
      statementText: context.statementText,
      synthesisRevisionState: context.synthesisRevisionState,
      isCurrentRevision: context.isCurrentRevision,
      currentRevisionId: context.currentRevisionId,
      currentRevisionSequence: context.currentRevisionSequence,
      currentRevisionState: context.currentRevisionState,
      isCurrentlyLinked: context.isCurrentlyLinked,
      supportStatus: context.supportStatus,
      supportCount: synthesisFactsById.get(context.synthesisRevisionId)?.supportCount ?? 0,
      interpretation: synthesisFactsById.get(context.synthesisRevisionId)?.interpretation ?? null,
    }));
    return {
      projectId: project,
      researchQuestionId: questionId,
      researchQuestion: {
        id: questionId,
        identifier: String(questionRow.identifier),
        label: String(questionRow.label),
        archivedAt: date(questionRow.archived_at),
      },
      answer,
      manuscripts,
      selectedManuscriptId: selectedManuscript?.id ?? null,
      selectedSectionId,
      selectedSections,
      claimContexts,
      synthesisContexts,
    };
  }

  async function loadAnswerForApplication(tx: DbTransaction, projectId: string, questionId: string, answerId: string) {
    const questionRows = rows(await tx.execute(sql`
      select id from research_questions where project_id=${projectId} and id=${questionId} limit 1
    `));
    if (!questionRows.length) throw new DomainError("NOT_FOUND", "Research question was not found");
    const answerRows = rows(await tx.execute(sql`
      select id, project_id, research_question_id, finalized_at
      from research_question_answers
      where project_id=${projectId} and research_question_id=${questionId} and id=${answerId}
      limit 1
    `));
    const answer = answerRows[0];
    if (!answer) throw new DomainError("NOT_FOUND", "Finalized Research Question Answer was not found");
    if (answer.finalized_at == null) throw new DomainError("INELIGIBLE_REFERENCE", "Only finalized Answers can be used for manuscript drafting");
    const [claimContexts, synthesisContexts] = await Promise.all([
      tx.execute(sql`
        select claim_id, claim_revision_id, sort_order
        from research_question_answer_claim_contexts
        where project_id=${projectId} and research_question_id=${questionId} and answer_id=${answerId}
        order by sort_order, claim_revision_id
      `),
      tx.execute(sql`
        select synthesis_statement_id, synthesis_revision_id, sort_order
        from research_question_answer_synthesis_contexts
        where project_id=${projectId} and research_question_id=${questionId} and answer_id=${answerId}
        order by sort_order, synthesis_revision_id
      `),
    ]);
    return {
      claimContexts: rows(claimContexts).map((row) => ({ claimId: String(row.claim_id), claimRevisionId: String(row.claim_revision_id), sortOrder: Number(row.sort_order) })),
      synthesisContexts: rows(synthesisContexts).map((row) => ({ synthesisStatementId: String(row.synthesis_statement_id), synthesisRevisionId: String(row.synthesis_revision_id), sortOrder: Number(row.sort_order) })),
    };
  }

  async function applyResearchQuestionAnswerToSection(
    projectId: string,
    researchQuestionId: string,
    answerId: string,
    input: ApplyResearchQuestionAnswerToSectionInput,
  ) {
    const project = ensureId(projectId, "Project ID");
    const questionId = ensureId(researchQuestionId, "Research question ID");
    const exactAnswerId = ensureId(answerId, "Answer ID");
    const values = validate<ValidatedApplyResearchQuestionAnswerToSectionInput>(applyResearchQuestionAnswerToSectionSchema, input);
    const proseText = values.proseText != null && values.proseText.trim().length > 0 ? values.proseText : undefined;

    try {
      return await db.transaction(async (tx) => {
        const answer = await loadAnswerForApplication(tx, project, questionId, exactAnswerId);
        const contextByRevision = new Map(answer.claimContexts.map((context) => [context.claimRevisionId, context]));
        for (const revisionId of values.claimRevisionIds) {
          if (!contextByRevision.has(revisionId)) {
            throw new DomainError("INELIGIBLE_REFERENCE", `ClaimRevision ${revisionId} is not an exact context of this Answer`);
          }
        }

        const claimIds = sortedUnique(values.claimRevisionIds.map((revisionId) => contextByRevision.get(revisionId)!.claimId));
        if (claimIds.length) {
          const lockedClaims = rows(await tx.execute(sql`
            select id from claims
            where project_id=${project} and id in (${idList(claimIds)})
            order by id
            for update
          `)).map((row) => String(row.id));
          if (lockedClaims.length !== claimIds.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more Answer Claims do not belong to this project");
        }

        for (const revisionId of values.claimRevisionIds) {
          const context = contextByRevision.get(revisionId)!;
          const resolution = await dependencies.resolveClaimRevision(project, revisionId, tx);
          if (!resolution || resolution.projectId != null && resolution.projectId !== project || resolution.claimId !== context.claimId || resolution.revisionId !== revisionId) {
            throw new DomainError("CROSS_PROJECT_REFERENCE", `ClaimRevision ${revisionId} does not belong to this project`);
          }
          if (!isCurrentResolution(resolution, revisionId)) {
            throw new DomainError("VALIDATION_ERROR", `ClaimRevision ${revisionId} is no longer the current finalized revision; refresh Answer context`);
          }
          if (resolution.finalizedAt == null || resolution.state !== "active") {
            throw new DomainError("INELIGIBLE_REFERENCE", `ClaimRevision ${revisionId} must be a finalized active revision`);
          }
          if (resolution.supportStatus !== "supported") {
            throw new DomainError("INELIGIBLE_REFERENCE", `ClaimRevision ${revisionId} is not supported`);
          }
        }

        const manuscriptRows = rows(await tx.execute(sql`
          select id from manuscripts where project_id=${project} and id=${values.manuscriptId} limit 1
        `));
        if (!manuscriptRows.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
        await lockSection(tx, project, values.manuscriptId, values.sectionId);
        const sectionRows = rows(await tx.execute(sql`
          select id, archived_at
          from manuscript_sections
          where project_id=${project} and manuscript_id=${values.manuscriptId} and id=${values.sectionId}
          limit 1
        `));
        const section = sectionRows[0];
        if (!section) throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to this Manuscript");
        if (section.archived_at != null) throw new DomainError("INELIGIBLE_REFERENCE", "Archived Sections cannot receive manuscript content");

        const activeItems = await loadActiveSectionItems(tx, project, values.manuscriptId, values.sectionId);
        let position: number | undefined;
        if (values.insertion.kind === "append") {
          position = activeItems.length;
        } else {
          const anchorId = values.insertion.sectionItemId;
          const anchorRows = rows(await tx.execute(sql`
            select id, project_id, manuscript_id, section_id, removed_at
            from manuscript_section_items
            where id=${anchorId}
            limit 1
          `));
          const anchor = anchorRows[0];
          if (!anchor || String(anchor.project_id) !== project || String(anchor.manuscript_id) !== values.manuscriptId || String(anchor.section_id) !== values.sectionId) {
            throw new DomainError("CROSS_PROJECT_REFERENCE", "Insertion anchor does not belong to the target Section");
          }
          if (anchor.removed_at != null) throw new DomainError("VALIDATION_ERROR", "Insertion anchor is removed");
          position = activeItems.findIndex((item) => item.id === anchorId);
          if (position < 0) throw new DomainError("VALIDATION_ERROR", "Insertion anchor is not an active SectionItem");
        }

        if (values.claimRevisionIds.length) {
          const duplicateRows = rows(await tx.execute(sql`
            select claim_revision_id
            from manuscript_claim_placements
            where project_id=${project}
              and manuscript_id=${values.manuscriptId}
              and section_id=${values.sectionId}
              and removed_at is null
              and claim_revision_id in (${idList(values.claimRevisionIds)})
          `));
          if (duplicateRows.length) throw new DomainError("DUPLICATE_LINK", "One or more ClaimRevisions are already placed in this Section");
        }

        const plan = planSectionBlock({
          projectId: project,
          manuscriptId: values.manuscriptId,
          sectionId: values.sectionId,
          activeItems,
          position,
          proseText,
          claimRevisionIds: values.claimRevisionIds,
        });
        const written = await writeSectionBlock(tx, plan);
        return {
          manuscriptId: values.manuscriptId,
          sectionId: values.sectionId,
          proseSectionItemId: written.proseItem ? String(written.proseItem.id) : null,
          claimPlacements: written.placements.map((placement) => ({
            placementId: String(placement.id),
            sectionItemId: String(placement.id),
            claimRevisionId: String(placement.claim_revision_id),
          })),
        };
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", errorText(error));
      throw error;
    }
  }

  return { getResearchQuestionAnswerManuscriptProjection, applyResearchQuestionAnswerToSection };
}

export type ResearchQuestionAnswerManuscriptServices = ReturnType<typeof createResearchQuestionAnswerManuscriptServices>;
