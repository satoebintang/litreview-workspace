import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { placeClaimRevisionAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) notFound();
  return value;
}

function pageSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) notFound();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) notFound();
  return parsed;
}

function invalidSelection(error: unknown): never {
  if (error instanceof DomainError && ["NOT_FOUND", "PROJECT_NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) notFound();
  throw error;
}

export default async function ClaimRevisionPlacementBrowsePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ sectionId?: string | string[]; pageSize?: string | string[]; cursor?: string | string[] }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  const sectionId = single(query.sectionId);
  if (!sectionId) notFound();
  const size = pageSize(single(query.pageSize));
  const cursor = single(query.cursor);
  let result;
  try {
    result = await withReviewReadTransaction(({ manuscriptClaimSelectionReadServices, executor }) =>
      manuscriptClaimSelectionReadServices.getPlacementClaimRevisionPage(projectId, sectionId, { pageSize: size, cursor }, executor));
  } catch (error) {
    invalidSelection(error);
  }

  const nextHref = result.page.nextCursor
    ? `/projects/${projectId}/manuscript/claim-revisions?sectionId=${encodeURIComponent(sectionId)}&pageSize=${result.page.pageSize}&cursor=${encodeURIComponent(result.page.nextCursor)}`
    : null;
  return <div className="project-page">
    <div className="container workspace">
      <Link className="back-link" href={`/projects/${projectId}/manuscript`}>← Back to manuscript</Link>
      <div className="workspace-header">
        <div>
          <p className="eyebrow">Place an exact ClaimRevision</p>
          <h1>{result.section.title}</h1>
          <p>Choose one finalized active revision for this Section. Historical active revisions remain available.</p>
        </div>
        <span className="status supported">{result.page.items.length} on this page</span>
      </div>
      {result.page.items.length === 0 ? <section className="card empty-state"><p>No placeable ClaimRevisions were found.</p></section> :
        <div className="item-list">{result.page.items.map((candidate) => <article className="card item" key={candidate.claimRevisionId} data-claim-revision-id={candidate.claimRevisionId}>
          <div className="item-row">
            <div style={{ minWidth: 0 }}>
              <div className="item-title">ClaimRevision {candidate.sequence}</div>
              <div className="item-meta">{candidate.isCurrent ? "Current revision" : "Historical revision"} · finalized {candidate.finalizedAt}</div>
              <p>{candidate.textPreview}{candidate.textTruncated ? "…" : ""}</p>
              <Link className="back-link" href={`/projects/${projectId}/claims/${candidate.claimId}/revisions/${candidate.claimRevisionId}`}>Open exact revision →</Link>
            </div>
            <form action={placeClaimRevisionAction}>
              <input type="hidden" name="projectId" value={projectId}/>
              <input type="hidden" name="manuscriptId" value={result.manuscript.id}/>
              <input type="hidden" name="sectionId" value={result.section.id}/>
              <input type="hidden" name="claimRevisionId" value={candidate.claimRevisionId}/>
              <button className="button secondary" type="submit">Place this revision</button>
            </form>
          </div>
        </article>)}</div>}
      {nextHref && <div style={{ marginTop: 14 }}><Link className="button ghost" href={nextHref}>Next ClaimRevision page →</Link></div>}
      <p className="item-meta" style={{ marginTop: 12 }}>Page size: {result.page.pageSize}</p>
    </div>
  </div>;
}
