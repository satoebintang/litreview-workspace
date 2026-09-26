import type { EvidenceLabel, EvidenceReviewState } from "@/domain/types";

export type EvidenceWorkspaceProjectionRow = Record<string, unknown>;

export function mapEvidenceWorkspaceLabel(row: EvidenceWorkspaceProjectionRow): EvidenceLabel {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    createdAt: row.created_at as Date,
    archivedAt: row.archived_at as Date | null,
  };
}

export function deriveEvidenceReviewState(decision: string | null | undefined): EvidenceReviewState {
  return decision === "needs_review" || decision === "accepted" || decision === "rejected" ? decision : "unreviewed";
}

export function evidenceReviewWarnings(state: EvidenceReviewState) {
  if (state === "unreviewed") return ["never_reviewed"] as const;
  if (state === "needs_review") return ["needs_review"] as const;
  if (state === "rejected") return ["currently_rejected"] as const;
  return [] as const;
}

export function mapEvidenceWorkspaceEvidence(row: EvidenceWorkspaceProjectionRow) {
  const documentId = row.full_text_document_id == null ? null : String(row.full_text_document_id);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    paperId: String(row.paper_id),
    sourceText: String(row.source_text),
    pageNumber: Number(row.page_number),
    fullTextDocumentId: documentId,
    documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
    extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
    extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
    note: row.note == null ? null : String(row.note),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    paper: row.paper_id == null ? null : {
      id: String(row.paper_id),
      title: String(row.paper_title ?? "Untitled paper"),
      authors: Array.isArray(row.authors) ? row.authors as string[] : [],
      publicationYear: row.publication_year == null ? null : Number(row.publication_year),
      venue: row.venue == null ? null : String(row.venue),
      doi: row.doi == null ? null : String(row.doi),
    },
    document: documentId && row.document_original_filename != null ? {
      id: documentId,
      originalFilename: String(row.document_original_filename),
      sha256: String(row.document_sha256),
      archivedAt: row.document_archived_at as Date | null,
    } : null,
  };
}
