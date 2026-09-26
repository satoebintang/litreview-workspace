import Link from "next/link";
import { notFound } from "next/navigation";
import { createClaimRevisionAction, createClaimFromInterpretationAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { claimReadServices, reviewServices } from "@/app/server";
import type { ClaimLedgerFilter } from "@/application/claim-read-services";

function claimsHref(projectId: string, query: { interpretationId?: string; synthesisRevisionId?: string }, filter?: ClaimLedgerFilter, page?: number) {
  const params = new URLSearchParams();
  if (filter && filter !== "all") params.set("filter", filter);
  if (page && page > 1) params.set("page", String(page));
  if (query.interpretationId) params.set("interpretationId", query.interpretationId);
  if (query.synthesisRevisionId) params.set("synthesisRevisionId", query.synthesisRevisionId);
  const search = params.toString();
  return `/projects/${projectId}/claims${search ? `?${search}` : ""}`;
}

export default async function ClaimsWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{
    error?: string;
    saved?: string;
    filter?: string;
    page?: string;
    interpretationId?: string;
    synthesisRevisionId?: string;
  }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let ledger;
  try {
    ledger = await claimReadServices.getClaimLedgerPage(projectId, {
      filter: query.filter,
      page: query.page === undefined ? undefined : Number(query.page),
    });
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (!ledger) notFound();
  let interpretation: Awaited<ReturnType<typeof reviewServices.getSynthesisInterpretationSnapshot>> | null = null;
  if (query.interpretationId) {
    try {
      interpretation = await reviewServices.getSynthesisInterpretationSnapshot(projectId, query.interpretationId);
    } catch {
      interpretation = null;
    }
  }
  const filter = ledger.filter;
  return (
    <div className="project-page">
      <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Manuscript claims</p><h1>Claims workspace</h1><p>Write researcher-authored assertions and keep every support choice tied to exact research history.</p></div><span className="status supported">● {ledger.counts.all} {ledger.counts.all === 1 ? "claim" : "claims"}</span></div>

        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {query.saved && <div className="success-note" role="status">{query.saved === "created_from_interpretation" ? "Claim created with exact synthesis support from interpretation context." : query.saved === "created" ? "Claim created as unsupported." : query.saved === "revised" ? "New Claim revision saved." : query.saved === "withdrawn" ? "Claim withdrawn. Its history remains available." : query.saved === "reactivated" ? "Claim reactivated with an explicit support snapshot." : "Claim updated."}</div>}
        <div className="screening-stats claim-stats" aria-label="Claim summary"><Link className={`screening-stat ${filter === "all" ? "active" : ""}`} href={claimsHref(projectId, query, "all")}><span>All claims</span><strong>{ledger.counts.all}</strong></Link><Link className={`screening-stat ${filter === "supported" ? "active" : ""}`} href={claimsHref(projectId, query, "supported")}><span>Supported</span><strong>{ledger.counts.supported}</strong></Link><Link className={`screening-stat ${filter === "unsupported" ? "active" : ""}`} href={claimsHref(projectId, query, "unsupported")}><span>Unsupported</span><strong>{ledger.counts.unsupported}</strong></Link><Link className={`screening-stat ${filter === "withdrawn" ? "active" : ""}`} href={claimsHref(projectId, query, "withdrawn")}><span>Withdrawn</span><strong>{ledger.counts.withdrawn}</strong></Link></div>
        <div className="workspace-grid">
          {interpretation ? (
            <section className="card section-card">
              <div className="section-heading">
                <h2>New claim from interpretation</h2>
                <span className="count">Exact synthesis support</span>
              </div>
              <div className="draft-claim-banner" style={{ marginBottom: 16 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>
                  Drafting from Synthesis Interpretation snapshot #{interpretation.sequence}
                </p>
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  This claim will be created with exact support for Synthesis Revision {interpretation.synthesisRevisionId.slice(0, 8)}. Interpretation structure and notes remain in the descriptive layer.
                </p>
              </div>
              <form action={createClaimFromInterpretationAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="interpretationId" value={interpretation.id} />
                <input type="hidden" name="synthesisRevisionId" value={query.synthesisRevisionId ?? interpretation.synthesisRevisionId} />
                <div className="field">
                  <label htmlFor="claim-text">Claim text</label>
                  <textarea id="claim-text" name="claimText" required defaultValue={interpretation.summary} />
                </div>
                <div className="field">
                  <label htmlFor="claim-note">Researcher note <span className="hint">optional</span></label>
                  <textarea id="claim-note" name="researcherNote" placeholder="Context for this assertion" />
                </div>
                <button className="button" type="submit">Create claim with synthesis support</button>
              </form>
            </section>
          ) : (
            <section className="card section-card">
              <div className="section-heading"><h2>New claim</h2><span className="count">Starts unsupported</span></div>
              <p className="hint" style={{ marginBottom: 18 }}>Capture the assertion first. Add exact Evidence, extracted observations, or syntheses from the Claim detail page.</p>
              <form action={createClaimRevisionAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <div className="field">
                  <label htmlFor="claim-text">Claim text</label>
                  <textarea id="claim-text" name="claimText" required placeholder="State a researcher-authored manuscript assertion" />
                </div>
                <div className="field">
                  <label htmlFor="claim-note">Researcher note <span className="hint">optional</span></label>
                  <textarea id="claim-note" name="researcherNote" placeholder="Context for this assertion" />
                </div>
                <button className="button" type="submit">Create unsupported claim</button>
              </form>
            </section>
          )}
          <section className="card section-card"><div className="section-heading"><h2>Support model</h2><span className="count">Exact by revision</span></div><div className="feature-list"><div className="feature"><span className="feature-number">01</span><p><strong>Supporting Evidence</strong><br />Direct source passages remain exact, including passages from excluded Papers.</p></div><div className="feature"><span className="feature-number">02</span><p><strong>Supporting observations</strong><br />Select a finalized ExtractionRevision deliberately; newer values never retarget history.</p></div><div className="feature"><span className="feature-number">03</span><p><strong>Supporting syntheses</strong><br />Cross-paper conclusions retain their exact revision and underlying evidence paths.</p></div></div></section>
          <section className="card section-card full"><div className="section-heading"><h2>Claim ledger</h2><span className="count">{ledger.items.length} shown · {ledger.citationCandidateTotal} citation candidates</span></div>
            {ledger.items.length === 0 ? <div className="empty">{ledger.counts.all === 0 ? "Claims start here. Create an unsupported assertion above." : "No claims match this filter."}</div> : <div className="item-list">{ledger.items.map((claim) => <article className="item" key={claim.claimId}><div className="item-row"><div style={{ minWidth: 0 }}><div className="item-title claim-list-title">{claim.claimText ?? "Claim withdrawn"}</div><div className="item-meta">Revision {claim.sequence} · {claim.totalSupportCount} supporting {claim.totalSupportCount === 1 ? "object" : "objects"} · {claim.citationCandidateCount} citation {claim.citationCandidateCount === 1 ? "candidate" : "candidates"}</div></div><div className="claim-list-actions"><span className={`status ${claim.lifecycle === "withdrawn" ? "withdrawn" : claim.supportStatus}`}>{claim.lifecycle === "withdrawn" ? "Withdrawn" : claim.supportStatus === "supported" ? "● Supported" : "○ Unsupported"}</span><Link className="button ghost" href={`/projects/${projectId}/claims/${claim.claimId}`}>Inspect claim →</Link></div></div></article>)}</div>}
            <nav className="extraction-progress-pagination" aria-label="Claim ledger pagination">
              <p className="hint" aria-live="polite">{ledger.from}–{ledger.to} of {ledger.totalCount}</p>
              <div className="action-group" aria-label="Claim ledger page controls">
                {ledger.hasPrevious ? <Link className="button secondary" href={claimsHref(projectId, query, filter, ledger.page - 1)} rel="prev" aria-label="Previous page">Previous</Link> : <button className="button secondary" type="button" disabled aria-label="Previous page">Previous</button>}
                <span aria-current="page">Page {ledger.page} of {Math.max(1, ledger.totalPages)}</span>
                {ledger.hasNext ? <Link className="button secondary" href={claimsHref(projectId, query, filter, ledger.page + 1)} rel="next" aria-label="Next page">Next</Link> : <button className="button secondary" type="button" disabled aria-label="Next page">Next</button>}
              </div>
            </nav>
          </section>
        </div>
        <p className="footer-note">Claim history is append-only. Citation candidates are derived from exact Evidence paths and deduplicated by Paper.</p>
      </div>
    </div>
  );
}
