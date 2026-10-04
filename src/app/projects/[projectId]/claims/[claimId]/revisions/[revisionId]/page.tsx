import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

function displayExtractionValue(revision: {
  valueState: string;
  textValue: string | null;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
}) {
  if (revision.valueState !== "present") return revision.valueState.replaceAll("_", " ");
  return revision.textValue ?? revision.numberValue ?? revision.optionId ?? (revision.booleanValue === null ? "No value" : revision.booleanValue ? "Yes" : "No");
}

export default async function ExactClaimRevisionPage({
  params,
}: {
  params: Promise<{ projectId: string; claimId: string; revisionId: string }>;
}) {
  const { projectId, claimId, revisionId } = await params;
  let exact;
  try {
    exact = await withReviewReadTransaction(({ claimRevisionExactAuditReadServices }) =>
      claimRevisionExactAuditReadServices.getClaimRevisionForExactAudit(projectId, claimId, revisionId),
    );
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const revision = exact.revision;

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Exact Claim revision · Revision {revision.sequence}</p>
            <h1>{revision.claimText ?? "Claim withdrawn"}</h1>
            <p>
              Finalized {new Date(revision.finalizedAt!).toLocaleString()} · {exact.isCurrentRevision ? "Current revision" : "Historical revision"} · {revision.totalSupportCount} exact supports
            </p>
          </div>
          <span className={`status ${revision.lifecycle === "withdrawn" ? "withdrawn" : revision.supportStatus}`}>
            {revision.lifecycle === "withdrawn" ? "Withdrawn" : revision.supportStatus === "supported" ? "Supported" : "Unsupported"}
          </span>
        </div>
        <p><Link href={`/projects/${projectId}/claims/${claimId}`}>Return to Claim history →</Link></p>
        {revision.researcherNote && <section className="card section-card full"><h2>Researcher note</h2><p style={{ whiteSpace: "pre-wrap" }}>{revision.researcherNote}</p></section>}

        <div className="workspace-grid">
          <section className="card section-card full">
            <div className="section-heading"><h2>Direct Evidence supports</h2><span className="count">{revision.supports.evidence.length}</span></div>
            {revision.supports.evidence.length === 0 ? <p className="empty">No direct Evidence supports were recorded.</p> : <div className="item-list">{revision.supports.evidence.map((support) => <article className="item" key={support.evidenceId}>
              <div className="item-title">{support.evidence.paper.title}</div>
              <p className="quote">“{support.evidence.evidence.sourceText}”</p>
              <div className="item-meta">Page {support.evidence.evidence.pageNumber} · Evidence {support.evidenceId}{support.evidence.evidence.curationWarning ? ` · ${support.evidence.evidence.curationWarning.replaceAll("_", " ")}` : ""}</div>
            </article>)}</div>}
          </section>

          <section className="card section-card full">
            <div className="section-heading"><h2>Exact ExtractionRevision supports</h2><span className="count">{revision.supports.extractionRevisions.length}</span></div>
            {revision.supports.extractionRevisions.length === 0 ? <p className="empty">No ExtractionRevision supports were recorded.</p> : <div className="item-list">{revision.supports.extractionRevisions.map((support) => <article className="item" key={support.extractionRevisionId}>
              <div className="item-row"><div><div className="item-title">{support.field.name} · {support.paper.title}</div><div className="item-meta">Extraction revision {support.extractionRevision.sequence} · {support.extractionRevision.valueState.replaceAll("_", " ")} · {support.isCurrentExtractionRevision ? "Current extraction" : "Superseded extraction"} · Paper screening: {support.paperScreeningState}</div></div><span className="status">{support.extractionRevision.evidence.length} Evidence paths</span></div>
              <p>{support.extractionRevision.textValue ?? support.extractionRevision.numberValue ?? support.extractionRevision.optionId ?? (support.extractionRevision.booleanValue === null ? "No value" : support.extractionRevision.booleanValue ? "Yes" : "No")}</p>
              {support.extractionRevision.evidence.map((evidence) => <p className="quote" key={evidence.id}>“{evidence.sourceText}” · Page {evidence.pageNumber}</p>)}
            </article>)}</div>}
          </section>

          <section className="card section-card full">
            <div className="section-heading"><h2>Exact SynthesisRevision supports</h2><span className="count">{revision.supports.synthesisRevisions.length}</span></div>
            {revision.supports.synthesisRevisions.length === 0 ? <p className="empty">No SynthesisRevision supports were recorded.</p> : <div className="item-list">{revision.supports.synthesisRevisions.map((support) => <article className="item" key={support.synthesisRevisionId}>
              {support.synthesisRevision.title && <div className="item-title">{support.synthesisRevision.title}</div>}
              <p className="synthesis-statement">{support.synthesisRevision.statementText ?? "Synthesis withdrawn"}</p>
              <div className="item-meta">Synthesis revision {support.synthesisRevision.sequence} · {support.isCurrentSynthesisRevision ? "Current statement revision" : "Historical statement revision"} · Statement lifecycle: {support.statementLifecycle}</div>
              {support.synthesisRevision.researcherNote && <p className="hint">Researcher note: {support.synthesisRevision.researcherNote}</p>}
              {support.synthesisRevision.supports.map((observation) => <div className="nested-support" key={observation.extractionRevisionId}><div className="item-title">{observation.field.name} · {observation.paper.title}</div><div className="item-meta">Extraction revision {observation.extractionRevision.sequence} · {observation.extractionRevision.valueState.replaceAll("_", " ")} · {displayExtractionValue(observation.extractionRevision)} · {observation.isCurrentExtractionRevision ? "Current extraction" : "Superseded extraction"}</div>{observation.extractionRevision.evidence.map((evidence) => <p className="quote" key={evidence.id}>“{evidence.sourceText}” · Page {evidence.pageNumber}</p>)}</div>)}
            </article>)}</div>}
          </section>

          <section className="card section-card full">
            <div className="section-heading"><h2>Citation candidates</h2><span className="count">{revision.citationCandidates.length}</span></div>
            {revision.citationCandidates.length === 0 ? <p className="empty">No canonical Evidence-reaching citation paths exist for this revision.</p> : <div className="item-list">{revision.citationCandidates.map((candidate) => <article className="item" key={candidate.paper.id}>
              <div className="item-title">{candidate.paper.title}</div>
              <div className="item-meta">{candidate.pathCount} provenance paths · Support kinds: {candidate.supportKinds.join(", ")}</div>
              {candidate.paths && <ul>{candidate.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
            </article>)}</div>}
          </section>
        </div>
        <p className="footer-note">This audit page preserves the exact finalized Claim snapshot, typed supports, and citation paths recorded for this revision.</p>
      </div>
    </div>
  );
}
