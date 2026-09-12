/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  researchQuestionExtractionFieldEvents,
  researchQuestionEvidenceSetEvents,
  researchQuestionSynthesisStatementEvents,
  researchQuestionClaimEvents,
} from "@/db/schema";
import type {
  CurrentQuestionLinks,
  ResearchQuestionExtractionFieldEvent,
  ResearchQuestionEvidenceSetEvent,
  ResearchQuestionSynthesisStatementEvent,
  ResearchQuestionClaimEvent,
  TraceabilityAction,
} from "@/domain/types";

export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | DbTransaction;

export interface CurrentTargetLink<T = string> {
  targetId: T;
  sequence: number;
  note: string | null;
  linkedAt: Date;
}

export class ResearchQuestionTraceabilityRepository {
  constructor(private readonly db: Database) {}

  /**
   * Single authoritative current-link reducer for a single research question.
   * Latest event per (project, question, target) by sequence DESC, filtered to action = 'linked'.
   */
  async listCurrentLinksForQuestion(
    projectId: string,
    questionId: string,
    tx: DbOrTx = this.db,
  ): Promise<CurrentQuestionLinks> {
    const [fieldRows, setRows, stmtRows, claimRows] = await Promise.all([
      (tx as any).execute(sql`
        select distinct on (extraction_field_id) extraction_field_id, action
        from research_question_extraction_field_events
        where project_id = ${projectId} and research_question_id = ${questionId}
        order by extraction_field_id, sequence desc
      `),
      (tx as any).execute(sql`
        select distinct on (evidence_set_id) evidence_set_id, action
        from research_question_evidence_set_events
        where project_id = ${projectId} and research_question_id = ${questionId}
        order by evidence_set_id, sequence desc
      `),
      (tx as any).execute(sql`
        select distinct on (synthesis_statement_id) synthesis_statement_id, action
        from research_question_synthesis_statement_events
        where project_id = ${projectId} and research_question_id = ${questionId}
        order by synthesis_statement_id, sequence desc
      `),
      (tx as any).execute(sql`
        select distinct on (claim_id) claim_id, action
        from research_question_claim_events
        where project_id = ${projectId} and research_question_id = ${questionId}
        order by claim_id, sequence desc
      `),
    ]);

    return {
      extractionFieldIds: (fieldRows as any[])
        .filter((r) => r.action === "linked")
        .map((r) => String(r.extraction_field_id)),
      evidenceSetIds: (setRows as any[])
        .filter((r) => r.action === "linked")
        .map((r) => String(r.evidence_set_id)),
      synthesisStatementIds: (stmtRows as any[])
        .filter((r) => r.action === "linked")
        .map((r) => String(r.synthesis_statement_id)),
      claimIds: (claimRows as any[])
        .filter((r) => r.action === "linked")
        .map((r) => String(r.claim_id)),
    };
  }

  /**
   * Project-wide current-link reducer mapping questionId -> CurrentQuestionLinks.
   */
  async listCurrentLinksForProject(
    projectId: string,
    questionIds?: string[],
    tx: DbOrTx = this.db,
  ): Promise<Map<string, CurrentQuestionLinks>> {
    const result = new Map<string, CurrentQuestionLinks>();

    if (questionIds) {
      for (const qId of questionIds) {
        result.set(qId, {
          extractionFieldIds: [],
          evidenceSetIds: [],
          synthesisStatementIds: [],
          claimIds: [],
        });
      }
    }

    const [fieldRows, setRows, stmtRows, claimRows] = await Promise.all([
      (tx as any).execute(sql`
        select distinct on (research_question_id, extraction_field_id) research_question_id, extraction_field_id, action
        from research_question_extraction_field_events
        where project_id = ${projectId}
        order by research_question_id, extraction_field_id, sequence desc
      `),
      (tx as any).execute(sql`
        select distinct on (research_question_id, evidence_set_id) research_question_id, evidence_set_id, action
        from research_question_evidence_set_events
        where project_id = ${projectId}
        order by research_question_id, evidence_set_id, sequence desc
      `),
      (tx as any).execute(sql`
        select distinct on (research_question_id, synthesis_statement_id) research_question_id, synthesis_statement_id, action
        from research_question_synthesis_statement_events
        where project_id = ${projectId}
        order by research_question_id, synthesis_statement_id, sequence desc
      `),
      (tx as any).execute(sql`
        select distinct on (research_question_id, claim_id) research_question_id, claim_id, action
        from research_question_claim_events
        where project_id = ${projectId}
        order by research_question_id, claim_id, sequence desc
      `),
    ]);

    function ensureEntry(qId: string): CurrentQuestionLinks {
      let entry = result.get(qId);
      if (!entry) {
        entry = {
          extractionFieldIds: [],
          evidenceSetIds: [],
          synthesisStatementIds: [],
          claimIds: [],
        };
        result.set(qId, entry);
      }
      return entry;
    }

    for (const r of fieldRows as any[]) {
      if (r.action === "linked") {
        ensureEntry(String(r.research_question_id)).extractionFieldIds.push(String(r.extraction_field_id));
      }
    }
    for (const r of setRows as any[]) {
      if (r.action === "linked") {
        ensureEntry(String(r.research_question_id)).evidenceSetIds.push(String(r.evidence_set_id));
      }
    }
    for (const r of stmtRows as any[]) {
      if (r.action === "linked") {
        ensureEntry(String(r.research_question_id)).synthesisStatementIds.push(String(r.synthesis_statement_id));
      }
    }
    for (const r of claimRows as any[]) {
      if (r.action === "linked") {
        ensureEntry(String(r.research_question_id)).claimIds.push(String(r.claim_id));
      }
    }

    return result;
  }

  /**
   * Detailed current links with metadata (sequence, note, linkedAt)
   */
  async listCurrentExtractionFieldLinks(
    projectId: string,
    questionId: string,
    tx: DbOrTx = this.db,
  ): Promise<CurrentTargetLink<string>[]> {
    const rows = await (tx as any).execute(sql`
      select distinct on (extraction_field_id) extraction_field_id, action, sequence, created_at, note
      from research_question_extraction_field_events
      where project_id = ${projectId} and research_question_id = ${questionId}
      order by extraction_field_id, sequence desc
    `);
    return (rows as any[])
      .filter((r) => r.action === "linked")
      .map((r) => ({
        targetId: String(r.extraction_field_id),
        sequence: Number(r.sequence),
        note: r.note ?? null,
        linkedAt: new Date(r.created_at),
      }));
  }

  async listCurrentEvidenceSetLinks(
    projectId: string,
    questionId: string,
    tx: DbOrTx = this.db,
  ): Promise<CurrentTargetLink<string>[]> {
    const rows = await (tx as any).execute(sql`
      select distinct on (evidence_set_id) evidence_set_id, action, sequence, created_at, note
      from research_question_evidence_set_events
      where project_id = ${projectId} and research_question_id = ${questionId}
      order by evidence_set_id, sequence desc
    `);
    return (rows as any[])
      .filter((r) => r.action === "linked")
      .map((r) => ({
        targetId: String(r.evidence_set_id),
        sequence: Number(r.sequence),
        note: r.note ?? null,
        linkedAt: new Date(r.created_at),
      }));
  }

  async listCurrentSynthesisStatementLinks(
    projectId: string,
    questionId: string,
    tx: DbOrTx = this.db,
  ): Promise<CurrentTargetLink<string>[]> {
    const rows = await (tx as any).execute(sql`
      select distinct on (synthesis_statement_id) synthesis_statement_id, action, sequence, created_at, note
      from research_question_synthesis_statement_events
      where project_id = ${projectId} and research_question_id = ${questionId}
      order by synthesis_statement_id, sequence desc
    `);
    return (rows as any[])
      .filter((r) => r.action === "linked")
      .map((r) => ({
        targetId: String(r.synthesis_statement_id),
        sequence: Number(r.sequence),
        note: r.note ?? null,
        linkedAt: new Date(r.created_at),
      }));
  }

  async listCurrentClaimLinks(
    projectId: string,
    questionId: string,
    tx: DbOrTx = this.db,
  ): Promise<CurrentTargetLink<string>[]> {
    const rows = await (tx as any).execute(sql`
      select distinct on (claim_id) claim_id, action, sequence, created_at, note
      from research_question_claim_events
      where project_id = ${projectId} and research_question_id = ${questionId}
      order by claim_id, sequence desc
    `);
    return (rows as any[])
      .filter((r) => r.action === "linked")
      .map((r) => ({
        targetId: String(r.claim_id),
        sequence: Number(r.sequence),
        note: r.note ?? null,
        linkedAt: new Date(r.created_at),
      }));
  }

  /**
   * Chronological event history for specific targets or all targets of a question.
   */
  async listExtractionFieldEvents(
    projectId: string,
    questionId: string,
    extractionFieldId?: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionExtractionFieldEvent[]> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, extraction_field_id, action, note, created_at
      from research_question_extraction_field_events
      where project_id = ${projectId} and research_question_id = ${questionId}
        ${extractionFieldId ? sql`and extraction_field_id = ${extractionFieldId}` : sql``}
      order by sequence asc
    `);
    return (rows as any[]).map((r) => ({
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      extractionFieldId: String(r.extraction_field_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    }));
  }

  async listEvidenceSetEvents(
    projectId: string,
    questionId: string,
    evidenceSetId?: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionEvidenceSetEvent[]> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, evidence_set_id, action, note, created_at
      from research_question_evidence_set_events
      where project_id = ${projectId} and research_question_id = ${questionId}
        ${evidenceSetId ? sql`and evidence_set_id = ${evidenceSetId}` : sql``}
      order by sequence asc
    `);
    return (rows as any[]).map((r) => ({
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      evidenceSetId: String(r.evidence_set_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    }));
  }

  async listSynthesisStatementEvents(
    projectId: string,
    questionId: string,
    synthesisStatementId?: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionSynthesisStatementEvent[]> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, synthesis_statement_id, action, note, created_at
      from research_question_synthesis_statement_events
      where project_id = ${projectId} and research_question_id = ${questionId}
        ${synthesisStatementId ? sql`and synthesis_statement_id = ${synthesisStatementId}` : sql``}
      order by sequence asc
    `);
    return (rows as any[]).map((r) => ({
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      synthesisStatementId: String(r.synthesis_statement_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    }));
  }

  async listClaimEvents(
    projectId: string,
    questionId: string,
    claimId?: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionClaimEvent[]> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, claim_id, action, note, created_at
      from research_question_claim_events
      where project_id = ${projectId} and research_question_id = ${questionId}
        ${claimId ? sql`and claim_id = ${claimId}` : sql``}
      order by sequence asc
    `);
    return (rows as any[]).map((r) => ({
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      claimId: String(r.claim_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Latest event for a specific (question, target) pair.
   */
  async getLatestExtractionFieldEvent(
    projectId: string,
    questionId: string,
    extractionFieldId: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionExtractionFieldEvent | null> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, extraction_field_id, action, note, created_at
      from research_question_extraction_field_events
      where project_id = ${projectId} and research_question_id = ${questionId} and extraction_field_id = ${extractionFieldId}
      order by sequence desc limit 1
    `);
    const r = (rows as any[])[0];
    if (!r) return null;
    return {
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      extractionFieldId: String(r.extraction_field_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  async getLatestEvidenceSetEvent(
    projectId: string,
    questionId: string,
    evidenceSetId: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionEvidenceSetEvent | null> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, evidence_set_id, action, note, created_at
      from research_question_evidence_set_events
      where project_id = ${projectId} and research_question_id = ${questionId} and evidence_set_id = ${evidenceSetId}
      order by sequence desc limit 1
    `);
    const r = (rows as any[])[0];
    if (!r) return null;
    return {
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      evidenceSetId: String(r.evidence_set_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  async getLatestSynthesisStatementEvent(
    projectId: string,
    questionId: string,
    synthesisStatementId: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionSynthesisStatementEvent | null> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, synthesis_statement_id, action, note, created_at
      from research_question_synthesis_statement_events
      where project_id = ${projectId} and research_question_id = ${questionId} and synthesis_statement_id = ${synthesisStatementId}
      order by sequence desc limit 1
    `);
    const r = (rows as any[])[0];
    if (!r) return null;
    return {
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      synthesisStatementId: String(r.synthesis_statement_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  async getLatestClaimEvent(
    projectId: string,
    questionId: string,
    claimId: string,
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionClaimEvent | null> {
    const rows = await (tx as any).execute(sql`
      select id, sequence, project_id, research_question_id, claim_id, action, note, created_at
      from research_question_claim_events
      where project_id = ${projectId} and research_question_id = ${questionId} and claim_id = ${claimId}
      order by sequence desc limit 1
    `);
    const r = (rows as any[])[0];
    if (!r) return null;
    return {
      id: String(r.id),
      sequence: Number(r.sequence),
      projectId: String(r.project_id),
      researchQuestionId: String(r.research_question_id),
      claimId: String(r.claim_id),
      action: r.action as TraceabilityAction,
      note: r.note ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  /**
   * Append-only event inserts.
   */
  async insertExtractionFieldEvent(
    values: {
      projectId: string;
      researchQuestionId: string;
      extractionFieldId: string;
      action: TraceabilityAction;
      note?: string | null;
    },
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionExtractionFieldEvent> {
    const [row] = await (tx as any)
      .insert(researchQuestionExtractionFieldEvents)
      .values({
        projectId: values.projectId,
        researchQuestionId: values.researchQuestionId,
        extractionFieldId: values.extractionFieldId,
        action: values.action,
        note: values.note ?? null,
      })
      .returning();
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      projectId: String(row.projectId),
      researchQuestionId: String(row.researchQuestionId),
      extractionFieldId: String(row.extractionFieldId),
      action: row.action as TraceabilityAction,
      note: row.note ?? null,
      createdAt: new Date(row.createdAt),
    };
  }

  async insertEvidenceSetEvent(
    values: {
      projectId: string;
      researchQuestionId: string;
      evidenceSetId: string;
      action: TraceabilityAction;
      note?: string | null;
    },
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionEvidenceSetEvent> {
    const [row] = await (tx as any)
      .insert(researchQuestionEvidenceSetEvents)
      .values({
        projectId: values.projectId,
        researchQuestionId: values.researchQuestionId,
        evidenceSetId: values.evidenceSetId,
        action: values.action,
        note: values.note ?? null,
      })
      .returning();
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      projectId: String(row.projectId),
      researchQuestionId: String(row.researchQuestionId),
      evidenceSetId: String(row.evidenceSetId),
      action: row.action as TraceabilityAction,
      note: row.note ?? null,
      createdAt: new Date(row.createdAt),
    };
  }

  async insertSynthesisStatementEvent(
    values: {
      projectId: string;
      researchQuestionId: string;
      synthesisStatementId: string;
      action: TraceabilityAction;
      note?: string | null;
    },
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionSynthesisStatementEvent> {
    const [row] = await (tx as any)
      .insert(researchQuestionSynthesisStatementEvents)
      .values({
        projectId: values.projectId,
        researchQuestionId: values.researchQuestionId,
        synthesisStatementId: values.synthesisStatementId,
        action: values.action,
        note: values.note ?? null,
      })
      .returning();
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      projectId: String(row.projectId),
      researchQuestionId: String(row.researchQuestionId),
      synthesisStatementId: String(row.synthesisStatementId),
      action: row.action as TraceabilityAction,
      note: row.note ?? null,
      createdAt: new Date(row.createdAt),
    };
  }

  async insertClaimEvent(
    values: {
      projectId: string;
      researchQuestionId: string;
      claimId: string;
      action: TraceabilityAction;
      note?: string | null;
    },
    tx: DbOrTx = this.db,
  ): Promise<ResearchQuestionClaimEvent> {
    const [row] = await (tx as any)
      .insert(researchQuestionClaimEvents)
      .values({
        projectId: values.projectId,
        researchQuestionId: values.researchQuestionId,
        claimId: values.claimId,
        action: values.action,
        note: values.note ?? null,
      })
      .returning();
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      projectId: String(row.projectId),
      researchQuestionId: String(row.researchQuestionId),
      claimId: String(row.claimId),
      action: row.action as TraceabilityAction,
      note: row.note ?? null,
      createdAt: new Date(row.createdAt),
    };
  }
}
