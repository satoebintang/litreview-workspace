import Link from "next/link";
import { notFound } from "next/navigation";
import { createClaimRevisionAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";
import { normalizeClaims, type ClaimReadServices } from "./model";

const services = reviewServices as unknown as ClaimReadServices;

async function loadClaims(projectId: string) {
  if (services.listCurrentClaims) return normalizeClaims(await services.listCurrentClaims(projectId));
  return normalizeClaims(await services.listClaims?.(projectId));
}

export default async function ClaimsWorkspacePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ error?: string; saved?: string; filter?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try {
    project = await reviewServices.getProject(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const claims = await loadClaims(projectId);
  const filter = query.filter === "supported" || query.filter === "unsupported" || query.filter === "withdrawn" ? query.filter : "all";
  const visible = claims.filter((claim) => filter === "all" || claim.currentRevision.state === filter || (filter === "supported" && claim.currentRevision.supportStatus === "supported") || (filter === "unsupported" && claim.currentRevision.state === "active" && claim.currentRevision.supportStatus === "unsupported"));
  const supported = claims.filter((claim) => claim.currentRevision.state === "active" && claim.currentRevision.supportStatus === "supported").length;
  const unsupported = claims.filter((claim) => claim.currentRevision.state === "active" && claim.currentRevision.supportStatus === "unsupported").length;
  const withdrawn = claims.filter((claim) => claim.currentRevision.state === "withdrawn").length;
  return (
    <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
      <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← {project.title}</Link>
        <div className="workspace-header"><div><p className="eyebrow">Manuscript claims</p><h1>Claims workspace</h1><p>Write researcher-authored assertions and keep every support choice tied to exact research history.</p></div><span className="status supported">● {claims.length} {claims.length === 1 ? "claim" : "claims"}</span></div>
        <nav className="stagebar" aria-label="Review stages"><Link className="stage active" href={`/projects/${projectId}`}>1. Question</Link><Link className="stage active" href={`/projects/${projectId}/screening`}>2. Papers</Link><Link className="stage active" href={`/projects/${projectId}`}>3. Evidence</Link><Link className="stage active" href={`/projects/${projectId}/claims`}>4. Claims</Link><Link className="stage active" href={`/projects/${projectId}/extraction`}>5. Extraction</Link><Link className="stage active" href={`/projects/${projectId}/synthesis`}>6. Synthesis</Link><span className="stage">7. Writing</span></nav>
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {query.saved && <div className="success-note" role="status">{query.saved === "created" ? "Claim created as unsupported." : query.saved === "revised" ? "New Claim revision saved." : query.saved === "withdrawn" ? "Claim withdrawn. Its history remains available." : query.saved === "reactivated" ? "Claim reactivated with an explicit support snapshot." : "Claim updated."}</div>}
        <div className="screening-stats claim-stats" aria-label="Claim summary"><Link className={`screening-stat ${filter === "all" ? "active" : ""}`} href={`/projects/${projectId}/claims`}><span>All claims</span><strong>{claims.length}</strong></Link><Link className={`screening-stat ${filter === "supported" ? "active" : ""}`} href={`/projects/${projectId}/claims?filter=supported`}><span>Supported</span><strong>{supported}</strong></Link><Link className={`screening-stat ${filter === "unsupported" ? "active" : ""}`} href={`/projects/${projectId}/claims?filter=unsupported`}><span>Unsupported</span><strong>{unsupported}</strong></Link><Link className={`screening-stat ${filter === "withdrawn" ? "active" : ""}`} href={`/projects/${projectId}/claims?filter=withdrawn`}><span>Withdrawn</span><strong>{withdrawn}</strong></Link></div>
        <div className="workspace-grid">
          <section className="card section-card"><div className="section-heading"><h2>New claim</h2><span className="count">Starts unsupported</span></div><p className="hint" style={{ marginBottom: 18 }}>Capture the assertion first. Add exact Evidence, extracted observations, or syntheses from the Claim detail page.</p><form action={createClaimRevisionAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="claim-text">Claim text</label><textarea id="claim-text" name="claimText" required placeholder="State a researcher-authored manuscript assertion" /></div><div className="field"><label htmlFor="claim-note">Researcher note <span className="hint">optional</span></label><textarea id="claim-note" name="researcherNote" placeholder="Context for this assertion" /></div><button className="button" type="submit">Create unsupported claim</button></form></section>
          <section className="card section-card"><div className="section-heading"><h2>Support model</h2><span className="count">Exact by revision</span></div><div className="feature-list"><div className="feature"><span className="feature-number">01</span><p><strong>Supporting Evidence</strong><br />Direct source passages remain exact, including passages from excluded Papers.</p></div><div className="feature"><span className="feature-number">02</span><p><strong>Supporting observations</strong><br />Select a finalized ExtractionRevision deliberately; newer values never retarget history.</p></div><div className="feature"><span className="feature-number">03</span><p><strong>Supporting syntheses</strong><br />Cross-paper conclusions retain their exact revision and underlying evidence paths.</p></div></div></section>
          <section className="card section-card full"><div className="section-heading"><h2>Claim ledger</h2><span className="count">{visible.length} shown · {claims.reduce((sum, claim) => sum + claim.currentRevision.citationCandidateCount, 0)} citation candidates</span></div>
            {visible.length === 0 ? <div className="empty">{claims.length === 0 ? "Claims start here. Create an unsupported assertion above." : "No claims match this filter."}</div> : <div className="item-list">{visible.map((claim) => { const current = claim.currentRevision; const supportCount = current.supports.evidence.length + current.supports.extraction.length + current.supports.synthesis.length; return <article className="item" key={claim.id}><div className="item-row"><div style={{ minWidth: 0 }}><div className="item-title claim-list-title">{current.claimText ?? "Claim withdrawn"}</div><div className="item-meta">Revision {current.sequence} · {supportCount} supporting {supportCount === 1 ? "object" : "objects"} · {current.citationCandidateCount} citation {current.citationCandidateCount === 1 ? "candidate" : "candidates"}</div></div><div className="claim-list-actions"><span className={`status ${current.state === "withdrawn" ? "withdrawn" : current.supportStatus}`}>{current.state === "withdrawn" ? "Withdrawn" : current.supportStatus === "supported" ? "● Supported" : "○ Unsupported"}</span><Link className="button ghost" href={`/projects/${projectId}/claims/${claim.id}`}>Inspect claim →</Link></div></div></article>; })}</div>}
          </section>
        </div>
        <p className="footer-note">Claim history is append-only. Citation candidates are derived from exact Evidence paths and deduplicated by Paper.</p>
      </div>
    </main>
  );
}
