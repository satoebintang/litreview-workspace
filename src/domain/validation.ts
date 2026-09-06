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
  // Validate blankness without transforming the quotation: source text is provenance.
  sourceText: z.string().refine((value) => value.trim().length > 0, "Source text is required"),
  pageNumber: z.number().int().positive(),
  note: optionalText,
});

export const createClaimSchema = z.object({
  claimText: z.string().trim().min(1),
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

export const extractionComparisonFilterSchema = z.object({
  paperIds: z.array(idSchema).optional(),
  valueState: z.enum(["present", "not_reported", "not_applicable", "cleared", "not_extracted"]).optional(),
  search: z.string().trim().max(500).optional(),
  optionId: idSchema.optional(),
  booleanValue: z.boolean().optional(),
});

const manuscriptSectionTypeSchema = z.enum(["introduction", "methods", "results", "discussion", "limitations", "conclusion", "custom"]);

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
export type CreateClaimInput = z.input<typeof createClaimSchema>;
export type ClaimSupportInput = z.input<typeof claimSupportSchema>;
export type ClaimRevisionSnapshotInput = z.input<typeof claimRevisionSnapshotSchema>;
export type CreateClaimRevisionInput = z.input<typeof createClaimRevisionSchema>;
export type WithdrawClaimInput = z.input<typeof withdrawClaimSchema>;
export type CreateScreeningCriterionInput = z.input<typeof createScreeningCriterionSchema>;
export type RecordScreeningDecisionInput = z.input<typeof recordScreeningDecisionSchema>;
export type CreateExtractionFieldInput = z.input<typeof createExtractionFieldSchema>;
export type UpdateExtractionFieldInput = z.input<typeof updateExtractionFieldSchema>;
export type CreateExtractionOptionInput = z.input<typeof createExtractionOptionSchema>;
export type ReviseExtractionValueInput = z.input<typeof reviseExtractionValueSchema>;
export type SynthesisRevisionInput = z.input<typeof synthesisRevisionInputSchema>;
export type SynthesisWithdrawalInput = z.input<typeof synthesisWithdrawalSchema>;
export type ExtractionComparisonFilter = z.input<typeof extractionComparisonFilterSchema>;
export type CreateManuscriptInput = z.input<typeof createManuscriptSchema>;
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
