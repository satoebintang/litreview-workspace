/*
 * Slice 21 Answer read models.
 *
 * Answer context rows are historical drafting context.  This module deliberately
 * does not read the formal support graph to decide support status: it delegates
 * that decision to the released Claim and Synthesis provenance resolvers.  The
 * only traceability state read here comes from the Slice 20 current-link
 * reducer, which is latest-event-first for each typed pair.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type {
  ClaimRevisionView,
  ClaimLifecycle,
  CurrentQuestionLinks,
  ProjectResearchQuestionAnswerFact,
  ProjectResearchQuestionAnswerFacts,
  ResearchQuestionAnswerCandidateProjection,
  ResearchQuestionAnswerClaimCandidate,
  ResearchQuestionAnswerClaimContextView,
  ResearchQuestionAnswerContextDriftFlag,
  ResearchQuestionAnswerProjection,
  ResearchQuestionAnswerSnapshot,
  ResearchQuestionAnswerSynthesisCandidate,
  ResearchQuestionAnswerSynthesisContextView,
  SynthesisProvenance,
  SynthesisState,
} from "@/domain/types";
import { idSchema } from "@/domain/validation";
import { ResearchQuestionTraceabilityRepository } from "./research-question-traceability-repository";

type CurrentClaimResult = {
  claim: { id: string; projectId: string; claimText?: string | null };
  currentRevision: AnswerClaimRevisionView;
};

type HistoricalClaimResult = {
  claim: { id: string; projectId: string; claimText?: string | null };
  revision: AnswerClaimRevisionView;
};

/** Only the released Claim fields needed by Answer context/read models. */
type AnswerClaimRevisionView = Pick<
  ClaimRevisionView,
  "id" | "sequence" | "lifecycle" | "claimText" | "finalizedAt" | "supportStatus" | "totalSupportCount"
>;

type CurrentSynthesisResult = SynthesisProvenance | null;
type HistoricalSynthesisResult = SynthesisProvenance;

export interface ResearchQuestionAnswerReadDependencies {
  /** Slice 20's authoritative latest-event-first reducer. */
  getCurrentLinksForQuestion?: (
    projectId: string,
    questionId: string,
  ) => Promise<CurrentQuestionLinks>;
  getCurrentLinksForProject?: (
    projectId: string,
    questionIds?: string[],
  ) => Promise<Map<string, CurrentQuestionLinks>>;

  /** Released Claim resolvers; these own Claim support semantics. */
  getCurrentClaim: (projectId: string, claimId: string) => Promise<CurrentClaimResult>;
  getClaimRevision: (
    projectId: string,
    claimId: string,
    revisionId: string,
  ) => Promise<HistoricalClaimResult>;

  /** Released Synthesis resolvers; these own Synthesis support semantics. */
  getCurrentSynthesis: (
    projectId: string,
    statementId: string,
  ) => Promise<CurrentSynthesisResult>;
  getSynthesisProvenance: (
    projectId: string,
    statementId: string,
    revisionId: string,
  ) => Promise<HistoricalSynthesisResult>;
}

type AnswerRow = {
  id: string;
  sequence: number | string | bigint;
  project_id: string;
  research_question_id: string;
  answer_text: string;
  researcher_note: string | null;
  created_at: Date | string;
  finalized_at: Date | string;
};

type ClaimContextRow = {
  project_id: string;
  research_question_id: string;
  answer_id: string;
  claim_id: string;
  claim_revision_id: string;
  sort_order: number;
  created_at: Date | string;
};

type SynthesisContextRow = {
  project_id: string;
  research_question_id: string;
  answer_id: string;
  synthesis_statement_id: string;
  synthesis_revision_id: string;
  sort_order: number;
  created_at: Date | string;
};

type CurrentClaimState = {
  result: CurrentClaimResult | null;
};

function ensureId(id: string, label = "Identifier"): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a valid UUID`, parsed.error.issues);
  }
  return parsed.data;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asNumber(value: number | string | bigint | null | undefined): number {
  return value == null ? 0 : Number(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isNotFound(error: unknown): boolean {
  return error instanceof DomainError && error.code === "NOT_FOUND";
}

function answerFromRow(row: AnswerRow): {
  id: string;
  sequence: number;
  projectId: string;
  researchQuestionId: string;
  answerText: string;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date;
} {
  return {
    id: String(row.id),
    sequence: asNumber(row.sequence),
    projectId: String(row.project_id),
    researchQuestionId: String(row.research_question_id),
    answerText: String(row.answer_text),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    createdAt: asDate(row.created_at),
    finalizedAt: asDate(row.finalized_at),
  };
}

function contextFlags(
  kind: "claim" | "synthesis",
  isCurrentRevision: boolean,
  currentState: ClaimLifecycle | SynthesisState | null,
  isCurrentlyLinked: boolean,
): ResearchQuestionAnswerContextDriftFlag[] {
  const flags: ResearchQuestionAnswerContextDriftFlag[] = [];
  if (!isCurrentRevision) {
    flags.push(kind === "claim" ? "referenced_claim_revision_superseded" : "referenced_synthesis_revision_superseded");
  }
  if (currentState === "withdrawn") {
    flags.push(kind === "claim" ? "referenced_claim_now_withdrawn" : "referenced_synthesis_now_withdrawn");
  }
  if (!isCurrentlyLinked) {
    flags.push(kind === "claim" ? "referenced_claim_no_longer_linked_to_rq" : "referenced_synthesis_no_longer_linked_to_rq");
  }
  return flags;
}

function emptyLinks(): CurrentQuestionLinks {
  return {
    extractionFieldIds: [],
    evidenceSetIds: [],
    synthesisStatementIds: [],
    claimIds: [],
  };
}

export function createResearchQuestionAnswerReadServices(
  db: Database,
  dependencies: ResearchQuestionAnswerReadDependencies,
) {
  const traceabilityRepo = new ResearchQuestionTraceabilityRepository(db);
  const getCurrentLinksForQuestion = dependencies.getCurrentLinksForQuestion
    ?? ((projectId: string, questionId: string) => traceabilityRepo.listCurrentLinksForQuestion(projectId, questionId));
  const getCurrentLinksForProject = dependencies.getCurrentLinksForProject
    ?? ((projectId: string, questionIds?: string[]) => traceabilityRepo.listCurrentLinksForProject(projectId, questionIds));

  async function requireQuestion(projectId: string, questionId: string) {
    const rows = await db.execute(sql`
      select id, project_id, identifier, label, sort_order, created_at, updated_at, archived_at
      from research_questions
      where project_id = ${projectId} and id = ${questionId}
      limit 1
    `) as unknown as Record<string, unknown>[];
    if (!rows.length) throw new DomainError("NOT_FOUND", "Research question was not found");
    return rows[0];
  }

  async function requireProject(projectId: string) {
    const rows = await db.execute(sql`
      select id from projects where id = ${projectId} limit 1
    `) as unknown as Record<string, unknown>[];
    if (!rows.length) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
  }

  async function loadAnswerRows(projectId: string, questionId: string, answerId?: string): Promise<AnswerRow[]> {
    const answerFilter = answerId ? sql`and a.id = ${answerId}` : sql``;
    const rows = await db.execute(sql`
      select a.id, a.sequence, a.project_id, a.research_question_id,
             a.answer_text, a.researcher_note, a.created_at, a.finalized_at
      from research_question_answers a
      where a.project_id = ${projectId}
        and a.research_question_id = ${questionId}
        and a.finalized_at is not null
        ${answerFilter}
      order by a.sequence desc, a.id desc
    `);
    return rows as unknown as AnswerRow[];
  }

  async function loadContextRows(
    projectId: string,
    questionId: string,
    answerIds: string[],
  ): Promise<{ claims: ClaimContextRow[]; syntheses: SynthesisContextRow[] }> {
    if (!answerIds.length) return { claims: [], syntheses: [] };
    const answerIdList = sql.join(answerIds.map((id) => sql`${id}::uuid`), sql`, `);
    const [claimRows, synthesisRows] = await Promise.all([
      db.execute(sql`
        select project_id, research_question_id, answer_id, claim_id,
               claim_revision_id, sort_order, created_at
        from research_question_answer_claim_contexts
        where project_id = ${projectId}
          and research_question_id = ${questionId}
          and answer_id in (${answerIdList})
        order by answer_id, sort_order, claim_revision_id
      `),
      db.execute(sql`
        select project_id, research_question_id, answer_id,
               synthesis_statement_id, synthesis_revision_id, sort_order, created_at
        from research_question_answer_synthesis_contexts
        where project_id = ${projectId}
          and research_question_id = ${questionId}
          and answer_id in (${answerIdList})
        order by answer_id, sort_order, synthesis_revision_id
      `),
    ]);
    return {
      claims: claimRows as unknown as ClaimContextRow[],
      syntheses: synthesisRows as unknown as SynthesisContextRow[],
    };
  }

  async function loadInterpretationRevisionIds(projectId: string, revisionIds: string[]): Promise<Set<string>> {
    if (!revisionIds.length) return new Set();
    const rows = await db.execute(sql`
      select distinct synthesis_revision_id
      from synthesis_interpretations
      where project_id = ${projectId}
        and finalized_at is not null
        and synthesis_revision_id in (${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `) as unknown as Record<string, unknown>[];
    return new Set(rows.map((row) => String(row.synthesis_revision_id)));
  }

  async function loadCurrentClaims(projectId: string, claimIds: string[]): Promise<Map<string, CurrentClaimState>> {
    const map = new Map<string, CurrentClaimState>();
    await Promise.all(sortedUnique(claimIds).map(async (claimId) => {
      try {
        const result = await dependencies.getCurrentClaim(projectId, claimId);
        map.set(claimId, { result });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        map.set(claimId, { result: null });
      }
    }));
    return map;
  }

  async function loadCurrentSyntheses(projectId: string, statementIds: string[]): Promise<Map<string, CurrentSynthesisResult>> {
    const map = new Map<string, CurrentSynthesisResult>();
    await Promise.all(sortedUnique(statementIds).map(async (statementId) => {
      map.set(statementId, await dependencies.getCurrentSynthesis(projectId, statementId));
    }));
    return map;
  }

  async function getExactClaimView(
    projectId: string,
    context: ClaimContextRow,
    currentClaims: Map<string, CurrentClaimState>,
    historicalCache: Map<string, Promise<HistoricalClaimResult>>,
  ): Promise<{ exact: AnswerClaimRevisionView; current: AnswerClaimRevisionView | null; claimProjectId: string }> {
    const currentState = currentClaims.get(context.claim_id);
    if (!currentState) throw new DomainError("DATABASE_CONSTRAINT", "Claim resolver did not return a result");
    const current = currentState.result?.currentRevision ?? null;
    if (current && String(current.id) === String(context.claim_revision_id)) {
      return {
        exact: current,
        current,
        claimProjectId: String(currentState.result?.claim.projectId ?? projectId),
      };
    }
    const cacheKey = `${context.claim_id}:${context.claim_revision_id}`;
    let historicalPromise = historicalCache.get(cacheKey);
    if (!historicalPromise) {
      historicalPromise = dependencies.getClaimRevision(projectId, context.claim_id, context.claim_revision_id);
      historicalCache.set(cacheKey, historicalPromise);
    }
    const historical = await historicalPromise;
    return {
      exact: historical.revision,
      current,
      claimProjectId: String(historical.claim.projectId ?? projectId),
    };
  }

  async function getExactSynthesisView(
    projectId: string,
    context: SynthesisContextRow,
    currentSyntheses: Map<string, CurrentSynthesisResult>,
    historicalPromise?: Promise<HistoricalSynthesisResult>,
  ): Promise<{ exact: SynthesisProvenance; current: SynthesisProvenance | null; statementProjectId: string }> {
    const current = currentSyntheses.get(context.synthesis_statement_id) ?? null;
    if (current && String(current.id) === String(context.synthesis_revision_id)) {
      return { exact: current, current, statementProjectId: String(current.statement.projectId ?? projectId) };
    }
    const historical = await (historicalPromise ?? dependencies.getSynthesisProvenance(
      projectId,
      context.synthesis_statement_id,
      context.synthesis_revision_id,
    ));
    return {
      exact: historical,
      current,
      statementProjectId: String(historical.statement.projectId ?? projectId),
    };
  }

  async function buildClaimContextViews(
    projectId: string,
    links: CurrentQuestionLinks,
    rows: ClaimContextRow[],
    currentClaims: Map<string, CurrentClaimState>,
    historicalCache: Map<string, Promise<HistoricalClaimResult>>,
  ): Promise<ResearchQuestionAnswerClaimContextView[]> {
    const views = await Promise.all(rows.map(async (row) => {
      const { exact, current, claimProjectId } = await getExactClaimView(projectId, row, currentClaims, historicalCache);
      if (claimProjectId !== projectId) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim context does not belong to this project");
      }
      const isCurrentRevision = current != null && String(current.id) === String(row.claim_revision_id);
      const isCurrentlyLinked = links.claimIds.some((id) => String(id) === String(row.claim_id));
      return {
        projectId: String(row.project_id),
        researchQuestionId: String(row.research_question_id),
        answerId: String(row.answer_id),
        claimId: String(row.claim_id),
        claimRevisionId: String(row.claim_revision_id),
        sortOrder: Number(row.sort_order),
        createdAt: asDate(row.created_at),
        claimText: exact.claimText,
        claimRevisionSequence: Number(exact.sequence),
        claimRevisionState: exact.lifecycle,
        isCurrentRevision,
        currentRevisionId: current ? String(current.id) : null,
        currentRevisionSequence: current ? Number(current.sequence) : null,
        currentRevisionState: current ? current.lifecycle : null,
        isCurrentlyLinked,
        supportStatus: exact.supportStatus,
        driftFlags: contextFlags("claim", isCurrentRevision, current?.lifecycle ?? null, isCurrentlyLinked),
      } satisfies ResearchQuestionAnswerClaimContextView;
    }));
    return views.sort((left, right) => left.sortOrder - right.sortOrder || left.claimRevisionId.localeCompare(right.claimRevisionId));
  }

  async function buildSynthesisContextViews(
    projectId: string,
    links: CurrentQuestionLinks,
    rows: SynthesisContextRow[],
    currentSyntheses: Map<string, CurrentSynthesisResult>,
    interpretationIds: Set<string>,
    historicalCache: Map<string, Promise<HistoricalSynthesisResult>>,
  ): Promise<ResearchQuestionAnswerSynthesisContextView[]> {
    const views = await Promise.all(rows.map(async (row) => {
      const cacheKey = `${row.synthesis_statement_id}:${row.synthesis_revision_id}`;
      const currentCandidate = currentSyntheses.get(row.synthesis_statement_id) ?? null;
      let historicalPromise: Promise<HistoricalSynthesisResult> | undefined;
      if (!currentCandidate || String(currentCandidate.id) !== String(row.synthesis_revision_id)) {
        historicalPromise = historicalCache.get(cacheKey);
        if (!historicalPromise) {
          historicalPromise = dependencies.getSynthesisProvenance(projectId, row.synthesis_statement_id, row.synthesis_revision_id);
          historicalCache.set(cacheKey, historicalPromise);
        }
      }
      const { exact, current, statementProjectId } = await getExactSynthesisView(projectId, row, currentSyntheses, historicalPromise);
      if (statementProjectId !== projectId) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis context does not belong to this project");
      }
      const isCurrentRevision = current != null && String(current.id) === String(row.synthesis_revision_id);
      const isCurrentlyLinked = links.synthesisStatementIds.some((id) => String(id) === String(row.synthesis_statement_id));
      return {
        projectId: String(row.project_id),
        researchQuestionId: String(row.research_question_id),
        answerId: String(row.answer_id),
        synthesisStatementId: String(row.synthesis_statement_id),
        synthesisRevisionId: String(row.synthesis_revision_id),
        sortOrder: Number(row.sort_order),
        createdAt: asDate(row.created_at),
        title: exact.title,
        statementText: exact.statementText,
        synthesisRevisionSequence: Number(exact.sequence),
        synthesisRevisionState: exact.state,
        isCurrentRevision,
        currentRevisionId: current ? String(current.id) : null,
        currentRevisionSequence: current ? Number(current.sequence) : null,
        currentRevisionState: current ? current.state : null,
        isCurrentlyLinked,
        supportStatus: exact.supportStatus,
        interpretationAvailable: interpretationIds.has(String(row.synthesis_revision_id)),
        driftFlags: contextFlags("synthesis", isCurrentRevision, current?.state ?? null, isCurrentlyLinked),
      } satisfies ResearchQuestionAnswerSynthesisContextView;
    }));
    return views.sort((left, right) => left.sortOrder - right.sortOrder || left.synthesisRevisionId.localeCompare(right.synthesisRevisionId));
  }

  async function buildSnapshots(
    projectId: string,
    questionId: string,
    answerRows: AnswerRow[],
    claimRows: ClaimContextRow[],
    synthesisRows: SynthesisContextRow[],
    links: CurrentQuestionLinks,
  ): Promise<ResearchQuestionAnswerSnapshot[]> {
    const claimIds = sortedUnique(claimRows.map((row) => String(row.claim_id)));
    const statementIds = sortedUnique(synthesisRows.map((row) => String(row.synthesis_statement_id)));
    const synthesisRevisionIds = sortedUnique(synthesisRows.map((row) => String(row.synthesis_revision_id)));
    const [currentClaims, currentSyntheses, interpretationIds] = await Promise.all([
      loadCurrentClaims(projectId, claimIds),
      loadCurrentSyntheses(projectId, statementIds),
      loadInterpretationRevisionIds(projectId, synthesisRevisionIds),
    ]);

    const claimsByAnswer = new Map<string, ClaimContextRow[]>();
    const synthesesByAnswer = new Map<string, SynthesisContextRow[]>();
    const historicalClaimCache = new Map<string, Promise<HistoricalClaimResult>>();
    const historicalSynthesisCache = new Map<string, Promise<HistoricalSynthesisResult>>();
    for (const row of claimRows) claimsByAnswer.set(String(row.answer_id), [...(claimsByAnswer.get(String(row.answer_id)) ?? []), row]);
    for (const row of synthesisRows) synthesesByAnswer.set(String(row.answer_id), [...(synthesesByAnswer.get(String(row.answer_id)) ?? []), row]);

    return Promise.all(answerRows.map(async (row) => {
      const answer = answerFromRow(row);
      const [claimContexts, synthesisContexts] = await Promise.all([
        buildClaimContextViews(projectId, links, claimsByAnswer.get(answer.id) ?? [], currentClaims, historicalClaimCache),
        buildSynthesisContextViews(projectId, links, synthesesByAnswer.get(answer.id) ?? [], currentSyntheses, interpretationIds, historicalSynthesisCache),
      ]);
      return {
        ...answer,
        claimContexts,
        synthesisContexts,
      } satisfies ResearchQuestionAnswerSnapshot;
    }));
  }

  function candidateReason(input: {
    projectMatches: boolean;
    revisionExists: boolean;
    revisionIsCurrent: boolean;
    revisionState: ClaimLifecycle | SynthesisState | null;
    supportStatus: "supported" | "unsupported";
  }): ResearchQuestionAnswerClaimCandidate["reason"] {
    if (!input.projectMatches) return "cross_project";
    if (!input.revisionExists) return "no_finalized_revision";
    if (!input.revisionIsCurrent) return "revision_not_current";
    if (input.revisionState === "withdrawn") return "withdrawn";
    if (input.supportStatus !== "supported") return "unsupported";
    return null;
  }

  async function listResearchQuestionAnswerCandidates(
    projectId: string,
    questionId: string,
  ): Promise<ResearchQuestionAnswerCandidateProjection> {
    ensureId(projectId, "Project ID");
    ensureId(questionId, "Research question ID");
    await requireQuestion(projectId, questionId);
    // This is the only source of candidate target IDs.  In particular, do not
    // independently filter traceability events to action='linked'.
    const links = await getCurrentLinksForQuestion(projectId, questionId);
    const claimIds = sortedUnique(links.claimIds.map(String));
    const statementIds = sortedUnique(links.synthesisStatementIds.map(String));
    const [currentClaims, currentSyntheses] = await Promise.all([
      loadCurrentClaims(projectId, claimIds),
      loadCurrentSyntheses(projectId, statementIds),
    ]);
    const interpretationIds = await loadInterpretationRevisionIds(
      projectId,
      sortedUnique([...currentSyntheses.values()].flatMap((value) => value ? [String(value.id)] : [])),
    );

    const claims: ResearchQuestionAnswerClaimCandidate[] = claimIds.map((claimId) => {
      const state = currentClaims.get(claimId);
      const revision = state?.result?.currentRevision ?? null;
      const projectMatches = state?.result?.claim.projectId === undefined || state.result.claim.projectId === projectId;
      const supportStatus = revision?.supportStatus ?? "unsupported";
      const revisionState = revision?.lifecycle ?? null;
      const revisionExists = revision != null && revision.finalizedAt != null;
      const reason = candidateReason({
        projectMatches,
        revisionExists,
        revisionIsCurrent: revisionExists,
        revisionState,
        supportStatus,
      });
      return {
        projectId,
        researchQuestionId: questionId,
        targetType: "claim",
        targetId: claimId,
        revisionId: revision ? String(revision.id) : null,
        revisionSequence: revision ? Number(revision.sequence) : null,
        revisionState,
        finalizedAt: revision?.finalizedAt ?? null,
        isCurrentlyLinked: true,
        isCurrentRevision: revisionExists,
        supportStatus,
        supportCount: revision?.totalSupportCount ?? 0,
        isSelectable: reason === null,
        reason,
      };
    });

    const syntheses: ResearchQuestionAnswerSynthesisCandidate[] = statementIds.map((statementId) => {
      const revision = currentSyntheses.get(statementId) ?? null;
      const projectMatches = revision == null || revision.statement.projectId === projectId;
      const revisionExists = revision != null && revision.finalizedAt != null;
      const supportStatus = revision?.supportStatus ?? "unsupported";
      const revisionState = revision?.state ?? null;
      const reason = candidateReason({
        projectMatches,
        revisionExists,
        revisionIsCurrent: revisionExists,
        revisionState,
        supportStatus,
      });
      return {
        projectId,
        researchQuestionId: questionId,
        targetType: "synthesis",
        targetId: statementId,
        revisionId: revision ? String(revision.id) : null,
        revisionSequence: revision ? Number(revision.sequence) : null,
        revisionState,
        finalizedAt: revision?.finalizedAt ?? null,
        isCurrentlyLinked: true,
        isCurrentRevision: revisionExists,
        supportStatus,
        supportCount: revision?.supportingRevisionCount ?? 0,
        isSelectable: reason === null,
        reason,
        interpretationAvailable: revision ? interpretationIds.has(String(revision.id)) : false,
      };
    });
    return { claims, syntheses };
  }

  async function getResearchQuestionAnswerProjection(
    projectId: string,
    questionId: string,
  ): Promise<ResearchQuestionAnswerProjection> {
    ensureId(projectId, "Project ID");
    ensureId(questionId, "Research question ID");
    await requireQuestion(projectId, questionId);
    const [answerRows, links] = await Promise.all([
      loadAnswerRows(projectId, questionId),
      getCurrentLinksForQuestion(projectId, questionId),
    ]);
    const contexts = await loadContextRows(projectId, questionId, answerRows.map((row) => String(row.id)));
    const history = await buildSnapshots(projectId, questionId, answerRows, contexts.claims, contexts.syntheses, links);
    return {
      latestAnswer: history[0] ?? null,
      history,
      finalizedAnswerCount: history.length,
      latestAnswerSequence: history[0]?.sequence ?? null,
    };
  }

  async function getResearchQuestionAnswerSnapshot(
    projectId: string,
    questionId: string,
    answerId: string,
  ): Promise<ResearchQuestionAnswerSnapshot> {
    ensureId(projectId, "Project ID");
    ensureId(questionId, "Research question ID");
    ensureId(answerId, "Answer ID");
    await requireQuestion(projectId, questionId);
    const [answerRows, links] = await Promise.all([
      loadAnswerRows(projectId, questionId, answerId),
      getCurrentLinksForQuestion(projectId, questionId),
    ]);
    if (!answerRows.length) throw new DomainError("NOT_FOUND", "Finalized Research Question Answer was not found");
    const contexts = await loadContextRows(projectId, questionId, [answerId]);
    const [snapshot] = await buildSnapshots(projectId, questionId, answerRows, contexts.claims, contexts.syntheses, links);
    if (!snapshot) throw new DomainError("NOT_FOUND", "Finalized Research Question Answer was not found");
    return snapshot;
  }

  async function getProjectResearchQuestionAnswerFacts(
    projectId: string,
  ): Promise<ProjectResearchQuestionAnswerFacts> {
    ensureId(projectId, "Project ID");
    await requireProject(projectId);
    const questionRows = await db.execute(sql`
      select id, sort_order
      from research_questions
      where project_id = ${projectId}
      order by sort_order, id
    `) as unknown as Record<string, unknown>[];
    if (!questionRows.length) return { rows: [] };
    const questionIds = questionRows.map((row) => String(row.id));
    const answerRows = await db.execute(sql`
      select a.id, a.sequence, a.project_id, a.research_question_id,
             a.answer_text, a.researcher_note, a.created_at, a.finalized_at
      from research_question_answers a
      where a.project_id = ${projectId}
        and a.research_question_id in (${sql.join(questionIds.map((id) => sql`${id}::uuid`), sql`, `)})
        and a.finalized_at is not null
      order by a.research_question_id, a.sequence desc, a.id desc
    `) as unknown as AnswerRow[];
    // Facts need one project-wide batch, so issue the same two context queries
    // directly rather than performing one query per ResearchQuestion.
    const answerIds = answerRows.map((row) => String(row.id));
    let allContexts: { claims: ClaimContextRow[]; syntheses: SynthesisContextRow[] } = { claims: [], syntheses: [] };
    if (answerIds.length) {
      const answerIdList = sql.join(answerIds.map((id) => sql`${id}::uuid`), sql`, `);
      const [claimRows, synthesisRows] = await Promise.all([
        db.execute(sql`
          select project_id, research_question_id, answer_id, claim_id,
                 claim_revision_id, sort_order, created_at
          from research_question_answer_claim_contexts
          where project_id = ${projectId} and answer_id in (${answerIdList})
          order by research_question_id, answer_id, sort_order, claim_revision_id
        `),
        db.execute(sql`
          select project_id, research_question_id, answer_id,
                 synthesis_statement_id, synthesis_revision_id, sort_order, created_at
          from research_question_answer_synthesis_contexts
          where project_id = ${projectId} and answer_id in (${answerIdList})
          order by research_question_id, answer_id, sort_order, synthesis_revision_id
        `),
      ]);
      allContexts = {
        claims: claimRows as unknown as ClaimContextRow[],
        syntheses: synthesisRows as unknown as SynthesisContextRow[],
      };
    }
    const projectLinks = await getCurrentLinksForProject(projectId, questionIds);
    const currentClaims = await loadCurrentClaims(projectId, sortedUnique(allContexts.claims.map((row) => String(row.claim_id))));
    const currentSyntheses = await loadCurrentSyntheses(projectId, sortedUnique(allContexts.syntheses.map((row) => String(row.synthesis_statement_id))));

    const claimByAnswer = new Map<string, ClaimContextRow[]>();
    const synthesisByAnswer = new Map<string, SynthesisContextRow[]>();
    for (const row of allContexts.claims) claimByAnswer.set(String(row.answer_id), [...(claimByAnswer.get(String(row.answer_id)) ?? []), row]);
    for (const row of allContexts.syntheses) synthesisByAnswer.set(String(row.answer_id), [...(synthesisByAnswer.get(String(row.answer_id)) ?? []), row]);

    const rowsByQuestion = new Map<string, ProjectResearchQuestionAnswerFact>();
    for (const questionId of questionIds) {
      rowsByQuestion.set(questionId, {
        researchQuestionId: questionId,
        finalizedAnswerCount: 0,
        latestAnswerSequence: null,
        claimContextCount: 0,
        synthesisContextCount: 0,
        derivedDriftCount: 0,
      });
    }
    for (const row of answerRows) {
      const questionFact = rowsByQuestion.get(String(row.research_question_id));
      if (!questionFact) continue;
      questionFact.finalizedAnswerCount += 1;
      if (questionFact.latestAnswerSequence == null) questionFact.latestAnswerSequence = asNumber(row.sequence);
      const links = projectLinks.get(String(row.research_question_id)) ?? emptyLinks();
      for (const context of claimByAnswer.get(String(row.id)) ?? []) {
        questionFact.claimContextCount += 1;
        const state = currentClaims.get(String(context.claim_id));
        const current = state?.result?.currentRevision ?? null;
        const isCurrent = current != null && String(current.id) === String(context.claim_revision_id);
        const linked = links.claimIds.some((id) => String(id) === String(context.claim_id));
        if (contextFlags("claim", isCurrent, current?.lifecycle ?? null, linked).length > 0) questionFact.derivedDriftCount += 1;
      }
      for (const context of synthesisByAnswer.get(String(row.id)) ?? []) {
        questionFact.synthesisContextCount += 1;
        const current = currentSyntheses.get(String(context.synthesis_statement_id)) ?? null;
        const isCurrent = current != null && String(current.id) === String(context.synthesis_revision_id);
        const linked = links.synthesisStatementIds.some((id) => String(id) === String(context.synthesis_statement_id));
        if (contextFlags("synthesis", isCurrent, current?.state ?? null, linked).length > 0) questionFact.derivedDriftCount += 1;
      }
    }
    return { rows: questionIds.map((questionId) => rowsByQuestion.get(questionId)!).filter(Boolean) };
  }

  return {
    getResearchQuestionAnswerProjection,
    getResearchQuestionAnswerSnapshot,
    listResearchQuestionAnswerCandidates,
    getProjectResearchQuestionAnswerFacts,
  };
}

export type ResearchQuestionAnswerReadServices = ReturnType<typeof createResearchQuestionAnswerReadServices>;
