import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable().optional();

export const idSchema = z.string().uuid();

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: optionalText,
  researchQuestion: optionalText,
});

export const createPaperSchema = z.object({
  title: z.string().trim().min(1).max(1000),
  authors: z.array(z.string().trim().min(1).max(500)).default([]),
  publicationYear: z.number().int().min(1000).max(3000).nullable().optional(),
  venue: optionalText,
  doi: optionalText,
  abstract: optionalText,
  bibliographicNote: optionalText,
});

export const recordEvidenceSchema = z.object({
  paperId: idSchema,
  fullTextDocumentId: idSchema.nullable().optional(),
  // Validate blankness without transforming the quotation: source text is provenance.
  sourceText: z.string().refine((value) => value.trim().length > 0, "Source text is required"),
  pageNumber: z.number().int().positive(),
  note: optionalText,
});

/** Input for the dedicated extracted-page Evidence path. The source text is
 * intentionally absent: the application derives it from the immutable stored
 * page text after validating this exact page/range. */
export const recordExtractedEvidenceSchema = z.object({
  paperId: idSchema,
  fullTextDocumentId: idSchema,
  documentTextExtractionId: idSchema,
  pageNumber: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  note: optionalText,
}).superRefine((value, ctx) => {
  if (value.endOffset <= value.startOffset) {
    ctx.addIssue({ code: "custom", path: ["endOffset"], message: "Evidence range must be non-empty and forward" });
  }
});

export const appendEvidenceReviewDecisionSchema = z.object({
  decision: z.enum(["needs_review", "accepted", "rejected"]),
  note: z.string().transform((value) => {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }).nullable().optional().refine((value) => value == null || value.length <= 2000, "Review notes cannot exceed 2000 characters"),
});

export const appendEvidenceAnnotationSchema = z.object({
  body: z.string().trim().min(1, "Annotation body is required").max(10000, "Annotations cannot exceed 10000 characters"),
});

export const createEvidenceLabelSchema = z.object({
  name: z.string().trim().min(1, "Label name is required").max(100, "Label names cannot exceed 100 characters"),
  description: z.string().trim().max(500, "Label descriptions cannot exceed 500 characters").nullable().optional(),
});

export const createEvidenceSetSchema = z.object({
  name: z.string().trim().min(1, "Evidence Set name is required").max(100, "Evidence Set names cannot exceed 100 characters"),
  description: z.string().trim().max(500, "Evidence Set descriptions cannot exceed 500 characters").transform((value) => value || null).nullable().optional(),
});

export const updateEvidenceSetMetadataSchema = z.object({
  name: z.string().trim().min(1, "Evidence Set name is required").max(100, "Evidence Set names cannot exceed 100 characters").optional(),
  description: z.string().trim().max(500, "Evidence Set descriptions cannot exceed 500 characters").transform((value) => value || null).nullable().optional(),
}).refine((value) => value.name !== undefined || value.description !== undefined, "Evidence Set metadata cannot be empty");

export const evidenceSetMembershipInputSchema = z.object({
  evidenceId: idSchema,
});

export const reorderEvidenceSetSchema = z.object({
  evidenceIds: z.array(idSchema),
}).superRefine((value, ctx) => {
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "Evidence Set order cannot contain duplicates" });
  }
});

export const appendEvidenceSetAnnotationSchema = z.object({
  body: z.string().trim().min(1, "Evidence Set annotation is required").max(10000, "Evidence Set annotations cannot exceed 10000 characters"),
});

export const evidenceWorkspaceFilterSchema = z.object({
  state: z.enum(["attention", "unreviewed", "needs_review", "accepted", "rejected", "all"]).default("attention"),
  paperId: idSchema.optional(),
  labelId: idSchema.optional(),
  fullTextDocumentId: idSchema.optional(),
  documentProvenance: z.enum(["any", "none", "document", "extraction"]).default("any"),
  documentTextExtractionId: idSchema.optional(),
  pageNumber: z.number().int().positive().optional(),
  usage: z.enum(["any", "used", "unused"]).default("any"),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
});

export const createDocumentTextExtractionSchema = z.object({
  fullTextDocumentId: idSchema,
});

export const fullTextDocumentMetadataSchema = z.object({
  originalFilename: z.string().min(1).max(255),
  mediaType: z.literal("application/pdf"),
  note: optionalText,
});

export const createClaimSchema = z.object({
  claimText: z.string().trim().min(1),
  researcherNote: optionalText,
});

export const createClaimWithSynthesisSupportSchema = z.object({
  claimText: z.string().trim().min(1).max(10000),
  researcherNote: optionalText,
  synthesisRevisionId: idSchema,
});

export const createClaimFromInterpretationSchema = z.object({
  interpretationId: idSchema,
  synthesisRevisionId: idSchema.optional(),
  claimText: z.string().trim().min(1).max(10000),
  researcherNote: optionalText,
});

export const claimEvidenceInputSchema = z.object({
  claimId: idSchema,
  evidenceId: idSchema,
});

const claimSupportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evidence"), evidenceId: idSchema }),
  z.object({ kind: z.literal("extractionRevision"), extractionRevisionId: idSchema }),
  z.object({ kind: z.literal("synthesisRevision"), synthesisRevisionId: idSchema }),
]);

export const claimRevisionSnapshotSchema = z.object({
  lifecycle: z.enum(["active", "withdrawn"]).default("active"),
  claimText: z.string().trim().min(1).max(10000).nullable().optional(),
  researcherNote: optionalText,
  supports: z.array(claimSupportSchema).default([]),
}).superRefine((value, ctx) => {
  if (value.lifecycle === "active" && (!value.claimText || value.claimText.trim().length === 0)) {
    ctx.addIssue({ code: "custom", path: ["claimText"], message: "Active claims require nonblank text" });
  }
  if (value.lifecycle === "withdrawn" && (value.claimText != null || value.supports.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["supports"], message: "Withdrawn claims cannot have claim text or support" });
  }
  const keys = value.supports.map((support) => {
    if (support.kind === "evidence") return `evidence:${support.evidenceId}`;
    if (support.kind === "extractionRevision") return `extractionRevision:${support.extractionRevisionId}`;
    return `synthesisRevision:${support.synthesisRevisionId}`;
  });
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", path: ["supports"], message: "Support cannot contain duplicate exact targets" });
  }
});

export const createClaimRevisionSchema = claimRevisionSnapshotSchema.extend({
  expectedCurrentRevisionId: idSchema.nullable().optional(),
});

export const withdrawClaimSchema = z.object({
  researcherNote: optionalText,
  expectedCurrentRevisionId: idSchema.nullable().optional(),
});

export const createScreeningCriterionSchema = z.object({
  type: z.enum(["inclusion", "exclusion"]),
  text: z.string().trim().min(1).max(1000),
});

export const recordScreeningDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("include"), note: optionalText }),
  z.object({ decision: z.literal("maybe"), note: optionalText }),
  z.object({ decision: z.literal("exclude"), exclusionCriterionId: idSchema, note: optionalText }),
]);

export const createFullTextScreeningCriterionSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});

export const recordFullTextScreeningDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("include"), note: optionalText }),
  z.object({ decision: z.literal("maybe"), note: optionalText }),
  z.object({ decision: z.literal("exclude"), exclusionCriterionId: idSchema, note: optionalText }),
]);

export const fullTextRetrievalMethodSchema = z.enum(["publisher", "bibliographic_database", "institutional_access", "library", "interlibrary_loan", "author_contact", "web", "manual", "other"]);
export const recordFullTextRetrievalAttemptSchema = z.object({
  outcome: z.enum(["pending", "unavailable", "retrieved"]),
  method: fullTextRetrievalMethodSchema.nullable().optional(),
  sourceReference: optionalText,
  note: optionalText,
  attemptedAt: z.coerce.date(),
});

export const extractionFieldTypeSchema = z.enum(["short_text", "long_text", "number", "boolean", "single_select"]);
export const extractionValueStateSchema = z.enum(["present", "not_reported", "not_applicable", "cleared"]);

export const createExtractionFieldSchema = z.object({
  name: z.string().trim().min(1).max(500),
  description: optionalText,
  fieldType: extractionFieldTypeSchema,
  required: z.boolean().optional().default(false),
});

export const updateExtractionFieldSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  description: optionalText,
  required: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createExtractionOptionSchema = z.object({
  fieldId: idSchema,
  label: z.string().trim().min(1).max(500),
});

export const reviseExtractionValueSchema = z.object({
  state: extractionValueStateSchema.default("present"),
  value: z.unknown().optional(),
  researcherNote: optionalText,
  evidenceIds: z.array(idSchema).default([]),
});

const synthesisText = z.string().trim().min(1);
export const synthesisRevisionInputSchema = z.object({
  title: synthesisText.max(500).nullable().optional(),
  statementText: synthesisText.max(10000),
  researcherNote: synthesisText.max(10000).nullable().optional(),
  extractionRevisionIds: z.array(idSchema).default([]),
}).superRefine((value, ctx) => {
  if (new Set(value.extractionRevisionIds).size !== value.extractionRevisionIds.length) {
    ctx.addIssue({ code: "custom", path: ["extractionRevisionIds"], message: "Support cannot contain duplicate extraction revisions" });
  }
});

export const synthesisWithdrawalSchema = z.object({
  researcherNote: synthesisText.max(10000).nullable().optional(),
});

export const createSynthesisPreparationSchema = z.object({
  evidenceSetId: idSchema,
  extractionFieldId: idSchema,
  workingTitle: synthesisText.max(500).nullable().optional(),
  workingNote: synthesisText.max(10000).nullable().optional(),
});

export const updateSynthesisPreparationSchema = z.object({
  workingTitle: synthesisText.max(500).nullable().optional(),
  workingNote: synthesisText.max(10000).nullable().optional(),
  targetSynthesisStatementId: idSchema.nullable().optional(),
});

export const replaceSynthesisPreparationSelectionsSchema = z.object({
  extractionRevisionIds: z.array(idSchema).default([]),
}).superRefine((value, ctx) => {
  if (new Set(value.extractionRevisionIds).size !== value.extractionRevisionIds.length) {
    ctx.addIssue({ code: "custom", path: ["extractionRevisionIds"], message: "Selections cannot contain duplicate extraction revisions" });
  }
});

export const finalizeSynthesisPreparationSchema = z.object({
  title: synthesisText.max(500).nullable().optional(),
  statementText: synthesisText.max(10000),
  researcherNote: synthesisText.max(10000).nullable().optional(),
});

export const limitationCategorySchema = z.enum([
  "methodological",
  "population",
  "measurement",
  "generalizability",
  "missing_data",
  "heterogeneity",
  "reporting",
  "other",
]);

export const synthesisInterpretationLimitationInputSchema = z.object({
  category: limitationCategorySchema,
  body: z.string().trim().min(1, "Limitation body is required").max(5000, "Limitation cannot exceed 5000 characters"),
});

export const synthesisInterpretationQuestionInputSchema = z.object({
  body: z.string().trim().min(1, "Question body is required").max(5000, "Question cannot exceed 5000 characters"),
});

export const synthesisInterpretationContradictionInputSchema = z.object({
  leftExtractionRevisionId: idSchema,
  rightExtractionRevisionId: idSchema,
  note: z.preprocess((val) => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return val ?? null;
  }, z.string().max(5000, "Contradiction note cannot exceed 5000 characters").nullable().optional()),
}).superRefine((data, ctx) => {
  if (data.leftExtractionRevisionId === data.rightExtractionRevisionId) {
    ctx.addIssue({
      code: "custom",
      path: ["rightExtractionRevisionId"],
      message: "Self-pairs are not allowed: left and right extraction revisions must be distinct",
    });
  }
}).transform((data) => {
  const isCanonical = data.leftExtractionRevisionId < data.rightExtractionRevisionId;
  return {
    leftExtractionRevisionId: isCanonical ? data.leftExtractionRevisionId : data.rightExtractionRevisionId,
    rightExtractionRevisionId: isCanonical ? data.rightExtractionRevisionId : data.leftExtractionRevisionId,
    note: data.note ?? null,
  };
});

export const appendSynthesisInterpretationSchema = z.object({
  convergenceState: z.enum(["convergent", "mixed", "contradictory", "inconclusive"]),
  summary: z.string().trim().min(1, "Interpretation summary is required").max(20000, "Summary cannot exceed 20000 characters"),
  researcherNote: z.preprocess((val) => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return val ?? null;
  }, z.string().max(10000, "Researcher note cannot exceed 10000 characters").nullable().optional()),
  limitations: z.array(synthesisInterpretationLimitationInputSchema).max(100, "Limitations cannot exceed 100 items").default([]),
  questions: z.array(synthesisInterpretationQuestionInputSchema).max(100, "Questions cannot exceed 100 items").default([]),
  contradictions: z.array(synthesisInterpretationContradictionInputSchema).max(500, "Contradictions cannot exceed 500 items").default([]),
}).superRefine((data, ctx) => {
  const seenPairs = new Set<string>();
  data.contradictions.forEach((pair, index) => {
    const key = `${pair.leftExtractionRevisionId}:${pair.rightExtractionRevisionId}`;
    if (seenPairs.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["contradictions", index],
        message: "Duplicate contradiction pair is not allowed",
      });
    } else {
      seenPairs.add(key);
    }
  });

  if (data.convergenceState === "convergent" && data.contradictions.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["contradictions"],
      message: "Convergent state requires exactly 0 contradiction pairs",
    });
  }
  if (data.convergenceState === "contradictory" && data.contradictions.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["contradictions"],
      message: "Contradictory state requires at least 1 contradiction pair",
    });
  }
});


export const extractionComparisonFilterSchema = z.object({
  paperIds: z.array(idSchema).optional(),
  valueState: z.enum(["present", "not_reported", "not_applicable", "cleared", "not_extracted"]).optional(),
  search: z.string().trim().max(500).optional(),
  optionId: idSchema.optional(),
  booleanValue: z.boolean().optional(),
});

const manuscriptSectionTypeSchema = z.enum(["introduction", "methods", "results", "discussion", "limitations", "conclusion", "custom"]);
export const citationStyleSchema = z.enum(["numeric", "author_year"]);

export const setManuscriptCitationStyleSchema = z.object({
  style: citationStyleSchema,
});

export const createResearchQuestionSchema = z.object({
  identifier: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(10000),
});

export const updateResearchQuestionSchema = z.object({
  identifier: z.string().trim().min(1).max(100).optional(),
  label: z.string().trim().min(1).max(10000).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createSearchStrategySchema = z.object({
  searchSourceId: idSchema,
  name: z.string().trim().min(1).max(500),
  queryText: z.string().refine((value) => value.trim().length > 0, "Query is required").max(10000),
  filtersText: z.string().max(10000).nullable().optional(),
  notes: optionalText,
});

export const updateSearchStrategySchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  queryText: z.string().refine((value) => value.trim().length > 0, "Query is required").max(10000).optional(),
  filtersText: z.string().max(10000).nullable().optional(),
  notes: optionalText,
});

export const createSearchRunSchema = z.object({
  searchSourceId: idSchema,
  sourceKeySnapshot: z.string().trim().min(1).max(200),
  sourceDisplayNameSnapshot: z.string().trim().min(1).max(500),
  strategyId: idSchema,
  queryText: z.string().refine((value) => value.trim().length > 0, "Query is required").max(10000),
  filtersTextSnapshot: z.string().max(10000).nullable().optional(),
  reportedResultCount: z.number().int().min(0),
  executedAt: z.coerce.date(),
  notes: optionalText,
});

export const createRetrievedRecordSchema = z.object({
  searchRunId: idSchema,
  searchSourceId: idSchema,
  sourceRecordId: z.string().trim().min(1).max(2000).nullable().optional(),
  title: z.string().trim().min(1).max(1000),
  authors: z.array(z.string().trim().min(1).max(500)).default([]),
  abstract: optionalText,
  doi: optionalText,
  url: optionalText,
  publicationYear: z.number().int().min(1000).max(3000).nullable().optional(),
  venue: optionalText,
  retrievedAt: z.coerce.date(),
  rawCitation: optionalText,
});

export const createRetrievedRecordMatchSchema = z.object({
  retrievedRecordId: idSchema,
  paperId: idSchema,
  action: z.enum(["linked", "unlinked"]),
});

/** Manuscript titles are organizational metadata; the default service may
 * create one without caller input and receives the default title here. */
export const createManuscriptSchema = z.object({
  title: z.string().trim().min(1).max(500).default("Manuscript"),
});

export const createManuscriptSectionSchema = z.object({
  title: z.string().trim().min(1).max(500),
  sectionType: manuscriptSectionTypeSchema.default("custom"),
});

export const renameManuscriptSectionSchema = z.object({
  title: z.string().trim().min(1).max(500),
});

export const reorderManuscriptSectionsSchema = z.object({
  sectionIds: z.array(idSchema),
});

export const archiveManuscriptSectionSchema = z.object({
  sectionId: idSchema,
});

export const placeClaimRevisionSchema = z.object({
  sectionId: idSchema,
  claimId: idSchema,
  claimRevisionId: idSchema,
  position: z.number().int().min(0).optional(),
});

export const replacePlacedClaimRevisionSchema = z.object({
  placementId: idSchema,
  claimRevisionId: idSchema,
  /** Optional optimistic-concurrency guard. The service still validates the
   * currently placed revision and monotonic sequence when omitted. */
  expectedCurrentClaimRevisionId: idSchema.optional(),
});

export const removeClaimPlacementSchema = z.object({
  placementId: idSchema,
  expectedCurrentClaimRevisionId: idSchema.optional(),
});

export const reorderSectionItemsSchema = z.object({
  sectionId: idSchema,
  itemIds: z.array(idSchema),
});

export const createProseBlockSchema = z.object({
  sectionId: idSchema,
  text: z.string().refine((value) => value.trim().length > 0, "Prose text is required").max(50000),
  position: z.number().int().min(0).optional(),
});

export const updateProseBlockSchema = z.object({
  proseBlockId: idSchema,
  text: z.string().refine((value) => value.trim().length > 0, "Prose text is required").max(50000),
});

export const removeProseBlockSchema = z.object({ proseBlockId: idSchema });

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreatePaperInput = z.input<typeof createPaperSchema>;
export type RecordEvidenceInput = z.input<typeof recordEvidenceSchema>;
export type RecordExtractedEvidenceInput = z.input<typeof recordExtractedEvidenceSchema>;
export type CreateDocumentTextExtractionInput = z.input<typeof createDocumentTextExtractionSchema>;
export type FullTextDocumentMetadataInput = z.input<typeof fullTextDocumentMetadataSchema>;
export type CreateClaimInput = z.input<typeof createClaimSchema>;
export type ClaimSupportInput = z.input<typeof claimSupportSchema>;
export type ClaimRevisionSnapshotInput = z.input<typeof claimRevisionSnapshotSchema>;
export type CreateClaimRevisionInput = z.input<typeof createClaimRevisionSchema>;
export type WithdrawClaimInput = z.input<typeof withdrawClaimSchema>;
export type CreateScreeningCriterionInput = z.input<typeof createScreeningCriterionSchema>;
export type RecordScreeningDecisionInput = z.input<typeof recordScreeningDecisionSchema>;
export type CreateFullTextScreeningCriterionInput = z.input<typeof createFullTextScreeningCriterionSchema>;
export type RecordFullTextScreeningDecisionInput = z.input<typeof recordFullTextScreeningDecisionSchema>;
export type RecordFullTextRetrievalAttemptInput = z.input<typeof recordFullTextRetrievalAttemptSchema>;
export type CreateExtractionFieldInput = z.input<typeof createExtractionFieldSchema>;
export type UpdateExtractionFieldInput = z.input<typeof updateExtractionFieldSchema>;
export type CreateExtractionOptionInput = z.input<typeof createExtractionOptionSchema>;
export type ReviseExtractionValueInput = z.input<typeof reviseExtractionValueSchema>;
export type SynthesisRevisionInput = z.input<typeof synthesisRevisionInputSchema>;
export type SynthesisWithdrawalInput = z.input<typeof synthesisWithdrawalSchema>;
export type ExtractionComparisonFilter = z.input<typeof extractionComparisonFilterSchema>;
export type CreateManuscriptInput = z.input<typeof createManuscriptSchema>;
export type SetManuscriptCitationStyleInput = z.input<typeof setManuscriptCitationStyleSchema>;
export type CreateResearchQuestionInput = z.input<typeof createResearchQuestionSchema>;
export type UpdateResearchQuestionInput = z.input<typeof updateResearchQuestionSchema>;
export type CreateSearchStrategyInput = z.input<typeof createSearchStrategySchema>;
export type UpdateSearchStrategyInput = z.input<typeof updateSearchStrategySchema>;
export type CreateSearchRunInput = z.input<typeof createSearchRunSchema>;
export type CreateRetrievedRecordInput = z.input<typeof createRetrievedRecordSchema>;
export type CreateRetrievedRecordMatchInput = z.input<typeof createRetrievedRecordMatchSchema>;
export type CreateManuscriptSectionInput = z.input<typeof createManuscriptSectionSchema>;
export type RenameManuscriptSectionInput = z.input<typeof renameManuscriptSectionSchema>;
export type ReorderManuscriptSectionsInput = z.input<typeof reorderManuscriptSectionsSchema>;
export type ArchiveManuscriptSectionInput = z.input<typeof archiveManuscriptSectionSchema>;
export type PlaceClaimRevisionInput = z.input<typeof placeClaimRevisionSchema>;
export type ReplacePlacedClaimRevisionInput = z.input<typeof replacePlacedClaimRevisionSchema>;
export type RemoveClaimPlacementInput = z.input<typeof removeClaimPlacementSchema>;
export type ReorderSectionItemsInput = z.input<typeof reorderSectionItemsSchema>;
export type CreateProseBlockInput = z.input<typeof createProseBlockSchema>;
export type UpdateProseBlockInput = z.input<typeof updateProseBlockSchema>;
export type RemoveProseBlockInput = z.input<typeof removeProseBlockSchema>;
export type CreateEvidenceSetInput = z.input<typeof createEvidenceSetSchema>;
export type UpdateEvidenceSetMetadataInput = z.input<typeof updateEvidenceSetMetadataSchema>;
export type EvidenceSetMembershipInput = z.input<typeof evidenceSetMembershipInputSchema>;
export type ReorderEvidenceSetInput = z.input<typeof reorderEvidenceSetSchema>;
export type AppendEvidenceSetAnnotationInput = z.input<typeof appendEvidenceSetAnnotationSchema>;
export type CreateSynthesisPreparationSchemaInput = z.input<typeof createSynthesisPreparationSchema>;
export type UpdateSynthesisPreparationSchemaInput = z.input<typeof updateSynthesisPreparationSchema>;
export type ReplaceSynthesisPreparationSelectionsSchemaInput = z.input<typeof replaceSynthesisPreparationSelectionsSchema>;
export type FinalizeSynthesisPreparationSchemaInput = z.input<typeof finalizeSynthesisPreparationSchema>;
export type AppendSynthesisInterpretationSchemaInput = z.input<typeof appendSynthesisInterpretationSchema>;
export type SynthesisInterpretationLimitationSchemaInput = z.input<typeof synthesisInterpretationLimitationInputSchema>;
export type SynthesisInterpretationQuestionSchemaInput = z.input<typeof synthesisInterpretationQuestionInputSchema>;
export type SynthesisInterpretationContradictionSchemaInput = z.input<typeof synthesisInterpretationContradictionInputSchema>;
export type CreateClaimWithSynthesisSupportInput = z.input<typeof createClaimWithSynthesisSupportSchema>;
export type CreateClaimFromInterpretationInput = z.input<typeof createClaimFromInterpretationSchema>;

// Slice 20 Research Question Traceability validation schemas
export const traceabilityActionSchema = z.enum(["linked", "unlinked"]);

export const traceabilityNoteSchema = z
  .string()
  .trim()
  .min(1, "Note cannot be empty when provided")
  .max(2000, "Note must be 2000 characters or fewer")
  .nullable()
  .optional();

export const linkTraceabilityTargetSchema = z.object({
  note: traceabilityNoteSchema,
});

export const unlinkTraceabilityTargetSchema = z.object({
  note: traceabilityNoteSchema,
});

export const linkExtractionFieldSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  fieldId: idSchema,
  note: traceabilityNoteSchema,
});

export const unlinkExtractionFieldSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  fieldId: idSchema,
  note: traceabilityNoteSchema,
});

export const linkEvidenceSetSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  evidenceSetId: idSchema,
  note: traceabilityNoteSchema,
});

export const unlinkEvidenceSetSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  evidenceSetId: idSchema,
  note: traceabilityNoteSchema,
});

export const linkSynthesisStatementSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  statementId: idSchema,
  note: traceabilityNoteSchema,
});

export const unlinkSynthesisStatementSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  statementId: idSchema,
  note: traceabilityNoteSchema,
});

export const linkClaimSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  claimId: idSchema,
  note: traceabilityNoteSchema,
});

export const unlinkClaimSchema = z.object({
  projectId: idSchema,
  questionId: idSchema,
  claimId: idSchema,
  note: traceabilityNoteSchema,
});

export type LinkExtractionFieldInput = z.input<typeof linkExtractionFieldSchema>;
export type UnlinkExtractionFieldInput = z.input<typeof unlinkExtractionFieldSchema>;
export type LinkEvidenceSetInput = z.input<typeof linkEvidenceSetSchema>;
export type UnlinkEvidenceSetInput = z.input<typeof unlinkEvidenceSetSchema>;
export type LinkSynthesisStatementInput = z.input<typeof linkSynthesisStatementSchema>;
export type UnlinkSynthesisStatementInput = z.input<typeof unlinkSynthesisStatementSchema>;
export type LinkClaimInput = z.input<typeof linkClaimSchema>;
export type UnlinkClaimInput = z.input<typeof unlinkClaimSchema>;
