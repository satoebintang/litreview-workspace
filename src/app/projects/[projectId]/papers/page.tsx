import Link from "next/link";
import { notFound } from "next/navigation";
import { ManualPaperForm } from "./ManualPaperForm";
import { paperCollectionReadServices } from "@/app/server";
import { PAPER_COLLECTION_DEFAULT_PAGE_SIZE } from "@/application/paper-collection-read-services";
import { Alert, EmptyState, PageHeader, StatusBadge } from "@/components";
import { DomainError } from "@/domain/errors";

type PapersSearchParams = {
  error?: string;
  page?: string;
  saved?: string;
};

function pageHref(projectId: string, page: number) {
  const path = `/projects/${projectId}/papers`;
  return page === 1 ? path : `${path}?page=${page}`;
}

export default async function PapersPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<PapersSearchParams> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let collection;
  try {
    collection = await paperCollectionReadServices.getPaperCollectionPage(projectId, {
      page: query.page,
      pageSize: PAPER_COLLECTION_DEFAULT_PAGE_SIZE,
    });
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (!collection) notFound();

  return (
    <div className="workspace-page papers-workspace">
      <PageHeader
        eyebrow="Papers"
        title="Paper collection"
        description="Maintain canonical Paper records here. Intake records and PDF metadata remain separate until you explicitly resolve them."
        status={<StatusBadge tone="info">{collection.totalCount} {collection.totalCount === 1 ? "Paper" : "Papers"}</StatusBadge>}
        actions={<div className="action-group"><Link className="button secondary" href={`/projects/${projectId}/screening`}>Review screening <span aria-hidden="true">→</span></Link><Link className="button ghost" href={`/projects/${projectId}/papers/export`}>Export BibTeX</Link></div>}
      />
      {query.error && <Alert tone="danger" title="Could not add that Paper">{query.error}</Alert>}
      {query.saved === "paper" && <Alert tone="success" title="Paper added">The canonical Paper is now in this collection.</Alert>}

      <section className="card section-card" aria-labelledby="intake-heading">
        <div className="section-heading"><div><p className="eyebrow">Acquisition boundaries</p><h2 id="intake-heading">Choose how to add source records</h2></div></div>
        <div className="intake-grid">
          <div className="intake-card"><h3>Manual entry</h3><p>Add a canonical Paper directly after reviewing possible duplicates.</p><a href="#manual-paper">Go to manual entry</a></div>
          <div className="intake-card"><h3>DOI lookup</h3><p>A bounded bibliographic proposal. It never creates a Paper without explicit resolution.</p><Link href={`/projects/${projectId}/papers/doi-intake`}>Open DOI lookup</Link></div>
          <div className="intake-card"><h3>BibTeX / RIS import</h3><p>Imported records remain intake provenance until each resolution is accepted.</p><Link href={`/projects/${projectId}/papers/imports`}>Open import history</Link></div>
          <div className="intake-card"><h3>PDF intake</h3><p>PDF metadata and document artifacts remain separate until you resolve them to a Paper.</p><Link href={`/projects/${projectId}/papers/pdf-intake`}>Open PDF intake</Link></div>
          <div className="intake-card"><h3>Search acquisition</h3><p>Recorded searches and retrieved records stay in the Plan workspace until matched or created explicitly.</p><Link href={`/projects/${projectId}/protocol`}>Open Plan</Link></div>
        </div>
      </section>

      <section className="card section-card" id="manual-paper" aria-labelledby="manual-paper-heading">
        <div className="section-heading"><div><p className="eyebrow">Canonical Paper</p><h2 id="manual-paper-heading">Add a Paper manually</h2></div></div>
        <p className="hint">Review possible duplicates before adding a canonical Paper. If candidates are found, acknowledge that you reviewed them and that this is a distinct work.</p>
        <ManualPaperForm projectId={projectId} />
      </section>

      <section className="card section-card" aria-labelledby="collection-heading">
        <div className="section-heading"><div><p className="eyebrow">Canonical records</p><h2 id="collection-heading">Your Papers</h2></div><StatusBadge>{collection.totalCount} total</StatusBadge></div>
        <p className="hint" aria-live="polite">{collection.from}–{collection.to} of {collection.totalCount}</p>
        {collection.items.length === 0 ? <EmptyState title="No Papers yet" description="Add a Paper manually or choose an intake method above. A resolved intake becomes canonical only through its existing explicit workflow." /> : <div className="item-list">{collection.items.map((paper) => <article className="item" key={paper.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/papers/${paper.id}/documents`}>{paper.title}</Link><div className="item-meta">{paper.authors.length ? paper.authors.join(", ") : "Author details not added"}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}{paper.venue ? ` · ${paper.venue}` : ""}</div></div><div className="action-group"><StatusBadge tone={paper.screeningState === "included" ? "success" : "neutral"}>{paper.screeningState}</StatusBadge><Link className="button ghost" href={`/projects/${projectId}/screening/${paper.id}`}>Screen</Link></div></div></article>)}</div>}
        {collection.totalPages > 1 && <nav className="item-row" aria-label="Paper collection pagination" style={{ marginTop: 16, gap: 12 }}>
          <div className="action-group">
            {collection.hasPrevious ? <Link className="button ghost" href={pageHref(projectId, collection.page - 1)} aria-label="Previous page">Previous</Link> : <span className="button ghost disabled" aria-disabled="true">Previous</span>}
            <span aria-current="page" aria-live="polite">Page {collection.page} of {collection.totalPages}</span>
            {collection.hasNext ? <Link className="button ghost" href={pageHref(projectId, collection.page + 1)} aria-label="Next page">Next</Link> : <span className="button ghost disabled" aria-disabled="true">Next</span>}
          </div>
        </nav>}
      </section>
    </div>
  );
}
