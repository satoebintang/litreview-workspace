import Link from "next/link";
import { notFound } from "next/navigation";
import { humanizeWorkspaceToken } from "@/application/project-workspace-labels";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type SearchParams = {
  connectingCursor?: string;
  directCursor?: string;
  returnCandidateCursor?: string;
  returnCandidateFilter?: string;
};

function candidateHref(
  projectId: string,
  preparationId: string,
  extractionRevisionId: string,
  query: SearchParams,
  overrides: Partial<SearchParams>,
) {
  const params = new URLSearchParams();
  const state = { ...query, ...overrides };
  if (state.connectingCursor) params.set("connectingCursor", state.connectingCursor);
  if (state.directCursor) params.set("directCursor", state.directCursor);
  if (state.returnCandidateCursor && state.returnCandidateCursor.length <= 4096) params.set("returnCandidateCursor", state.returnCandidateCursor);
  if (state.returnCandidateFilter === "all" || state.returnCandidateFilter === "selected" || state.returnCandidateFilter === "selectable" || state.returnCandidateFilter === "ineligible") {
    params.set("returnCandidateFilter", state.returnCandidateFilter);
  }
  const search = params.toString();
  return `/projects/${projectId}/synthesis/preparations/${preparationId}/candidates/${extractionRevisionId}${search ? `?${search}` : ""}`;
}

export default async function SynthesisPreparationCandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; preparationId: string; extractionRevisionId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { projectId, preparationId, extractionRevisionId } = await params;
  const query = searchParams ? await searchParams : {};

  let candidateResult;
  try {
    candidateResult = await reviewServices.getSynthesisPreparationCandidate(projectId, preparationId, extractionRevisionId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }

  let connectingPage;
  let connectingNotice: string | undefined;
  try {
    connectingPage = await reviewServices.listSynthesisPreparationConnectingEvidence(
      projectId,
      preparationId,
      extractionRevisionId,
      { cursor: query.connectingCursor, pageSize: 25 },
    );
  } catch (error) {
    if (query.connectingCursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      connectingNotice = error.message;
      connectingPage = await reviewServices.listSynthesisPreparationConnectingEvidence(projectId, preparationId, extractionRevisionId, { pageSize: 25 });
    } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) notFound();
    else throw error;
  }

  let directPage;
  let directNotice: string | undefined;
  try {
    directPage = await reviewServices.listSynthesisPreparationDirectEvidence(
      projectId,
      preparationId,
      extractionRevisionId,
      { cursor: query.directCursor, pageSize: 25 },
    );
  } catch (error) {
    if (query.directCursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      directNotice = error.message;
      directPage = await reviewServices.listSynthesisPreparationDirectEvidence(projectId, preparationId, extractionRevisionId, { pageSize: 25 });
    } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) notFound();
    else throw error;
  }

  if (!connectingPage || !directPage) notFound();
  const header = candidateResult.header;
  const candidate = candidateResult.candidate;
  const base = `/projects/${projectId}/synthesis/preparations/${preparationId}`;
  const returnParams = new URLSearchParams();
  if (query.returnCandidateCursor && query.returnCandidateCursor.length <= 4096) returnParams.set("candidateCursor", query.returnCandidateCursor);
  if (query.returnCandidateFilter === "all" || query.returnCandidateFilter === "selected" || query.returnCandidateFilter === "selectable" || query.returnCandidateFilter === "ineligible") {
    returnParams.set("candidateFilter", query.returnCandidateFilter);
  }
  const returnQuery = returnParams.toString();
  const returnHref = `${base}${returnQuery ? `?${returnQuery}` : ""}`;

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow"><Link href={returnHref}>{header.preparation.workingTitle ?? "Preparation workspace"}</Link> / Exact candidate provenance</p>
            <h1>{candidate.paper.title}</h1>
            <p>Extraction revision {candidate.sequence} · exact revision ID {candidate.extractionRevisionId}</p>
          </div>
          <Link className="button ghost" href={returnHref}>Return to preparation →</Link>
        </div>

        <section className="card section-card">
          <div className="section-heading"><h2>Candidate identity</h2><span className={`status ${candidate.selected ? "supported" : candidate.selectable ? "unsupported" : "stale"}`}>{candidate.selected ? "Selected" : candidate.selectable ? "Selectable" : "Ineligible"}</span></div>
          <div className="item-list">
            <div className="item-meta">Project: {projectId}</div>
            <div className="item-meta">Preparation: {preparationId} · pinned composition revision {header.pinnedComposition.id} · set ordinal {header.pinnedComposition.setOrdinal}</div>
            <div className="item-meta">Extraction Field: {header.field.name} ({candidate.fieldType})</div>
            <div className="item-meta">Paper: <Link href={`/projects/${projectId}/extraction/${candidate.paper.id}`}>{candidate.paper.title}</Link> · Paper ID {candidate.paper.id}</div>
            <div className="item-meta">Extraction value ID: {candidate.extractionValueId} · revision {candidate.sequence} · finalized {candidate.finalizedAt.toLocaleString()}</div>
            <div className="item-meta">Value state: {candidate.valueState.replaceAll("_", " ")} · value: {candidate.value ?? "—"}{candidate.optionId ? ` · option ${candidate.optionId}${candidate.optionLabel ? ` (${candidate.optionLabel})` : ""}` : ""}</div>
            <div className="item-meta">Minimum pinned membership position: {candidate.membershipOrder} · current revision: {candidate.isCurrentExtractionRevision ? "yes" : "no"} · Paper finally included: {candidate.isFinallyIncluded ? "yes" : "no"}</div>
            <div className="item-meta">Connecting Evidence: {candidate.connectingEvidenceCount} · direct Evidence: {candidate.directEvidenceCount}</div>
          </div>
          {candidate.eligibilityReasons.length > 0 && <p className="hint" style={{ marginTop: 10 }}>Current eligibility: {candidate.eligibilityReasons.map(humanizeWorkspaceToken).join(" · ")}</p>}
          {candidate.warnings.length > 0 && <div className="item-row" style={{ marginTop: 10, flexWrap: "wrap" }}>{candidate.warnings.map((warning) => <span className="status stale" key={warning}>{humanizeWorkspaceToken(warning)}</span>)}</div>}
        </section>

        <section className="card section-card" style={{ marginTop: 16 }}>
          <div className="section-heading">
            <div>
              <h2>Connecting Evidence in the pinned composition</h2>
              <p className="hint">Only Evidence in this preparation’s exact pinned composition that connects to this revision appears here.</p>
            </div>
            <span className="count">{connectingPage.items.length} shown{connectingPage.hasMore ? " · more available" : ""}</span>
          </div>
          {connectingNotice && <div className="error-banner" role="alert">{connectingNotice} This Evidence list has returned to its first page.</div>}
          {connectingPage.items.length === 0 ? <div className="empty">No connecting Evidence on this page.</div> : (
            <div className="item-list">
              {connectingPage.items.map((evidence) => (
                <article className="item" key={evidence.id}>
                  <div className="item-row">
                    <div>
                      <Link className="item-title" href={`/projects/${projectId}/evidence/${evidence.id}`}>Evidence {evidence.id}</Link>
                      <div className="item-meta">Pinned membership {evidence.membershipId} · position {evidence.membershipOrder} · page {evidence.pageNumber} · {evidence.reviewState.replaceAll("_", " ")}</div>
                    </div>
                    {evidence.curationWarning && <span className="status stale">{evidence.curationWarning.replaceAll("_", " ")}</span>}
                  </div>
                  <div className="quote">“{evidence.sourcePreview}{evidence.sourceTruncated ? "…" : ""}”</div>
                  {evidence.note && <div className="item-meta">Evidence note: {evidence.note}{evidence.noteTruncated ? "…" : ""}</div>}
                  {evidence.document && <div className="item-meta">Document: {evidence.document.originalFilename}{evidence.document.originalFilenameTruncated ? "…" : ""}</div>}
                </article>
              ))}
            </div>
          )}
          <div className="item-row" style={{ marginTop: 14 }}>
            {query.connectingCursor && <Link className="button ghost" href={candidateHref(projectId, preparationId, extractionRevisionId, query, { connectingCursor: undefined })}>First connecting Evidence page</Link>}
            {connectingPage.nextCursor && <Link className="button secondary" href={candidateHref(projectId, preparationId, extractionRevisionId, query, { connectingCursor: connectingPage.nextCursor })}>Next connecting Evidence page</Link>}
          </div>
        </section>

        <section className="card section-card" style={{ marginTop: 16 }}>
          <div className="section-heading">
            <div>
              <h2>All Evidence directly linked to this revision</h2>
              <p className="hint">This separate list includes every direct revision link, including Evidence outside the pinned Set.</p>
            </div>
            <span className="count">{directPage.items.length} shown{directPage.hasMore ? " · more available" : ""}</span>
          </div>
          {directNotice && <div className="error-banner" role="alert">{directNotice} This Evidence list has returned to its first page.</div>}
          {directPage.items.length === 0 ? <div className="empty">No directly linked Evidence on this page.</div> : (
            <div className="item-list">
              {directPage.items.map((evidence) => (
                <article className="item" key={evidence.id}>
                  <div className="item-row">
                    <div>
                      <Link className="item-title" href={`/projects/${projectId}/evidence/${evidence.id}`}>Evidence {evidence.id}</Link>
                      <div className="item-meta">Page {evidence.pageNumber} · {evidence.reviewState.replaceAll("_", " ")}</div>
                    </div>
                    {evidence.curationWarning && <span className="status stale">{evidence.curationWarning.replaceAll("_", " ")}</span>}
                  </div>
                  <div className="quote">“{evidence.sourcePreview}{evidence.sourceTruncated ? "…" : ""}”</div>
                  {evidence.note && <div className="item-meta">Evidence note: {evidence.note}{evidence.noteTruncated ? "…" : ""}</div>}
                  {evidence.document && <div className="item-meta">Document: {evidence.document.originalFilename}{evidence.document.originalFilenameTruncated ? "…" : ""}</div>}
                </article>
              ))}
            </div>
          )}
          <div className="item-row" style={{ marginTop: 14 }}>
            {query.directCursor && <Link className="button ghost" href={candidateHref(projectId, preparationId, extractionRevisionId, query, { directCursor: undefined })}>First direct Evidence page</Link>}
            {directPage.nextCursor && <Link className="button secondary" href={candidateHref(projectId, preparationId, extractionRevisionId, query, { directCursor: directPage.nextCursor })}>Next direct Evidence page</Link>}
          </div>
        </section>
      </div>
    </div>
  );
}
