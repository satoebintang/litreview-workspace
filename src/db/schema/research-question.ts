import {
  integer,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  foreignKey,
  primaryKey,
  check,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./foundation";
import { evidenceSets } from "./evidence-sets";
import { extractionFields } from "./extraction";
import { synthesisStatements, synthesisRevisions } from "./synthesis";
import { claims, claimRevisions } from "./claims";
import { researchQuestions } from "./protocol-search";

export const researchQuestionExtractionFieldEvents = pgTable(
  "research_question_extraction_field_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_extraction_field_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_extraction_field_events_project_rq_fk",
    }).onDelete("restrict"),
    projectFieldOwnership: foreignKey({
      columns: [table.projectId, table.extractionFieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "rq_extraction_field_events_project_field_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_extraction_field_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectFieldSequence: index("rq_extraction_field_events_project_field_seq_idx").on(
      table.projectId,
      table.extractionFieldId,
      table.sequence,
    ),
    projectPairSequence: index("rq_extraction_field_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.extractionFieldId,
      table.sequence,
    ),
    actionValid: check(
      "rq_extraction_field_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_extraction_field_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionEvidenceSetEvents = pgTable(
  "research_question_evidence_set_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_evidence_set_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_evidence_set_events_project_rq_fk",
    }).onDelete("restrict"),
    projectEvidenceSetOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "rq_evidence_set_events_project_set_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_evidence_set_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectEvidenceSetSequence: index("rq_evidence_set_events_project_set_seq_idx").on(
      table.projectId,
      table.evidenceSetId,
      table.sequence,
    ),
    projectPairSequence: index("rq_evidence_set_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.evidenceSetId,
      table.sequence,
    ),
    actionValid: check(
      "rq_evidence_set_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_evidence_set_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionSynthesisStatementEvents = pgTable(
  "research_question_synthesis_statement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_synthesis_statement_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_synthesis_statement_events_project_rq_fk",
    }).onDelete("restrict"),
    projectStatementOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId],
      foreignColumns: [synthesisStatements.projectId, synthesisStatements.id],
      name: "rq_synthesis_statement_events_project_stmt_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_synthesis_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectStatementSequence: index("rq_synthesis_events_project_stmt_seq_idx").on(
      table.projectId,
      table.synthesisStatementId,
      table.sequence,
    ),
    projectPairSequence: index("rq_synthesis_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.synthesisStatementId,
      table.sequence,
    ),
    actionValid: check(
      "rq_synthesis_statement_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_synthesis_statement_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionClaimEvents = pgTable(
  "research_question_claim_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_claim_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_claim_events_project_rq_fk",
    }).onDelete("restrict"),
    projectClaimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "rq_claim_events_project_claim_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_claim_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectClaimSequence: index("rq_claim_events_project_claim_seq_idx").on(
      table.projectId,
      table.claimId,
      table.sequence,
    ),
    projectPairSequence: index("rq_claim_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.claimId,
      table.sequence,
    ),
    actionValid: check(
      "rq_claim_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_claim_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionAnswers = pgTable(
  "research_question_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    answerText: text("answer_text").notNull(),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("research_question_answers_project_id_id_unique").on(table.projectId, table.id),
    questionIdentity: unique("research_question_answers_project_question_id_id_unique").on(table.projectId, table.researchQuestionId, table.id),
    questionSequence: index("research_question_answers_project_question_sequence_idx").on(table.projectId, table.researchQuestionId, table.sequence),
    projectSequence: index("research_question_answers_project_sequence_idx").on(table.projectId, table.sequence),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "research_question_answers_project_fk",
    }).onDelete("restrict"),
    questionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "research_question_answers_project_question_fk",
    }).onDelete("restrict"),
    answerTextShape: check(
      "research_question_answers_answer_text_shape",
      sql`btrim(${table.answerText}) <> '' and char_length(${table.answerText}) <= 20000`,
    ),
    researcherNoteShape: check(
      "research_question_answers_researcher_note_shape",
      sql`${table.researcherNote} is null or (btrim(${table.researcherNote}) <> '' and char_length(${table.researcherNote}) <= 20000)`,
    ),
  }),
);

export const researchQuestionAnswerClaimContexts = pgTable(
  "research_question_answer_claim_contexts",
  {
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    answerId: uuid("answer_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.answerId, table.claimRevisionId] }),
    answerSortOrder: unique("research_question_answer_claim_contexts_answer_sort_order_unique").on(table.projectId, table.answerId, table.sortOrder),
    answerOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId, table.answerId],
      foreignColumns: [researchQuestionAnswers.projectId, researchQuestionAnswers.researchQuestionId, researchQuestionAnswers.id],
      name: "research_question_answer_claim_contexts_answer_fk",
    }).onDelete("restrict"),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.claimId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.claimId, claimRevisions.id],
      name: "research_question_answer_claim_contexts_revision_fk",
    }).onDelete("restrict"),
    answerLookup: index("research_question_answer_claim_contexts_answer_idx").on(table.projectId, table.answerId, table.sortOrder),
    claimLookup: index("research_question_answer_claim_contexts_claim_idx").on(table.projectId, table.claimId),
    revisionLookup: index("research_question_answer_claim_contexts_revision_idx").on(table.projectId, table.claimRevisionId),
    sortOrderValid: check("research_question_answer_claim_contexts_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const researchQuestionAnswerSynthesisContexts = pgTable(
  "research_question_answer_synthesis_contexts",
  {
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    answerId: uuid("answer_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.answerId, table.synthesisRevisionId] }),
    answerSortOrder: unique("research_question_answer_synthesis_contexts_answer_sort_order_unique").on(table.projectId, table.answerId, table.sortOrder),
    answerOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId, table.answerId],
      foreignColumns: [researchQuestionAnswers.projectId, researchQuestionAnswers.researchQuestionId, researchQuestionAnswers.id],
      name: "research_question_answer_synthesis_contexts_answer_fk",
    }).onDelete("restrict"),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.synthesisStatementId, synthesisRevisions.id],
      name: "research_question_answer_synthesis_contexts_revision_fk",
    }).onDelete("restrict"),
    answerLookup: index("research_question_answer_synthesis_contexts_answer_idx").on(table.projectId, table.answerId, table.sortOrder),
    statementLookup: index("research_question_answer_synthesis_contexts_statement_idx").on(table.projectId, table.synthesisStatementId),
    revisionLookup: index("research_question_answer_synthesis_contexts_revision_idx").on(table.projectId, table.synthesisRevisionId),
    sortOrderValid: check("research_question_answer_synthesis_contexts_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);
