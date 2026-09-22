import Link from "next/link";
import { notFound } from "next/navigation";
import { addPaperAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { Alert, EmptyState, PageHeader, StatusBadge } from "@/components";
import { DomainError } from "@/domain/errors";

type PapersSearchParams = {
  error?: string;
  saved?: string;
  manualReview?: string;
  reviewTitle?: string;
  reviewAuthors?: string;
  reviewYear?: string;
  reviewVenue?: string;
  reviewDoi?: string;
  reviewAbstract?: string;
};

export default async function PapersPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<PapersSearchParams> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let papers;
  let screeningPapers;
  try {
    [papers, screeningPapers] = await Promise.all([reviewServices.listPapers(projectId), reviewServices.listScreeningPapers(projectId)]);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  const reviewTitle = query.reviewTitle ?? "";
  const reviewAuthors = query.reviewAuthors ?? "";
  const reviewYear = query.reviewYear ?? "";
  const reviewVenue = query.reviewVenue ?? "";
  const reviewDoi = query.reviewDoi ?? "";
  const reviewAbstract = query.reviewAbstract ?? "";
  const manualCandidates = query.manualReview === "1" && reviewTitle
    ? await reviewServices.findManualPaperCandidates(projectId, {
      title: reviewTitle,
      authors: reviewAuthors ? reviewAuthors.split(",").map((author) => author.trim()).filter(Boolean) : [],
      publicationYear: reviewYear ? Number(reviewYear) : null,
      venue: reviewVenue || null,
      doi: reviewDoi || null,
      abstract: reviewAbstract || null,
    })
    : [];
  const screeningByPaperId = new Map(screeningPapers.map((paper) => [paper.id, paper]));

  return (
    <div className="workspace-page papers-workspace">
      <PageHeader
        eyebrow="Papers"
        title="Paper collection"
        description="Maintain canonical Paper records here. Intake records and PDF metadata remain separate until you explicitly resolve them."
        status={<StatusBadge tone="info">{papers.length} {papers.length === 1 ? "Paper" : "Papers"}</StatusBadge>}
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
        <p className="hint">This writes a canonical Paper only after the form is submitted. DOI, title/year, and source-record matches may require an explicit duplicate acknowledgement.</p>
        {manualCandidates.length > 0 && (
          <div className="duplicate-review" role="region" aria-labelledby="duplicate-heading">
            <h3 id="duplicate-heading">Review possible duplicate Papers</h3>
            <p className="hint">Review these existing canonical records before confirming that this is a distinct work.</p>
            <div className="item-list">{manualCandidates.map((candidate) => <div className="item" key={candidate.id}><div className="item-title">{candidate.title}</div><div className="item-meta">{candidate.authors?.join(", ") || "Authors absent"}{candidate.publicationYear ? ` · ${candidate.publicationYear}` : ""}{candidate.venue ? ` · ${candidate.venue}` : ""}</div>{candidate.doi && <div className="item-meta">DOI: {candidate.doi}</div>}<div className="item-meta">Match signal: {candidate.candidateReason}</div></div>)}</div>
            <form action={addPaperAction} className="confirmation-form">
              <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="title" value={reviewTitle} /><input type="hidden" name="authors" value={reviewAuthors} /><input type="hidden" name="publicationYear" value={reviewYear} /><input type="hidden" name="venue" value={reviewVenue} /><input type="hidden" name="doi" value={reviewDoi} /><input type="hidden" name="abstract" value={reviewAbstract} />
              {manualCandidates.map((candidate) => <input key={candidate.id} type="hidden" name="candidatePaperIds" value={candidate.id} />)}
              <label className="checkbox"><input type="checkbox" name="distinctPaperAcknowledged" required /> I reviewed these candidate Papers and confirm this is a distinct work.</label>
              <button className="button" type="submit">Create distinct Paper</button>
            </form>
          </div>
        )}
        <form action={addPaperAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <div className="form-grid form-grid--two">
            <div className="field"><label htmlFor="paper-title">Title</label><input id="paper-title" name="title" required defaultValue={manualCandidates.length ? reviewTitle : undefined} placeholder="Paper title" /></div>
            <div className="field"><label htmlFor="paper-authors">Authors <span className="hint">comma-separated, in order</span></label><input id="paper-authors" name="authors" defaultValue={manualCandidates.length ? reviewAuthors : undefined} placeholder="First Author, Second Author" /></div>
            <div className="field"><label htmlFor="paper-year">Publication year <span className="hint">optional</span></label><input id="paper-year" name="publicationYear" type="number" min="1000" max="3000" defaultValue={manualCandidates.length ? reviewYear : undefined} placeholder="2024" /></div>
            <div className="field"><label htmlFor="paper-venue">Venue <span className="hint">optional</span></label><input id="paper-venue" name="venue" defaultValue={manualCandidates.length ? reviewVenue : undefined} placeholder="Journal or conference" /></div>
            <div className="field"><label htmlFor="paper-doi">DOI <span className="hint">optional</span></label><input id="paper-doi" name="doi" defaultValue={manualCandidates.length ? reviewDoi : undefined} placeholder="10.1234/example" /></div>
            <div className="field form-field--wide"><label htmlFor="paper-abstract">Abstract <span className="hint">optional · used for screening</span></label><textarea id="paper-abstract" name="abstract" defaultValue={manualCandidates.length ? reviewAbstract : undefined} placeholder="Paste the title/abstract text for screening" /></div>
          </div>
          <button className="button" type="submit">Add Paper</button>
        </form>
      </section>

      <section className="card section-card" aria-labelledby="collection-heading">
        <div className="section-heading"><div><p className="eyebrow">Canonical records</p><h2 id="collection-heading">Your Papers</h2></div><StatusBadge>{papers.length} total</StatusBadge></div>
        {papers.length === 0 ? <EmptyState title="No Papers yet" description="Add a Paper manually or choose an intake method above. A resolved intake becomes canonical only through its existing explicit workflow." /> : <div className="item-list">{papers.map((paper) => { const screening = screeningByPaperId.get(paper.id); return <article className="item" key={paper.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/papers/${paper.id}/documents`}>{paper.title}</Link><div className="item-meta">{paper.authors.length ? paper.authors.join(", ") : "Author details not added"}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}{paper.venue ? ` · ${paper.venue}` : ""}</div></div><div className="action-group"><StatusBadge tone={screening?.screeningState === "included" ? "success" : "neutral"}>{screening?.screeningState ?? "unscreened"}</StatusBadge><Link className="button ghost" href={`/projects/${projectId}/screening/${paper.id}`}>Screen</Link></div></div></article>; })}</div>}
      </section>
    </div>
  );
}
