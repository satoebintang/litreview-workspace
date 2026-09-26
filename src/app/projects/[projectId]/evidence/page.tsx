import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices, evidenceWorkspaceReadServices } from "@/app/server";
import {
  evidenceWorkspaceStates,
  type EvidenceWorkspaceState,
} from "@/application/evidence-workspace-read-services";
import { EvidenceCaptureForm } from "./EvidenceCaptureForm";
import { EvidencePaperPicker } from "./EvidencePaperPicker";
import { ConfirmAction } from "@/components/ConfirmAction";
import {
  archiveEvidenceLabelAction,
  createEvidenceLabelAction,
} from "@/app/actions";

type PageSearchParams = {
  state?: string;
  paperId?: string;
  capturePaperId?: string;
  labelId?: string;
  fullTextDocumentId?: string;
  documentProvenance?: string;
  documentTextExtractionId?: string;
  pageNumber?: string;
  usage?: string;
  page?: string;
  error?: string;
  saved?: string;
};

const stateLabels: Record<EvidenceWorkspaceState, string> = {
  attention: "Attention",
  unreviewed: "Unreviewed",
  needs_review: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
  all: "All",
};

const provenanceOptions = ["any", "none", "document", "extraction"] as const;
const usageOptions = ["any", "used", "unused"] as const;
const preservedFilters: Array<keyof PageSearchParams> = [
  "state",
  "paperId",
  "labelId",
  "fullTextDocumentId",
  "documentProvenance",
  "documentTextExtractionId",
  "pageNumber",
  "usage",
  "capturePaperId",
];

function requestedPage(value?: string) {
  const parsed = value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function isUuid(value?: string) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export default async function EvidenceWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<PageSearchParams>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  const state = evidenceWorkspaceStates.includes(query.state as EvidenceWorkspaceState) ? query.state as EvidenceWorkspaceState : "attention";
  const documentProvenance = query.documentProvenance ?? "any";
  const usage = query.usage ?? "any";
  const page = requestedPage(query.page);

  let workspace;
  let labels;
  let paperOptions;
  let filterPaper;
  let capturePaper;
  try {
    [workspace, labels, paperOptions, filterPaper, capturePaper] = await Promise.all([
      evidenceWorkspaceReadServices.getEvidenceWorkspacePage(projectId, {
        state,
        paperId: query.paperId || undefined,
        labelId: query.labelId || undefined,
        fullTextDocumentId: query.fullTextDocumentId || undefined,
        documentProvenance: documentProvenance as "any" | "none" | "document" | "extraction",
        documentTextExtractionId: query.documentTextExtractionId || undefined,
        pageNumber: query.pageNumber === undefined || query.pageNumber === "" ? undefined : Number(query.pageNumber),
        usage: usage as "any" | "used" | "unused",
        page,
      }),
      reviewServices.listEvidenceLabels(projectId, true),
      evidenceWorkspaceReadServices.searchEvidencePaperOptions({ projectId, page: 1, pageSize: 20 }),
      query.paperId && isUuid(query.paperId)
        ? evidenceWorkspaceReadServices.getEvidencePaperOption(projectId, query.paperId)
        : Promise.resolve(null),
      query.capturePaperId && isUuid(query.capturePaperId)
        ? evidenceWorkspaceReadServices.getEvidencePaperOption(projectId, query.capturePaperId)
        : Promise.resolve(null),
    ]);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  const pageHref = (pageNumber: number) => {
    const params = new URLSearchParams();
    for (const key of preservedFilters) {
      const value = query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    if (pageNumber > 1) params.set("page", String(pageNumber));
    const suffix = params.toString();
    return `/projects/${projectId}/evidence${suffix ? `?${suffix}` : ""}`;
  };

  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header">
        <div><p className="eyebrow">Evidence curation</p><h1>Evidence workspace</h1><p>Review researcher curation around immutable source passages.</p></div>
        <span className="status supported">{workspace.totalCount} matching</span>
      </div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}
      {query.saved && <div className="success-note" role="status">{query.saved === "evidence" ? "Evidence recorded with source provenance." : query.saved === "label" ? "Label change saved." : query.saved === "label-archived" ? "Label archived." : "Curation change saved."}</div>}

      <div className="workspace-grid">
        <section className="card section-card full" aria-labelledby="capture-evidence-heading">
          <div className="section-heading"><div><p className="eyebrow">Source capture</p><h2 id="capture-evidence-heading">Record Evidence</h2></div><span className="count">Manual capture</span></div>
          {paperOptions.totalCount === 0
            ? <div className="empty">Add a Paper before recording a source passage.</div>
            : <EvidenceCaptureForm
              projectId={projectId}
              capturePaperId={query.capturePaperId}
              selectedPaper={capturePaper}
              papers={paperOptions}
            />}
        </section>

        <section className="card section-card full" aria-labelledby="evidence-filter-heading">
          <div className="section-heading"><h2 id="evidence-filter-heading">Filter Evidence</h2><span className="count">{stateLabels[workspace.state]}</span></div>
          <form method="get" className="filter-grid">
            <input type="hidden" name="capturePaperId" value={query.capturePaperId ?? ""} />
            <div className="field"><label htmlFor="evidence-state">Review state</label><select id="evidence-state" name="state" defaultValue={workspace.state}>{evidenceWorkspaceStates.map((item) => <option key={item} value={item}>{stateLabels[item]}</option>)}</select></div>
            <div className="field">
              <EvidencePaperPicker
                key={`${projectId}:filter-paper`}
                projectId={projectId}
                fieldName="paperId"
                label="Evidence queue filter"
                initialPaperId={query.paperId}
                initialSelectedPaper={filterPaper}
                initialPage={paperOptions}
              />
            </div>
            <div className="field"><label htmlFor="evidence-label-filter">Current label</label><select id="evidence-label-filter" name="labelId" defaultValue={query.labelId ?? ""}><option value="">All labels</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</option>)}</select></div>
            <div className="field"><label htmlFor="evidence-provenance">Document provenance</label><select id="evidence-provenance" name="documentProvenance" defaultValue={provenanceOptions.includes(documentProvenance as typeof provenanceOptions[number]) ? documentProvenance : "any"}>{provenanceOptions.map((item) => <option key={item} value={item}>{item === "any" ? "Any" : item === "none" ? "No document" : item === "document" ? "Document" : "Extraction"}</option>)}</select></div>
            <div className="field"><label htmlFor="evidence-document-id">Full-text document ID</label><input id="evidence-document-id" name="fullTextDocumentId" defaultValue={query.fullTextDocumentId ?? ""} /></div>
            <div className="field"><label htmlFor="evidence-text-extraction-id">Document text extraction ID</label><input id="evidence-text-extraction-id" name="documentTextExtractionId" defaultValue={query.documentTextExtractionId ?? ""} /></div>
            <div className="field"><label htmlFor="evidence-page-number-filter">Source page number</label><input id="evidence-page-number-filter" name="pageNumber" type="number" min="1" defaultValue={query.pageNumber ?? ""} /></div>
            <div className="field"><label htmlFor="evidence-usage">Downstream usage</label><select id="evidence-usage" name="usage" defaultValue={usageOptions.includes(usage as typeof usageOptions[number]) ? usage : "any"}>{usageOptions.map((item) => <option key={item} value={item}>{item === "any" ? "Any" : item === "used" ? "Used" : "Unused"}</option>)}</select></div>
            <div className="field" style={{ alignSelf: "end" }}><button className="button secondary" type="submit">Apply filters</button></div>
          </form>
        </section>

        <section className="card section-card full">
          <div className="section-heading"><h2>Evidence queue</h2><span className="count">{workspace.items.length} shown</span></div>
          <p className="hint" aria-live="polite">{workspace.from}–{workspace.to} of {workspace.totalCount}</p>
          {workspace.items.length === 0 ? <div className="empty">No Evidence matches this curation view.</div> : <div className="item-list">{workspace.items.map((item) => <article className="item" key={item.id}>
            <div className="item-row"><div><div className="quote">“{item.sourceText}”</div><div className="item-meta">Page {item.pageNumber} · <span className="paper-chip">{item.paper?.title ?? "Source paper"}</span></div></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><span className={`status ${item.reviewState === "rejected" ? "withdrawn" : item.reviewState === "accepted" ? "supported" : "stale"}`}>{stateLabels[item.reviewState]}</span>{item.usage === "used" && <span className="status supported">Used downstream</span>}</div></div>
            <div className="item-meta">{item.fullTextDocumentId ? <Link href={`/projects/${projectId}/papers/${item.paperId}/documents/${item.fullTextDocumentId}`}>Document artifact{item.document?.archivedAt ? " (archived)" : ""}</Link> : "Document artifact: none recorded"}{item.documentTextExtractionId ? <> · exact extraction span [{item.extractionStartOffset}, {item.extractionEndOffset})</> : null}</div>
            {item.labels.length > 0 && <div className="path-list">{item.labels.map((label) => <span key={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</span>)}</div>}
            {item.warnings.length > 0 && <div className="support-warning">{item.reviewState === "rejected" ? "Currently rejected for new direct use." : item.reviewState === "needs_review" ? "This Evidence needs review." : "This Evidence has never been reviewed."}</div>}
            <div style={{ marginTop: 10 }}><Link className="button ghost" href={`/projects/${projectId}/evidence/${item.id}`}>Open Evidence detail →</Link></div>
          </article>)}</div>}
          <nav className="pagination" aria-label="Evidence workspace pages">
            {workspace.hasPrevious ? <Link className="button ghost" href={pageHref(workspace.page - 1)}>Previous</Link> : <span className="button ghost disabled" aria-disabled="true">Previous</span>}
            <span>Page {workspace.page} of {workspace.totalPages || 1}</span>
            {workspace.hasNext ? <Link className="button ghost" href={pageHref(workspace.page + 1)}>Next</Link> : <span className="button ghost disabled" aria-disabled="true">Next</span>}
          </nav>
        </section>

        <section className="card section-card">
          <div className="section-heading"><h2>Project labels</h2><span className="count">{labels.filter((label) => !label.archivedAt).length} active</span></div>
          <form action={createEvidenceLabelAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="label-name">New label</label><input id="label-name" name="name" required maxLength={100} placeholder="methodology" /></div><div className="field"><label htmlFor="label-description">Description <span className="hint">optional</span></label><textarea id="label-description" name="description" maxLength={500} /></div><button className="button" type="submit">Create label</button></form>
          <div className="item-list" style={{ marginTop: 18 }}>{labels.length === 0 ? <div className="empty">No labels yet.</div> : labels.map((label) => <article className="item" key={label.id}><div className="item-row"><div><div className="item-title">{label.name}</div>{label.description && <div className="item-meta">{label.description}</div>}</div>{label.archivedAt ? <span className="status stale">Archived</span> : <ConfirmAction action={archiveEvidenceLabelAction} label="Archive" title="Archive this Evidence label?" consequence={`The label “${label.name}” will no longer be assignable. Historical label events remain preserved.`} hiddenFields={{ projectId, labelId: label.id }} confirmLabel="Archive label" />}</div></article>)}</div>
        </section>
      </div>
      <p className="footer-note">Curation never edits source text, Paper identity, document provenance, extraction identity, page, or offsets.</p>
    </div>
  </div>;
}
