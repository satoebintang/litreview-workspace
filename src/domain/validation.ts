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
});

export const claimEvidenceInputSchema = z.object({
  claimId: idSchema,
  evidenceId: idSchema,
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

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreatePaperInput = z.input<typeof createPaperSchema>;
export type RecordEvidenceInput = z.input<typeof recordEvidenceSchema>;
export type CreateClaimInput = z.input<typeof createClaimSchema>;
export type CreateScreeningCriterionInput = z.input<typeof createScreeningCriterionSchema>;
export type RecordScreeningDecisionInput = z.input<typeof recordScreeningDecisionSchema>;
export type CreateExtractionFieldInput = z.input<typeof createExtractionFieldSchema>;
export type UpdateExtractionFieldInput = z.input<typeof updateExtractionFieldSchema>;
export type CreateExtractionOptionInput = z.input<typeof createExtractionOptionSchema>;
export type ReviseExtractionValueInput = z.input<typeof reviseExtractionValueSchema>;
