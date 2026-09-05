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
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  researchQuestion: text("research_question"),
  ...timestamps,
}, (table) => ({
  titleNonblank: check("projects_title_nonblank", sql`btrim(${table.title}) <> ''`),
}));

export const papers = pgTable(
  "papers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    authors: text("authors").array().notNull().default([]),
    publicationYear: integer("publication_year"),
    venue: text("venue"),
    doi: text("doi"),
    abstract: text("abstract"),
    bibliographicNote: text("bibliographic_note"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("papers_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("papers_project_created_at_idx").on(table.projectId, table.createdAt),
    titleNonblank: check("papers_title_nonblank", sql`btrim(${table.title}) <> ''`),
  }),
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    sourceText: text("source_text").notNull(),
    pageNumber: integer("page_number").notNull(),
    note: text("note"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("evidence_project_id_id_unique").on(table.projectId, table.id),
    projectPaperIdentity: unique("evidence_project_paper_id_unique").on(table.projectId, table.paperId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "evidence_project_paper_fk",
    }).onDelete("restrict"),
    projectPaperCreatedAt: index("evidence_project_paper_created_at_idx").on(
      table.projectId,
      table.paperId,
      table.createdAt,
    ),
    sourceTextNonblank: check("evidence_source_text_nonblank", sql`btrim(${table.sourceText}) <> ''`),
    pagePositive: check("evidence_page_positive", sql`${table.pageNumber} > 0`),
  }),
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("claims_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("claims_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const claimRevisions = pgTable(
  "claim_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    state: text("state").notNull().default("active"),
    claimText: text("claim_text"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("claim_revisions_project_id_id_unique").on(table.projectId, table.id),
    claimIdentity: unique("claim_revisions_project_claim_id_id_unique").on(table.projectId, table.claimId, table.id),
    claimSequence: index("claim_revisions_project_claim_sequence_idx").on(table.projectId, table.claimId, table.sequence),
    projectSequence: index("claim_revisions_project_sequence_idx").on(table.projectId, table.sequence),
    claimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "claim_revisions_project_claim_fk",
    }).onDelete("restrict"),
    stateValid: check("claim_revisions_state_valid", sql`${table.state} in ('active', 'withdrawn')`),
    claimTextShape: check("claim_revisions_claim_text_shape", sql`(
      (${table.state} = 'active' and ${table.claimText} is not null and btrim(${table.claimText}) <> '')
      or (${table.state} = 'withdrawn' and ${table.claimText} is null)
    )`),
    noteNonblank: check("claim_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const claimRevisionEvidenceSupports = pgTable(
  "claim_revision_evidence_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.evidenceId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_evidence_supports_project_revision_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "claim_revision_evidence_supports_project_evidence_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_evidence_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    evidenceLookup: index("claim_revision_evidence_supports_project_evidence_idx").on(table.projectId, table.evidenceId),
  }),
);

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

export const extractionFields = pgTable(
  "extraction_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    fieldType: text("field_type").notNull(),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("extraction_fields_project_id_id_unique").on(table.projectId, table.id),
    projectOrder: index("extraction_fields_project_order_idx").on(table.projectId, table.sortOrder, table.id),
    typeValid: check("extraction_fields_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    nameNonblank: check("extraction_fields_name_nonblank", sql`btrim(${table.name}) <> ''`),
    descriptionNonblank: check("extraction_fields_description_nonblank", sql`${table.description} is null or btrim(${table.description}) <> ''`),
    sortPositive: check("extraction_fields_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const extractionOptions = pgTable(
  "extraction_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("extraction_options_project_id_id_unique").on(table.projectId, table.id),
    fieldIdentity: unique("extraction_options_project_field_id_unique").on(table.projectId, table.fieldId, table.id),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.fieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "extraction_options_project_field_fk",
    }).onDelete("restrict"),
    fieldOrder: index("extraction_options_field_order_idx").on(table.projectId, table.fieldId, table.sortOrder, table.id),
    labelNonblank: check("extraction_options_label_nonblank", sql`btrim(${table.label}) <> ''`),
    sortPositive: check("extraction_options_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const extractionValues = pgTable(
  "extraction_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("extraction_values_project_id_id_unique").on(table.projectId, table.id),
    slotUnique: unique("extraction_values_project_paper_field_unique").on(table.projectId, table.paperId, table.fieldId),
    projectPaperIdentity: unique("extraction_values_project_paper_id_unique").on(table.projectId, table.paperId, table.id),
    projectPaperFieldIdentity: unique("extraction_values_project_paper_field_id_unique").on(table.projectId, table.paperId, table.id, table.fieldId),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "extraction_values_project_paper_fk",
    }).onDelete("restrict"),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.fieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "extraction_values_project_field_fk",
    }).onDelete("restrict"),
    paperFieldLookup: index("extraction_values_project_paper_field_idx").on(table.projectId, table.paperId, table.fieldId),
  }),
);

export const extractionValueRevisions = pgTable(
  "extraction_value_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    extractionValueId: uuid("extraction_value_id").notNull(),
    fieldType: text("field_type").notNull(),
    valueState: text("value_state").notNull(),
    textValue: text("text_value"),
    numberValue: numeric("number_value", { precision: 30, scale: 10 }),
    booleanValue: boolean("boolean_value"),
    optionId: uuid("option_id"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("extraction_value_revisions_project_id_id_unique").on(table.projectId, table.id),
    projectPaperIdentity: unique("extraction_value_revisions_project_paper_id_unique").on(table.projectId, table.paperId, table.id),
    valueIdentity: unique("extraction_value_revisions_project_value_id_unique").on(table.projectId, table.extractionValueId, table.id),
    valuePaperIdentity: unique("extraction_value_revisions_project_paper_value_id_unique").on(table.projectId, table.paperId, table.extractionValueId, table.id),
    valueOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.extractionValueId, table.fieldId],
      foreignColumns: [extractionValues.projectId, extractionValues.paperId, extractionValues.id, extractionValues.fieldId],
      name: "extraction_value_revisions_value_fk",
    }).onDelete("restrict"),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.fieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "extraction_value_revisions_field_fk",
    }).onDelete("restrict"),
    optionOwnership: foreignKey({
      columns: [table.projectId, table.fieldId, table.optionId],
      foreignColumns: [extractionOptions.projectId, extractionOptions.fieldId, extractionOptions.id],
      name: "extraction_value_revisions_option_fk",
    }).onDelete("restrict"),
    valueLookup: index("extraction_value_revisions_current_idx").on(table.projectId, table.paperId, table.fieldId, table.sequence),
    stateValid: check("extraction_value_revisions_state_valid", sql`${table.valueState} in ('present', 'not_reported', 'not_applicable', 'cleared')`),
    typeValid: check("extraction_value_revisions_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    valueShape: check("extraction_value_revisions_value_shape", sql`(
      (${table.valueState} <> 'present' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
      or (${table.valueState} = 'present' and (
        (${table.fieldType} in ('short_text', 'long_text') and ${table.textValue} is not null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
        or (${table.fieldType} = 'number' and ${table.textValue} is null and ${table.numberValue} is not null and ${table.booleanValue} is null and ${table.optionId} is null)
        or (${table.fieldType} = 'boolean' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is not null and ${table.optionId} is null)
        or (${table.fieldType} = 'single_select' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is not null)
      ))
    )`),
    noteNonblank: check("extraction_value_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const extractionRevisionEvidence = pgTable(
  "extraction_revision_evidence",
  {
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.revisionId, table.evidenceId] }),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.revisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.paperId, extractionValueRevisions.id],
      name: "extraction_revision_evidence_revision_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.paperId, evidence.id],
      name: "extraction_revision_evidence_evidence_fk",
    }).onDelete("restrict"),
    revisionLookup: index("extraction_revision_evidence_revision_idx").on(table.projectId, table.revisionId),
    evidenceLookup: index("extraction_revision_evidence_evidence_idx").on(table.projectId, table.paperId, table.evidenceId),
  }),
);

export const synthesisStatements = pgTable(
  "synthesis_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("synthesis_statements_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("synthesis_statements_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const synthesisRevisions = pgTable(
  "synthesis_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    state: text("state").notNull().default("active"),
    title: text("title"),
    statementText: text("statement_text"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("synthesis_revisions_project_id_id_unique").on(table.projectId, table.id),
    statementIdentity: unique("synthesis_revisions_project_statement_id_id_unique").on(table.projectId, table.synthesisStatementId, table.id),
    statementSequence: index("synthesis_revisions_project_statement_sequence_idx").on(table.projectId, table.synthesisStatementId, table.sequence),
    projectSequence: index("synthesis_revisions_project_sequence_idx").on(table.projectId, table.sequence),
    statementOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId],
      foreignColumns: [synthesisStatements.projectId, synthesisStatements.id],
      name: "synthesis_revisions_project_statement_fk",
    }).onDelete("restrict"),
    stateValid: check("synthesis_revisions_state_valid", sql`${table.state} in ('active', 'withdrawn')`),
    titleNonblank: check("synthesis_revisions_title_nonblank", sql`${table.title} is null or btrim(${table.title}) <> ''`),
    statementShape: check("synthesis_revisions_statement_shape", sql`(
      (${table.state} = 'active' and ${table.statementText} is not null and btrim(${table.statementText}) <> '')
      or (${table.state} = 'withdrawn' and ${table.statementText} is null)
    )`),
    noteNonblank: check("synthesis_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const synthesisRevisionSupports = pgTable(
  "synthesis_revision_supports",
  {
    projectId: uuid("project_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.synthesisRevisionId, table.extractionRevisionId] }),
    synthesisRevisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id],
      name: "synthesis_revision_supports_project_synthesis_revision_fk",
    }).onDelete("restrict"),
    extractionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.extractionRevisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id],
      name: "synthesis_revision_supports_project_extraction_revision_fk",
    }).onDelete("restrict"),
    synthesisRevisionLookup: index("synthesis_revision_supports_project_synthesis_revision_idx").on(table.projectId, table.synthesisRevisionId),
    extractionRevisionLookup: index("synthesis_revision_supports_project_extraction_revision_idx").on(table.projectId, table.extractionRevisionId),
  }),
);

export const claimRevisionExtractionSupports = pgTable(
  "claim_revision_extraction_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.extractionRevisionId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_extraction_supports_project_revision_fk",
    }).onDelete("restrict"),
    extractionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.extractionRevisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id],
      name: "claim_revision_extraction_supports_project_extraction_revision_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_extraction_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    extractionRevisionLookup: index("claim_revision_extraction_supports_project_extraction_revision_idx").on(table.projectId, table.extractionRevisionId),
  }),
);

export const claimRevisionSynthesisSupports = pgTable(
  "claim_revision_synthesis_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.synthesisRevisionId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_synthesis_supports_project_revision_fk",
    }).onDelete("restrict"),
    synthesisRevisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id],
      name: "claim_revision_synthesis_supports_project_synthesis_revision_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_synthesis_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    synthesisRevisionLookup: index("claim_revision_synthesis_supports_project_synthesis_revision_idx").on(table.projectId, table.synthesisRevisionId),
  }),
);

export const schema = { projects, papers, evidence, claims, claimRevisions, claimRevisionEvidenceSupports, claimRevisionExtractionSupports, claimRevisionSynthesisSupports, screeningCriteria, screeningDecisions, extractionFields, extractionOptions, extractionValues, extractionValueRevisions, extractionRevisionEvidence, synthesisStatements, synthesisRevisions, synthesisRevisionSupports };
