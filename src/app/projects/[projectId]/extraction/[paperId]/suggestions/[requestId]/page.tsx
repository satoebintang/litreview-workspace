import Link from "next/link";
import { notFound } from "next/navigation";
import {
  acceptAiExtractionSuggestionAction,
  executeAiExtractionSuggestionAction,
  expireAiExtractionSuggestionAction,
  rejectAiExtractionSuggestionAction,
} from "@/app/actions";
import { aiExtractionServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

function displayResult(result: Record<string, unknown>, options: { id: string; label: string }[]) {
  if (result.state !== "present") return String(result.state ?? "No candidate").replaceAll("_", " ");
  if (result.value == null) return "—";
  return options.find((option) => option.id === String(result.value))?.label ?? String(result.value);
}

export default async function AiExtractionSuggestionPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string; requestId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, paperId, requestId } = await params;
  const query = searchParams ? await searchParams : {};
  let snapshot: Record<string, unknown>;
  try {
    snapshot = await aiExtractionServices.getAiExtractionSuggestion(requestId, projectId);
  } catch (error) {
    if (error instanceof DomainError && ["NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const request = snapshot.request as Record<string, unknown>;
  if (String(request.paperId) !== paperId) notFound();
  const sourceCoverage = snapshot.sourceCoverage as { status?: string; omittedPageCount?: number } | undefined;
  const result = snapshot.result as Record<string, unknown> | null;
  const groundings = (snapshot.groundings as Record<string, unknown>[] | undefined) ?? [];
  const pages = (snapshot.pages as Record<string, unknown>[] | undefined) ?? [];
  const optionSnapshot = (Array.isArray(request.optionSnapshot) ? request.optionSnapshot : []) as { id: string; label: string }[];
  const valueKind = request.fieldType === "number" ? "number" : request.fieldType === "boolean" ? "boolean" : request.fieldType === "single_select" ? "single_select" : "text";
  const savedMessage = query.saved === "accepted" ? "AI suggestion accepted as a new canonical extraction revision." : query.saved === "rejected" ? "AI suggestion rejected." : undefined;
  const terminal = Boolean(result);
  const successful = result?.outcome === "succeeded" && result.state != null;

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/extraction/${paperId}`}>← Extraction worksheet</Link>
      <div className="workspace-header"><div><p className="eyebrow">AI extraction suggestion</p><h1>{String(request.fieldName ?? "Extraction field")}</h1><p className="hint">Request {String(request.id)}</p></div><span className="status">{terminal ? String(result?.outcome).replaceAll("_", " ") : "ready to execute"}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <section className="card section-card"><h2>Durable request</h2><p className="hint">The request was finalized before any provider call. Source pages are frozen by immutable identity and exact persisted text.</p><dl className="metadata-grid"><div><dt>Model</dt><dd>{String(request.model)}</dd></div><div><dt>Pages</dt><dd>{pages.length}</dd></div><div><dt>Baseline revision</dt><dd>{request.baselineRevisionId ? String(request.baselineRevisionId) : "No prior revision"}</dd></div><div><dt>Transmission</dt><dd>Acknowledged · {String(request.disclosureVersion)}</dd></div></dl>
        {sourceCoverage?.status === "partial" && <p className="support-warning">This request uses a partial text extraction. {Number(sourceCoverage.omittedPageCount ?? 0)} page(s) were failed or empty and were not sent to the provider; absence claims must be reviewed cautiously.</p>}
        {!terminal && <form action={executeAiExtractionSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="requestId" value={requestId} /><button className="button" type="submit">Execute suggestion</button></form>}
        {!terminal && <form action={expireAiExtractionSuggestionAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="requestId" value={requestId} /><button className="button secondary" type="submit">Expire request</button></form>}
      </section>
      {result && <section className="card section-card"><h2>Provider result</h2><p className="hint">{result.explanation ? String(result.explanation) : "No provider explanation was recorded."}</p><p className="current-observation"><strong>Suggested value:</strong> {displayResult(result, optionSnapshot)}</p><p className="item-meta">Diagnostic: {String(result.providerDiagnostic)}{result.errorCode ? ` · ${String(result.errorCode)}` : ""}</p>
        {successful && <>
          <h3>Grounding passages</h3><div className="item-list">{groundings.length === 0 ? <div className="empty">No grounding passages.</div> : groundings.map((grounding) => <label className="checkbox-row" key={String(grounding.id)}><input type="checkbox" name="previewGrounding" value={String(grounding.id)} defaultChecked /><span><strong>Page {String(grounding.page_number)}</strong> · “{String(grounding.source_text)}” <small>{String(grounding.start_offset)}–{String(grounding.end_offset)}</small></span></label>)}</div>
          <div className="ai-acceptance-grid"><form action={acceptAiExtractionSuggestionAction} className="extraction-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="mode" value="accept" /><input type="hidden" name="expectedCurrentRevisionId" value={String(request.baselineRevisionId ?? "")} /><input type="hidden" name="state" value={String(result.state)} /><input type="hidden" name="valueKind" value={valueKind} />{groundings.map((grounding) => <input type="hidden" name="groundingIds" value={String(grounding.id)} key={String(grounding.id)} />)}<button className="button" type="submit">Accept exactly</button></form>
            <form action={acceptAiExtractionSuggestionAction} className="extraction-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="mode" value="edit_and_accept" /><input type="hidden" name="expectedCurrentRevisionId" value={String(request.baselineRevisionId ?? "")} /><input type="hidden" name="valueKind" value={valueKind} /><div className="field"><label>Edited state<select name="state" defaultValue={String(result.state)}><option value="present">Value reported</option><option value="not_reported">Not reported</option><option value="not_applicable">Not applicable</option><option value="cleared">Clear response</option></select></label></div><div className="field"><label>Edited value{valueKind === "boolean" ? <select name="value" defaultValue={result.value == null ? "" : String(result.value)}><option value="">Select yes or no</option><option value="true">Yes</option><option value="false">No</option></select> : valueKind === "single_select" ? <select name="value" defaultValue={String(result.value ?? "")}><option value="">Select an option</option>{optionSnapshot.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input name="value" type={valueKind === "number" ? "number" : "text"} step={valueKind === "number" ? "any" : undefined} defaultValue={String(result.value ?? "")} />}</label><p className="hint">Used when the edited state is “Value reported”.</p></div><div className="field"><label>Researcher note<textarea name="researcherNote" /></label></div><fieldset className="evidence-picker"><legend>Selected grounding</legend>{groundings.map((grounding) => <label className="checkbox-row" key={String(grounding.id)}><input type="checkbox" name="groundingIds" value={String(grounding.id)} defaultChecked /><span>Page {String(grounding.page_number)} — “{String(grounding.source_text)}”</span></label>)}</fieldset><button className="button" type="submit">Edit &amp; accept</button></form></div>
        </>}
        {!successful && result && <p className="hint">This terminal result cannot be accepted. A new request is required for another provider attempt.</p>}
        <form action={rejectAiExtractionSuggestionAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="requestId" value={requestId} /><button className="button secondary" type="submit">Reject suggestion</button></form>
      </section>}
    </div></main>;
}
