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

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreatePaperInput = z.input<typeof createPaperSchema>;
export type RecordEvidenceInput = z.input<typeof recordEvidenceSchema>;
export type CreateClaimInput = z.input<typeof createClaimSchema>;
