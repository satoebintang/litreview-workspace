import Link from "next/link";
import { notFound } from "next/navigation";
import { bulkCreateBibliographicImportRecordsAction, resolveBibliographicImportRecordAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

type Candidate = { id: string; title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null; abstract: string | null; candidateReason: string };
type ProjectPaper = { id: string; title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null };
type ImportRecord = { id: string; ordinal: number; title: string | null; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null; url: string | null; abstract: string | null; startByte: number; endByte: number; outcome: string; diagnostics: string[] };
type Resolution = { id: string; importId: string; recordId: string; sequence: string; paperId: string | null; eventType: string; note: string | null; createdAt: unknown };
type BulkPreviewRecord = { recordId: string; ordinal: number; title: string | null; expectedResolutionId: string | null; fingerprint: string; eligible: boolean; reason: string | null; candidateIds: string[]; peerRecordIds: string[] };
type BulkPreview = { maxRecords: number; records: BulkPreviewRecord[]; selected: BulkPreviewRecord[]; selectedCount: number; overLimit: boolean; canConfirm: boolean; selection: Array<{ recordId: string; expectedResolutionId: string | null; fingerprint: string }> };
type ImportDetail = { id: string; format: string; filename: string; parserVersion: string; sourceByteSize: number; status: string; errorCode: string | null; errorMessage: string | null; diagnostics: string[]; records: ImportRecord[]; resolutions: Resolution[]; currentResolutions: Map<string, Resolution> };

function queryValues(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function actionLabel(eventType: string): string {
  return eventType.replaceAll("_", " ");
}

export default async function BibliographicImportDetailPage({ params, searchParams }: { params: Promise<{ projectId: string; importId: string }>; searchParams?: Promise<{ error?: string; saved?: string; offset?: string; bulkRecordId?: string | string[] }> }) {
  const { projectId, importId } = await params;
  const query = searchParams ? await searchParams : {};
  const selectedBulkIds = queryValues(query.bulkRecordId);
  const services = reviewServices as typeof reviewServices & {
    getImport?: (projectId: string, importId: string) => Promise<ImportDetail | null>;
    listRecordCandidates?: (projectId: string, recordId: string) => Promise<Candidate[]>;
    listPapers?: (projectId: string) => Promise<ProjectPaper[]>;
    getBulkImportPreview?: (projectId: string, importId: string, selectedRecordIds?: string[]) => Promise<BulkPreview>;
  };
  let imported: ImportDetail | null;
  try { imported = services.getImport ? await services.getImport(projectId, importId) : null; }
  catch (error) {
    if (error instanceof DomainError && ["NOT_FOUND", "PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (!imported) notFound();

  const [projectPapers, bulkPreviewResult] = await Promise.all([
    services.listPapers ? services.listPapers(projectId) : Promise.resolve([]),
    services.getBulkImportPreview ? services.getBulkImportPreview(projectId, importId, selectedBulkIds) : Promise.resolve(null),
  ]);
  const bulkPreview = bulkPreviewResult;
  const bulkPreviewError = !bulkPreview && selectedBulkIds.length > 0 ? "Bulk preview is not configured." : null;

  const records = imported.records;
  const pageSize = 50;
  const parsedOffset = Number.parseInt(query.offset ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.min(Math.floor(parsedOffset / pageSize) * pageSize, Math.max(0, Math.floor((records.length - 1) / pageSize) * pageSize))) : 0;
  const pageRecords = records.slice(offset, offset + pageSize);
  const candidatesByRecord = new Map<string, Candidate[]>();
  await Promise.all(pageRecords.map(async (record) => {
    if (services.listRecordCandidates) candidatesByRecord.set(record.id, await services.listRecordCandidates(projectId, record.id));
  }));

  const eligibleBulkRecords = bulkPreview?.records.filter((record) => record.eligible) ?? [];
  const selectedBulkRecords = bulkPreview?.selected ?? [];
  const savedMessage = query.saved === "resolution" ? "Resolution recorded."
    : query.saved === "bulk-created" ? "Bulk Paper creation committed."
      : undefined;

  return <div className="project-page"><div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">{imported.format.toUpperCase()} import</p><h1>{imported.filename}</h1><p className="hint">{records.length} records · parser {imported.parserVersion} · {imported.sourceByteSize} bytes · {imported.status}</p></div><Link className="button ghost" href={`/projects/${projectId}`}>Paper collection</Link></div>
    {query.error && <div className="error-banner" role="alert">{query.error}</div>}
    {savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
    {(imported.errorMessage || imported.diagnostics.length > 0) && <section className="card section-card"><h2>Import diagnostics</h2>{imported.errorMessage && <div className="error-banner" role="alert">{imported.errorCode ? `${imported.errorCode}: ` : ""}{imported.errorMessage}</div>}{imported.diagnostics.length > 0 && <ul className="item-meta">{imported.diagnostics.map((diagnostic, index) => <li key={`${diagnostic}-${index}`}>{diagnostic}</li>)}</ul>}</section>}

    <section className="card section-card"><h2>Bulk create eligible Papers</h2><p className="hint">Select parse-successful unresolved records with no current Paper candidate or imported peer duplicate. Up to {bulkPreview?.maxRecords ?? 100} records can be created in one atomic action.</p>{bulkPreviewError && <div className="error-banner" role="alert">{bulkPreviewError}</div>}{eligibleBulkRecords.length === 0 ? <div className="empty">No records are currently eligible for bulk creation.</div> : <form method="get"><div className="item-list">{eligibleBulkRecords.map((record) => <label className="item item-row" key={record.recordId}><span><input type="checkbox" name="bulkRecordId" value={record.recordId} defaultChecked={selectedBulkIds.includes(record.recordId)} /> <strong>{record.title ?? "Untitled record"}</strong><span className="item-meta"> · record {record.ordinal}</span></span><span className="status">eligible</span></label>)}</div><button className="button secondary" type="submit">Preview bulk creation</button></form>}{selectedBulkRecords.length > 0 && <div className="nested-support" style={{ marginTop: 16 }}><h3>Bulk preview · {selectedBulkRecords.length} selected</h3>{bulkPreview?.overLimit && <div className="error-banner" role="alert">Select no more than {bulkPreview.maxRecords} records.</div>}<ul className="item-meta">{selectedBulkRecords.map((record) => <li key={record.recordId}><strong>{record.title ?? "Untitled record"}</strong> · record {record.ordinal}{record.reason ? ` · blocked: ${record.reason}` : " · ready"}</li>)}</ul>{bulkPreview?.canConfirm && <form action={bulkCreateBibliographicImportRecordsAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="importId" value={importId} /><input type="hidden" name="selection" value={JSON.stringify(bulkPreview.selection)} /><button className="button" type="submit">Confirm bulk creation</button></form>}</div>}</section>

    <section className="card section-card"><h2>Parsed records</h2><p className="hint">Review likely matches before choosing a canonical identity. Matching never overwrites canonical Paper metadata.</p><div className="item-list">{pageRecords.map((record) => {
      const resolution = imported.currentResolutions.get(record.id);
      const candidates = candidatesByRecord.get(record.id) ?? [];
      const history = imported.resolutions.filter((item) => item.recordId === record.id).sort((left, right) => Number(left.sequence) - Number(right.sequence));
      const alternatePapers = projectPapers.filter((paper) => paper.id !== resolution?.paperId);
      const retargetOptions = resolution?.eventType === "cleared" ? projectPapers : candidates;
      return <div className="item" key={record.id}><div className="item-row"><div><div className="item-title">{record.title ?? "Untitled record"}</div><div className="item-meta">{record.authors?.join(", ") || "Authors absent"}{record.publicationYear ? ` · ${record.publicationYear}` : ""}{record.venue ? ` · ${record.venue}` : ""}</div>{record.url && <div className="item-meta">URL: {record.url}</div>}<div className="item-meta">Record {record.ordinal} · bytes [{record.startByte}, {record.endByte}) · {record.outcome}</div>{record.diagnostics?.length > 0 && <div className="support-warning">{record.diagnostics.join("; ")}</div>}{candidates.length > 0 && <div className="support-warning">{candidates.length} likely canonical match{candidates.length === 1 ? "" : "es"} found.</div>}{candidates.length > 0 && <div className="nested-support"><div className="item-meta">Imported vs candidate Paper</div>{candidates.map((candidate) => <div className="item-meta" key={candidate.id}><strong>{candidate.title}</strong> · {candidate.candidateReason}<br />Authors: {candidate.authors?.join(", ") || "absent"}<br />Year: {candidate.publicationYear ?? "absent"} · Venue: {candidate.venue ?? "absent"}<br />DOI: {candidate.doi ?? "absent"}<br />Imported: {record.title ?? "absent"} · {record.publicationYear ?? "absent"} · {record.venue ?? "absent"} · {record.doi ?? "absent"}</div>)}</div>}</div><span className="status">{resolution?.paperId ? "resolved" : "unresolved"}</span></div>
        {history.length > 0 && <details className="revision-history" open={history.length > 1}><summary>Resolution history ({history.length})</summary><ol className="item-meta">{history.map((event) => <li key={event.id}>{actionLabel(event.eventType)}{event.paperId ? ` → Paper ${event.paperId}` : ""} · sequence {event.sequence} · {timestamp(event.createdAt)}{event.note ? ` · ${event.note}` : ""}</li>)}</ol></details>}
        {resolution?.paperId ? <><div className="item-meta">Current Paper: {resolution.paperId} · {actionLabel(resolution.eventType)}</div>{record.outcome !== "failed" && <div className="nested-support" style={{ marginTop: 12 }}><div className="item-meta">Correct intake identity</div>{alternatePapers.length === 0 ? <div className="empty">No alternate same-project Papers are available.</div> : <form action={resolveBibliographicImportRecordAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="importId" value={importId} /><input type="hidden" name="recordId" value={record.id} /><input type="hidden" name="expectedResolutionId" value={resolution.id} /><label htmlFor={`retarget-${record.id}`}>Match another Paper</label><select id={`retarget-${record.id}`} name="paperId" required defaultValue=""><option value="" disabled>Select Paper…</option>{alternatePapers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}</option>)}</select><input name="note" placeholder="Optional note" /><button className="button secondary" type="submit" name="resolutionAction" value="matched_paper">Append match</button></form>}<form action={resolveBibliographicImportRecordAction} style={{ marginTop: 8 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="importId" value={importId} /><input type="hidden" name="recordId" value={record.id} /><input type="hidden" name="expectedResolutionId" value={resolution.id} /><button className="button ghost" type="submit" name="resolutionAction" value="cleared">Clear resolution</button></form></div>}</> : record.outcome === "failed" ? <div className="item-meta">This record cannot be resolved because parsing failed.</div> : <form action={resolveBibliographicImportRecordAction} className="extraction-form" style={{ marginTop: 12 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="importId" value={importId} /><input type="hidden" name="recordId" value={record.id} /><input type="hidden" name="expectedResolutionId" value={resolution?.id ?? ""} /><div className="field"><label htmlFor={`title-${record.id}`}>Title</label><input id={`title-${record.id}`} name="title" defaultValue={record.title ?? ""} required /></div>{record.authors.map((author, index) => <input key={`${record.id}-author-${index}`} type="hidden" name="authors" value={author} />)}<input type="hidden" name="publicationYear" value={record.publicationYear ?? ""} /><input type="hidden" name="venue" value={record.venue ?? ""} /><input type="hidden" name="doi" value={record.doi ?? ""} /><input type="hidden" name="abstract" value={record.abstract ?? ""} /><div className="field"><label htmlFor={`paper-${record.id}`}>{resolution?.eventType === "cleared" ? "Retarget existing Paper" : "Existing Paper"}</label><select id={`paper-${record.id}`} name="paperId" defaultValue=""><option value="">Select a Paper…</option>{retargetOptions.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}{"candidateReason" in paper ? ` · ${paper.candidateReason}` : ""}</option>)}</select></div>{candidates.length > 0 && <label className="field"><span><input type="checkbox" name="distinctPaperAcknowledged" /> I reviewed the candidate list and want a distinct Paper.</span></label>}<div className="field"><label htmlFor={`note-${record.id}`}>Note <span className="hint">optional</span></label><input id={`note-${record.id}`} name="note" /></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="button" type="submit" name="resolutionAction" value="created_paper">Create canonical Paper</button><button className="button secondary" type="submit" name="resolutionAction" value="matched_paper">Match existing Paper</button><button className="button ghost" type="submit" name="resolutionAction" value="cleared">Leave unresolved</button></div></form>}
      </div>;
    })}</div>{records.length > pageSize && <div className="item-row" style={{ marginTop: 16, gap: 12 }}><span className="item-meta">Records {offset + 1}-{Math.min(offset + pageSize, records.length)} of {records.length}</span><div style={{ display: "flex", gap: 8 }}>{offset > 0 && <Link className="button ghost" href={`/projects/${projectId}/papers/imports/${importId}?offset=${Math.max(0, offset - pageSize)}`}>Previous</Link>}{offset + pageSize < records.length && <Link className="button ghost" href={`/projects/${projectId}/papers/imports/${importId}?offset=${offset + pageSize}`}>Next</Link>}</div></div>}</section>
  </div></div>;
}
