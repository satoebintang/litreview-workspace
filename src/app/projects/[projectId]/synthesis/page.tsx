import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices, synthesisReadServices } from "@/app/server";
import { SynthesisComparisonPicker } from "./SynthesisComparisonPicker";
import { DomainError } from "@/domain/errors";

function ledgerHref(projectId: string, fieldId: string | undefined, page: number) {
  const query = new URLSearchParams({ synthesisPage: String(page) });
  if (fieldId) query.set("fieldId", fieldId);
  return `/projects/${projectId}/synthesis?${query.toString()}`;
}

export default async function SynthesisDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ fieldId?: string; synthesisPage?: string; error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const fields = await reviewServices.listExtractionFields(projectId);
  const field = fields.find((item) => item.id === query.fieldId) ?? fields[0];
  const [comparison, ledger] = await Promise.all([
    field ? synthesisReadServices.getSynthesisComparisonPage(projectId, field.id, { page: 1, pageSize: 50 }) : Promise.resolve(null),
    synthesisReadServices.getSynthesisLedgerPage(projectId, { page: query.synthesisPage, pageSize: 50 }),
  ]);
  const savedMessage = query.saved === "created" ? "Synthesis statement created." : undefined;

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Evidence synthesis</p><h1>{project.title}</h1><p>Compare structured observations and author source-backed conclusions.</p></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="status supported">● Researcher-entered</span><Link className="button ghost" href={`/projects/${projectId}/synthesis/preparations`}>Preparation workspaces →</Link></div></div>

      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card full"><div className="section-heading"><h2>Evidence matrix</h2><span className="count">{comparison?.summary.totalIncludedPapers ?? 0} included papers</span></div>
          <p className="hint">This is a view over current finalized ExtractionRevisions. Select exact observations to use as supporting findings; missing and ungrounded states remain visible.</p>
          {fields.length === 0 ? <div className="empty">Add an extraction field before comparing observations.</div> : <>
            <nav className="chip-list" aria-label="Extraction fields">{fields.map((item) => <Link className={`button ${item.id === field?.id ? "secondary" : "ghost"}`} key={item.id} href={`/projects/${projectId}/synthesis?fieldId=${item.id}`}>{item.name}</Link>)}</nav>
            {field && comparison && <SynthesisComparisonPicker key={field.id} projectId={projectId} initialPage={comparison} />}
          </>}
        </section>
        <section className="card section-card full"><div className="section-heading"><h2>Synthesis statements</h2><span className="count">{ledger.pagination.totalCount}</span></div>
          {ledger.items.length === 0 ? <div className="empty">No synthesis statements yet. Select observations above to author one.</div> : <div className="item-list">{ledger.items.map((synthesis) => <article className="item item-row" key={synthesis.synthesisStatementId}><div><div className="item-title">{synthesis.title ?? "Untitled synthesis"}</div><div className="item-meta">{synthesis.state === "withdrawn" ? "Withdrawn" : synthesis.statementText} · Revision {synthesis.sequence}</div><div className="item-meta">{synthesis.supportingRevisionCount} supporting observations across {synthesis.supportingPaperCount} {synthesis.supportingPaperCount === 1 ? "Paper" : "Papers"}</div></div><Link className="button ghost" href={`/projects/${projectId}/synthesis/${synthesis.synthesisStatementId}`}>Inspect provenance →</Link></article>)}</div>}
          {ledger.pagination.totalPages > 1 && <>
            <nav className="pagination" aria-label="Synthesis statement pages">
              <Link className={`button ghost ${ledger.pagination.page <= 1 ? "disabled" : ""}`} aria-disabled={ledger.pagination.page <= 1} tabIndex={ledger.pagination.page <= 1 ? -1 : undefined} href={ledgerHref(projectId, field?.id, Math.max(1, ledger.pagination.page - 1))}>Previous</Link>
              <span>{ledger.pagination.from}–{ledger.pagination.to} of {ledger.pagination.totalCount} · Page {ledger.pagination.page} of {ledger.pagination.totalPages}</span>
              <Link className={`button ghost ${ledger.pagination.page >= ledger.pagination.totalPages ? "disabled" : ""}`} aria-disabled={ledger.pagination.page >= ledger.pagination.totalPages} tabIndex={ledger.pagination.page >= ledger.pagination.totalPages ? -1 : undefined} href={ledgerHref(projectId, field?.id, Math.min(ledger.pagination.totalPages, ledger.pagination.page + 1))}>Next</Link>
            </nav>
            <p className="visually-hidden" role="status" aria-live="polite">{ledger.pagination.from} to {ledger.pagination.to} of {ledger.pagination.totalCount} Synthesis statements. Page {ledger.pagination.page} of {ledger.pagination.totalPages}.</p>
          </>}
        </section>
      </div>
      <p className="footer-note">Synthesis is researcher-authored. Supporting observations are descriptive coverage, not proof or statistical certainty.</p>
    </div></div>;
}
