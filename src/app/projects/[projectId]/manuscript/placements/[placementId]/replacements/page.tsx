import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { replacePlacedClaimRevisionAction } from "@/app/actions";
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

export default async function PlacementReplacementBrowsePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; placementId: string }>;
  searchParams?: Promise<{ pageSize?: string | string[]; cursor?: string | string[] }>;
}) {
  const { projectId, placementId } = await params;
  const query = searchParams ? await searchParams : {};
  const size = pageSize(single(query.pageSize));
  const cursor = single(query.cursor);
  let result;
  try {
    result = await withReviewReadTransaction(({ manuscriptClaimSelectionReadServices, executor }) =>
      manuscriptClaimSelectionReadServices.getPlacementReplacementClaimRevisionPage(projectId, placementId, { pageSize: size, cursor }, executor));
  } catch (error) {
    invalidSelection(error);
  }

  const nextHref = result.page.nextCursor
    ? `/projects/${projectId}/manuscript/placements/${placementId}/replacements?pageSize=${result.page.pageSize}&cursor=${encodeURIComponent(result.page.nextCursor)}`
    : null;
  return <div className="project-page">
    <div className="container workspace">
      <Link className="back-link" href={`/projects/${projectId}/manuscript`}>← Back to manuscript</Link>
      <div className="workspace-header">
        <div>
          <p className="eyebrow">Replace an exact ClaimRevision</p>
          <h1>ClaimRevision {result.placement.sequence} · {result.placement.sectionTitle}</h1>
          <p>Browse higher finalized active revisions of the same stable Claim.</p>
          <div className="item-meta">Parent Claim lifecycle: {result.placement.claimLifecycle}</div>
        </div>
        <span className="status supported">{result.page.items.length} on this page</span>
      </div>
      {result.placement.claimLifecycle !== "active" ? <section className="card empty-state"><p>The parent Claim is no longer active, so this placement has no eligible replacement candidates.</p></section> : result.page.items.length === 0 ? <section className="card empty-state"><p>No higher same-Claim ClaimRevisions are available.</p></section> :
        <div className="item-list">{result.page.items.map((candidate) => <article className="card item" key={candidate.claimRevisionId} data-claim-revision-id={candidate.claimRevisionId}>
          <div className="item-row">
            <div style={{ minWidth: 0 }}>
              <div className="item-title">ClaimRevision {candidate.sequence}</div>
              <div className="item-meta">{candidate.isCurrent ? "Current revision" : "Historical revision"} · finalized {candidate.finalizedAt}</div>
              <p>{candidate.textPreview}{candidate.textTruncated ? "…" : ""}</p>
              <Link className="back-link" href={`/projects/${projectId}/claims/${candidate.claimId}/revisions/${candidate.claimRevisionId}`}>Open exact revision →</Link>
            </div>
            <form action={replacePlacedClaimRevisionAction}>
              <input type="hidden" name="projectId" value={projectId}/>
              <input type="hidden" name="manuscriptId" value={result.manuscript.id}/>
              <input type="hidden" name="placementId" value={result.placement.id}/>
              <input type="hidden" name="claimRevisionId" value={candidate.claimRevisionId}/>
              <input type="hidden" name="expectedCurrentClaimRevisionId" value={result.placement.claimRevisionId}/>
              <button className="button secondary" type="submit">Replace with this revision</button>
            </form>
          </div>
        </article>)}</div>}
      {nextHref && <div style={{ marginTop: 14 }}><Link className="button ghost" href={nextHref}>Next replacement page →</Link></div>}
      <p className="item-meta" style={{ marginTop: 12 }}>Page size: {result.page.pageSize}</p>
    </div>
  </div>;
}
