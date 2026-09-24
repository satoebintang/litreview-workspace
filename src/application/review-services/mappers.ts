import type { ExtractionFieldType, SynthesisState } from "@/domain/types";

export function mapEvidence(row: Record<string, unknown>) {
  const documentId = row.full_text_document_id == null ? null : String(row.full_text_document_id);
  const document = documentId && row.document_original_filename != null ? {
    id: documentId,
    originalFilename: String(row.document_original_filename),
    mediaType: "application/pdf" as const,
    byteSize: Number(row.document_byte_size),
    sha256: String(row.document_sha256),
    createdAt: row.document_created_at as Date,
    archivedAt: row.document_archived_at as Date | null,
  } : null;
  return {
    id: String(row.id), projectId: String(row.project_id), paperId: String(row.paper_id),
    fullTextDocumentId: documentId, document,
    documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
    sourceText: String(row.source_text), pageNumber: Number(row.page_number), note: row.note == null ? null : String(row.note),
    extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
    extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
    reviewState: undefined as "unreviewed" | "needs_review" | "accepted" | "rejected" | undefined,
    curationWarning: undefined as "never_reviewed" | "needs_review" | "currently_rejected" | null | undefined,
    createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
  };
}

export type MappedEvidence = ReturnType<typeof mapEvidence>;

export function mapPaper(row: Record<string, unknown>) {
  return {
    id: String(row.paper_id_value ?? row.paper_id ?? row.id), projectId: String(row.project_id), title: String(row.paper_title ?? row.title),
    authors: (row.authors as string[]) ?? [], publicationYear: row.publication_year as number | null,
    venue: row.venue as string | null, doi: row.doi as string | null, abstract: row.abstract as string | null,
    bibliographicNote: row.bibliographic_note as string | null, createdAt: row.paper_created_at as Date ?? row.created_at as Date,
    updatedAt: row.paper_updated_at as Date ?? row.updated_at as Date,
  };
}

export function mapField(row: Record<string, unknown>) {
  return {
    id: String(row.field_id_value ?? row.field_id), projectId: String(row.project_id), name: String(row.field_name ?? row.name),
    description: row.field_description as string | null, fieldType: (row.field_type_value ?? row.field_type) as ExtractionFieldType,
    required: Boolean(row.required), sortOrder: Number(row.sort_order), createdAt: row.field_created_at as Date,
    updatedAt: row.field_updated_at as Date, archivedAt: row.field_archived_at as Date | null,
  };
}

export function mapExtractionRevision(row: Record<string, unknown>, evidence: MappedEvidence[] = []) {
  return {
    id: String(row.revision_id ?? row.id), sequence: Number(row.revision_sequence ?? row.sequence), projectId: String(row.project_id),
    paperId: String(row.paper_id), fieldId: String(row.field_id), extractionValueId: String(row.extraction_value_id),
    fieldType: (row.field_type_value ?? row.field_type) as ExtractionFieldType, valueState: String(row.value_state) as "present" | "not_reported" | "not_applicable" | "cleared",
    textValue: row.text_value as string | null, numberValue: row.number_value as string | null, booleanValue: row.boolean_value as boolean | null,
    optionId: row.option_id as string | null, researcherNote: (row.revision_note ?? row.researcher_note) as string | null,
    createdAt: (row.revision_created_at ?? row.created_at) as Date, finalizedAt: (row.revision_finalized_at ?? row.finalized_at) as Date | null,
    evidence,
  };
}

export function mapSynthesisRow(row: Record<string, unknown>) {
  const statement = {
    id: String(row.statement_id), projectId: String(row.project_id), createdAt: row.statement_created_at as Date,
  };
  const revision = {
    id: String(row.revision_id), sequence: Number(row.sequence), projectId: String(row.project_id),
    synthesisStatementId: String(row.synthesis_statement_id), state: String(row.state) as "active" | "withdrawn",
    title: row.title as string | null, statementText: row.statement_text as string | null, researcherNote: row.researcher_note as string | null,
    createdAt: row.created_at as Date, finalizedAt: row.finalized_at as Date | null,
  };
  return { statement, revision };
}

export function mapScreeningState(value: unknown) {
  const state = String(value);
  return state === "include" ? "included" : state === "exclude" ? "excluded" : state === "maybe" ? "maybe" : "unscreened";
}

export type MappedSynthesisState = SynthesisState;
