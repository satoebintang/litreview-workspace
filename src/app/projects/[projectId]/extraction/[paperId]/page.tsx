import { notFound } from "next/navigation";
import { aiExtractionProviderAvailable, extractionReadServices, reviewServices } from "@/app/server";
import { decodeExtractionEvidenceCandidateCursor, hashExtractionEvidenceSearchQuery } from "@/application/extraction-evidence-selection-cursor";
import { normalizeExtractionEvidenceSearchQuery } from "@/application/extraction-evidence-search-query";
import { DomainError } from "@/domain/errors";
import type { ExtractionFieldType } from "@/domain/types";
import { ExtractionWorksheet } from "./ExtractionWorksheet";

type SearchParams = Record<string, string | string[] | undefined>;

function queryValue(query: SearchParams, key: string): string | null {
  const value = query[key];
  return typeof value === "string" ? value : null;
}

function boundedBrowseState(query: SearchParams, projectId: string, paperId: string, fieldIds: string[]) {
  const hasBrowseState = ["evidenceField", "evidenceAfter", "evidencePageSize", "evidenceQuery"].some((key) => query[key] !== undefined);
  const firstFieldId = fieldIds[0] ?? null;
  if (!hasBrowseState || !firstFieldId) {
    return { open: false, fieldId: firstFieldId, after: null, pageSize: 20, query: "", queryError: null };
  }
  const rawQuery = query.evidenceQuery === undefined ? "" : query.evidenceQuery;
  let evidenceQuery = typeof rawQuery === "string" ? rawQuery : "";
  let queryError: string | null = null;
  try {
    evidenceQuery = normalizeExtractionEvidenceSearchQuery(rawQuery);
  } catch (error) {
    queryError = error instanceof Error ? error.message : "Evidence search query is invalid.";
  }
  const requestedField = queryValue(query, "evidenceField");
  const fieldId = requestedField && fieldIds.includes(requestedField) ? requestedField : firstFieldId;
  const requestedSize = queryValue(query, "evidencePageSize");
  let pageSize = requestedSize && /^\d+$/.test(requestedSize) ? Number(requestedSize) : 20;
  const invalidPageSize = !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50;
  if (invalidPageSize) pageSize = 20;
  let after = queryValue(query, "evidenceAfter");
  const invalidBrowseShape = !requestedField || !fieldIds.includes(requestedField) || query.evidenceAfter !== after || invalidPageSize;
  if (queryError === null && invalidBrowseShape) after = null;
  if (queryError === null && after) {
    try {
      decodeExtractionEvidenceCandidateCursor(after, {
        projectId,
        paperId,
        pageSize,
        queryHash: hashExtractionEvidenceSearchQuery(evidenceQuery),
      });
    } catch {
      after = null;
      pageSize = 20;
    }
  }
  return { open: true, fieldId, after, pageSize, query: evidenceQuery, queryError };
}

export default async function ExtractionPaperPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let extraction;
  try {
    extraction = await extractionReadServices.getPaperExtractionWorksheet(projectId, paperId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const preferredDocument = await reviewServices.getPreferredFullTextDocument(projectId, paperId);
  const sourceExtraction = preferredDocument ? await reviewServices.getLatestDocumentTextExtraction(projectId, preferredDocument.id) : null;
  const included = extraction.reviewStatus.finalEligibility === "included";
  const historicalOnly = !included && extraction.reviewStatus.warnings.includes("legacy_analysis_precedes_full_text_screening");
  const savedMessage = query.saved === "value" ? "Extraction revision saved." : query.saved === "evidence" ? "Evidence support revised as a new extraction revision." : undefined;
  const fieldIds = extraction.fields.map((field) => field.id);
  const initialBrowse = boundedBrowseState(query, projectId, paperId, fieldIds);
  const requestedDraftField = queryValue(query, "draftField");
  const activeDraftFieldId = requestedDraftField && fieldIds.includes(requestedDraftField) ? requestedDraftField : null;
  const aiSuggestion = preferredDocument && sourceExtraction ? {
    providerAvailable: aiExtractionProviderAvailable,
    fullTextDocumentId: preferredDocument.id,
    documentTextExtractionId: sourceExtraction.id,
  } : null;

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Structured extraction · {included ? "Included paper" : "Paper not included"}</p><h1>{extraction.paper.title}</h1><p>{extraction.paper.authors.join(", ") || "Author details not added"}{extraction.paper.publicationYear ? ` · ${extraction.paper.publicationYear}` : ""}{extraction.paper.venue ? ` · ${extraction.paper.venue}` : ""}</p></div><span className={`status screening-${extraction.reviewStatus.titleAbstractState}`}>{extraction.reviewStatus.titleAbstractState}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      {!included && <div className="error-banner" role="status">{historicalOnly ? "This Paper has historical extraction work from before full-text screening. Its existing revisions remain readable in Field audit pages, but new revisions cannot be saved until it is finally included." : "Extraction is available for finally included Papers only. This Paper’s existing revisions remain readable in Field audit pages, but new revisions cannot be saved."}</div>}
      <section className="card section-card extraction-worksheet"><div className="section-heading"><div><h2>Extraction worksheet</h2><p className="hint">Structured observations are separate from the verbatim Evidence passages that support them.</p></div><span className="count">{extraction.progress.completedRequired} / {extraction.progress.requiredCount} required · {extraction.progress.percentage ?? 0}%</span></div>
        {extraction.values.length === 0 ? <div className="empty">No active extraction fields are configured yet.</div> : <ExtractionWorksheet
          projectId={projectId}
          paperId={paperId}
          values={extraction.values.map((value) => ({
            ...value,
            field: { ...value.field, fieldType: value.field.fieldType as ExtractionFieldType },
          }))}
          included={included}
          initialBrowse={initialBrowse}
          activeDraftFieldId={activeDraftFieldId}
          aiSuggestion={aiSuggestion}
        />}
      </section>
      <p className="footer-note">Each save records the complete observation, note, and Evidence set as a new immutable revision. Older revisions retain their own provenance. A successful save redirects the page, so unsaved drafts in other Fields are not guaranteed to survive.</p>
      <p className="footer-note">The Evidence browser loads bounded pages only when opened. Passage and note search checks complete Evidence text, so the matching words may be outside the visible preview; open exact Evidence detail to inspect the full source record.</p>
      <p className="footer-note">When a response state is not “Value reported,” the released save parser omits the researcher note from the new revision. The note remains visible in the draft until a successful save, but is not saved for those states.</p>
    </div></div>;
}
