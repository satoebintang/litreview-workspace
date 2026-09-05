import Link from "next/link";
import { notFound } from "next/navigation";
import { linkEvidenceAction, unlinkEvidenceAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export default async function ClaimProvenancePage({ params, searchParams }: { params: Promise<{ projectId: string; claimId: string }>; searchParams?: Promise<{ error?: string }> }) {
  const { projectId, claimId } = await params;
  const query = searchParams ? await searchParams : {};
  let provenance;
  try { provenance = await reviewServices.getClaimProvenance(projectId, claimId); } catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const allEvidence = await reviewServices.listEvidence(projectId);
  const linkedIds = new Set(provenance.evidence.map(({ evidence }) => evidence.id));
  const available = allEvidence.filter((item) => !linkedIds.has(item.id));
  return (
    <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
      <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
        <div className="workspace-header"><div><p className="eyebrow">Claim provenance</p><h1>Follow the source</h1><p>Inspect every passage supporting this claim, and return to the paper it came from.</p></div><span className={`status ${provenance.supportStatus}`}>{provenance.supportStatus === "supported" ? "● Supported" : "○ Unsupported"}</span></div>
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        <div className="workspace-grid">
          <section className="card section-card full"><div className="section-heading"><h2>Claim</h2><span className={`status ${provenance.supportStatus}`}>{provenance.supportStatus}</span></div><p style={{ fontFamily: "Newsreader, Georgia, serif", fontSize: 28, lineHeight: 1.25, marginBottom: 0 }}>{provenance.claim.claimText}</p></section>
          <section className="card section-card"><div className="section-heading"><h2>Supporting evidence</h2><span className="count">{provenance.evidence.length} linked</span></div>
            {provenance.evidence.length === 0 ? <div className="empty">This claim has no supporting evidence yet. Link a source passage to make it supported.</div> : <div className="provenance-chain">{provenance.evidence.map(({ evidence, paper }, index) => <div key={evidence.id}><article className="item"><p className="quote">“{evidence.sourceText}”</p><div className="item-meta">Page {evidence.pageNumber}</div>{evidence.note && <div className="item-meta">Researcher note: {evidence.note}</div>}<div className="item-row" style={{ marginTop: 13 }}><span className="paper-chip">{paper.title}</span><form action={unlinkEvidenceAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="claimId" value={claimId} /><input type="hidden" name="evidenceId" value={evidence.id} /><button className="button ghost danger" type="submit">Unlink</button></form></div></article>{index < provenance.evidence.length - 1 && <div className="chain-arrow" aria-hidden="true">↓</div>}</div>)}</div>}
          </section>
          <section className="card section-card"><div className="section-heading"><h2>Link a passage</h2></div>
            {available.length === 0 ? <div className="empty">{allEvidence.length === 0 ? "Record evidence in the workspace first." : "All available evidence is already linked to this claim."}</div> : <form action={linkEvidenceAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="claimId" value={claimId} /><div className="field"><label htmlFor="link-evidence">Evidence passage</label><select id="link-evidence" name="evidenceId" required defaultValue=""><option value="" disabled>Select evidence to link</option>{available.map((item) => <option key={item.id} value={item.id}>Page {item.pageNumber}: {item.sourceText.slice(0, 90)}{item.sourceText.length > 90 ? "…" : ""}</option>)}</select></div><button className="button" type="submit">Link evidence</button></form>}
            <div style={{ marginTop: 28 }}><Link className="button secondary" href={`/projects/${projectId}`}>Return to workspace</Link></div>
          </section>
        </div>
        <p className="footer-note">This chain is the audit trail: claim → exact passage → page → source paper.</p>
      </div>
    </main>
  );
}
