import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  foreignKey,
  check,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects, papers } from "./foundation";

export const screeningCriteria = pgTable(
  "screening_criteria",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    text: text("text").notNull(),
    sortOrder: bigint("sort_order", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("screening_criteria_project_id_id_unique").on(table.projectId, table.id),
    projectTypedIdentity: unique("screening_criteria_project_id_id_type_unique").on(table.projectId, table.id, table.type),
    projectOrder: index("screening_criteria_project_order_idx").on(table.projectId, table.sortOrder),
    typeValid: check("screening_criteria_type_valid", sql`${table.type} in ('inclusion', 'exclusion')`),
    textNonblank: check("screening_criteria_text_nonblank", sql`btrim(${table.text}) <> ''`),
  }),
);

export const screeningDecisions = pgTable(
  "screening_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    stage: text("stage").notNull().default("title_abstract"),
    decision: text("decision").notNull(),
    exclusionCriterionId: uuid("exclusion_criterion_id"),
    exclusionCriterionType: text("exclusion_criterion_type"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("screening_decisions_project_id_id_unique").on(table.projectId, table.id),
    paperIdentity: unique("screening_decisions_project_paper_id_id_unique").on(table.projectId, table.paperId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "screening_decisions_project_paper_fk",
    }).onDelete("restrict"),
    criterionOwnership: foreignKey({
      columns: [table.projectId, table.exclusionCriterionId, table.exclusionCriterionType],
      foreignColumns: [screeningCriteria.projectId, screeningCriteria.id, screeningCriteria.type],
      name: "screening_decisions_project_criterion_fk",
    }).onDelete("restrict"),
    paperSequence: index("screening_decisions_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    projectStageSequence: index("screening_decisions_project_stage_sequence_idx").on(table.projectId, table.stage, table.sequence),
    stageValid: check("screening_decisions_stage_valid", sql`${table.stage} = 'title_abstract'`),
    decisionValid: check("screening_decisions_decision_valid", sql`${table.decision} in ('include', 'exclude', 'maybe')`),
    exclusionShape: check("screening_decisions_exclusion_shape", sql`(
      (${table.decision} = 'exclude' and ${table.exclusionCriterionId} is not null and ${table.exclusionCriterionType} = 'exclusion')
      or (${table.decision} in ('include', 'maybe') and ${table.exclusionCriterionId} is null and ${table.exclusionCriterionType} is null)
    )`),
    noteNonblank: check("screening_decisions_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
  }),
);

export const fullTextScreeningCriteria = pgTable(
  "full_text_screening_criteria",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    text: text("text").notNull(),
    sortOrder: bigint("sort_order", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("full_text_screening_criteria_project_id_id_unique").on(table.projectId, table.id),
    projectOrder: index("full_text_screening_criteria_project_order_idx").on(table.projectId, table.sortOrder),
    textNonblank: check("full_text_screening_criteria_text_nonblank", sql`btrim(${table.text}) <> ''`),
  }),
);

export const fullTextScreeningDecisions = pgTable(
  "full_text_screening_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    decision: text("decision").notNull(),
    exclusionCriterionId: uuid("exclusion_criterion_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("full_text_screening_decisions_project_id_id_unique").on(table.projectId, table.id),
    paperIdentity: unique("full_text_screening_decisions_project_paper_id_id_unique").on(table.projectId, table.paperId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "full_text_screening_decisions_project_paper_fk",
    }).onDelete("restrict"),
    criterionOwnership: foreignKey({
      columns: [table.projectId, table.exclusionCriterionId],
      foreignColumns: [fullTextScreeningCriteria.projectId, fullTextScreeningCriteria.id],
      name: "full_text_screening_decisions_project_criterion_fk",
    }).onDelete("restrict"),
    paperSequence: index("full_text_screening_decisions_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    decisionValid: check("full_text_screening_decisions_decision_valid", sql`${table.decision} in ('include', 'exclude', 'maybe')`),
    exclusionShape: check("full_text_screening_decisions_exclusion_shape", sql`(
      (${table.decision} = 'exclude' and ${table.exclusionCriterionId} is not null)
      or (${table.decision} in ('include', 'maybe') and ${table.exclusionCriterionId} is null)
    )`),
    noteNonblank: check("full_text_screening_decisions_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
  }),
);

export const fullTextRetrievalAttempts = pgTable(
  "full_text_retrieval_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    outcome: text("outcome").notNull(),
    method: text("method"),
    sourceReference: text("source_reference"),
    note: text("note"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("full_text_retrieval_attempts_project_id_id_unique").on(table.projectId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "full_text_retrieval_attempts_project_paper_fk",
    }).onDelete("restrict"),
    paperSequence: index("full_text_retrieval_attempts_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    outcomeValid: check("full_text_retrieval_attempts_outcome_valid", sql`${table.outcome} in ('pending', 'unavailable', 'retrieved')`),
    methodValid: check("full_text_retrieval_attempts_method_valid", sql`${table.method} is null or ${table.method} in ('publisher', 'bibliographic_database', 'institutional_access', 'library', 'interlibrary_loan', 'author_contact', 'web', 'manual', 'other')`),
    sourceReferenceNonblank: check("full_text_retrieval_attempts_source_reference_nonblank", sql`${table.sourceReference} is null or btrim(${table.sourceReference}) <> ''`),
    noteNonblank: check("full_text_retrieval_attempts_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
  }),
);
