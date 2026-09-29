import Link from "next/link";
import { notFound } from "next/navigation";
import {
  acceptAiSynthesisSuggestionAction,
  executeAiSynthesisSuggestionAction,
  expireAiSynthesisSuggestionAction,
  rejectAiSynthesisSuggestionAction,
} from "@/app/actions";
import { aiSynthesisServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type AiDetail = {
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  supports: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  groundings: Record<string, unknown>[];
  decision: Record<string, unknown> | null;
  dispatch: Record<string, unknown> | null;
};

function text(value: unknown, fallback = "—") {
  return value == null || value === "" ? fallback : String(value);
}

function frozenSupportValue(support: Record<string, unknown>) {
  const state = String(support.value_state ?? "").replaceAll("_", " ");
  if (state !== "present") return state || "unknown";
  switch (String(support.field_type)) {
    case "short_text":
    case "long_text": return text(support.text_value);
    case "number": return text(support.number_value);
    case "boolean": return support.boolean_value == null ? "—" : Boolean(support.boolean_value) ? "Yes" : "No";
    case "single_select": return `${text(support.option_id)} · ${text(support.option_label_snapshot, "(label unavailable)")}`;
    default: return text(support.value_canonical);
  }
}

export default async function AiSynthesisRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; preparationId: string; requestId: string }>;
  searchParams?: Promise<{ saved?: string; error?: string }>;
}) {
  const { projectId, preparationId, requestId } = await params;
  const query = searchParams ? await searchParams : {};
  let detail: AiDetail;
  try {
    detail = await aiSynthesisServices.getAiSynthesisSuggestion(requestId, projectId, preparationId) as unknown as AiDetail;
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }

  const request = detail.request;
  const result = detail.result;
  const decision = detail.decision;
  const outcome = result == null ? "pending" : String(result.outcome);
  const candidate = result?.statementText != null;
  const path = `/projects/${projectId}/synthesis/preparations/${preparationId}`;
  const resolvedDecision = decision == null ? null : String(decision.decision);

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow"><Link href={path}>Preparation workspace</Link> / Exact AI request</p>
            <h1>AI synthesis request audit</h1>
            <p>Request {requestId} · preparation {preparationId}</p>
          </div>
          <Link className="button ghost" href={path}>Return to preparation →</Link>
        </div>

        {query.saved === "ai-rejected" && <div className="success-note" role="status">AI synthesis suggestion rejected.</div>}
        {query.saved === "ai-accepted" && <div className="success-note" role="status">AI synthesis suggestion accepted into the canonical synthesis path.</div>}
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}

        <section className="card section-card">
          <div className="section-heading"><h2>Frozen request</h2><span className={`status ${resolvedDecision ? "supported" : result ? "stale" : "unsupported"}`}>{resolvedDecision ?? outcome}</span></div>
          <div className="item-list">
            <div className="item-meta">Request ID: {text(request.id)} · Project ID: {text(request.projectId)} · Preparation ID: {text(request.preparationId)}</div>
            <div className="item-meta">Created: {request.createdAt instanceof Date ? request.createdAt.toLocaleString() : text(request.createdAt)} · Provider: {text(request.provider)} · configured model: {text(request.model)} · reasoning effort: {text(request.reasoningEffort)}</div>
            <div className="item-meta">Evidence Set: {text(request.evidenceSetId)} · exact composition revision: {text(request.evidenceSetCompositionRevisionId)} · Extraction Field: {text(request.extractionFieldId)}</div>
            <div className="item-meta">Frozen field: {text(request.fieldName)} ({text(request.fieldType)}){request.fieldDescription ? ` · ${String(request.fieldDescription)}` : ""}</div>
            <div className="item-meta">Source coverage: {text(request.sourceCoverageState)} · {text(request.supportCount, "0")} supports · {text(request.sourceCount, "0")} Evidence passages · {text(request.sourceCharacterCount, "0")} source characters · {text(request.sourceByteSize, "0")} source bytes</div>
            <div className="item-meta">Manifest SHA-256: {text(request.sourceManifestHash)} · source state SHA-256: {text(request.sourceStateHash)} · intent SHA-256: {text(request.intentHash)}</div>
            <div className="item-meta">Prompt {text(request.promptVersion)} · response schema {text(request.responseSchemaVersion)} · grounding resolver {text(request.groundingResolverVersion)} · context selection {text(request.contextSelectionVersion)}</div>
            <div className="item-meta">External transmission acknowledged: {request.externalTransmissionAcknowledged ? "yes" : "no"} · disclosure: {text(request.disclosureVersion)}</div>
          </div>
        </section>

        {detail.dispatch && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <div className="section-heading"><h2>Provider dispatch</h2><span className="count">Dispatch record</span></div>
            <div className="item-meta">Deadline: {text(detail.dispatch.deadline_at)} · provider request ID: {text(detail.dispatch.provider_request_id)}</div>
          </section>
        )}

        <section className="card section-card" style={{ marginTop: 16 }}>
          <div className="section-heading"><h2>Frozen supports</h2><span className="count">{detail.supports.length} rows</span></div>
          {detail.supports.length === 0 ? <div className="empty">This request has no frozen supports.</div> : (
            <div className="item-list">
              {detail.supports.map((support) => (
                <article className="item" key={String(support.extraction_revision_id)}>
                  <div className="item-title">{text(support.paper_title_snapshot)}</div>
                  <div className="item-meta">Paper {text(support.paper_id)}{support.paper_publication_year_snapshot ? ` · ${String(support.paper_publication_year_snapshot)}` : ""} · Extraction value {text(support.extraction_value_id)} · exact revision {text(support.extraction_revision_id)}</div>
                  <div className="item-meta">Field type: {text(support.field_type)} · value state: {text(support.value_state)} · frozen value: {frozenSupportValue(support)}</div>
                  {support.researcher_note != null && <div className="hint">Frozen researcher note: {String(support.researcher_note)}</div>}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="card section-card" style={{ marginTop: 16 }}>
          <div className="section-heading"><h2>Connecting Evidence manifest</h2><span className="count">{detail.sources.length} rows</span></div>
          <p className="hint">These exact source passages were frozen for the request. Curation state is retained in the manifest.</p>
          {detail.sources.length === 0 ? <div className="empty">This request has no source passages.</div> : (
            <div className="item-list">
              {detail.sources.map((source) => (
                <article className="item" key={`${String(source.extraction_revision_id)}-${String(source.evidence_id)}`}>
                  <div className="item-row">
                    <div>
                      <Link className="item-title" href={`/projects/${projectId}/evidence/${String(source.evidence_id)}`}>Evidence {String(source.evidence_id)}</Link>
                      <div className="item-meta">Extraction revision {text(source.extraction_revision_id)} · page {text(source.page_number)} · {text(source.evidence_review_state)}</div>
                    </div>
                  </div>
                  <div className="quote">“{text(source.source_text, "") }”</div>
                  {source.evidence_note_snapshot != null && <div className="item-meta">Frozen Evidence note: {String(source.evidence_note_snapshot)}</div>}
                </article>
              ))}
            </div>
          )}
        </section>

        {result && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <div className="section-heading"><h2>Provider result</h2><span className={`status ${outcome === "succeeded" ? "supported" : "stale"}`}>{outcome}</span></div>
            <div className="item-list">
              <div className="item-meta">Outcome: {text(result.outcome)} · diagnostic: {text(result.providerDiagnostic)} · error code: {text(result.errorCode)}</div>
              <div className="item-meta">Returned model: {text(result.returnedModel)} · provider request ID: {text(result.providerRequestId)}</div>
              <div className="item-meta">Input tokens: {text(result.inputTokens)} · output tokens: {text(result.outputTokens)} · duration: {text(result.durationMs)} ms</div>
              <div className="item-meta">Source coverage: {text(result.sourceCoverageState)} · covered supports: {text(result.coveredSupportCount, "0")} · finalized: {result.finalizedAt instanceof Date ? result.finalizedAt.toLocaleString() : text(result.finalizedAt)}</div>
            </div>
            {result.title != null && <h3 style={{ marginTop: 16 }}>{String(result.title)}</h3>}
            {result.statementText != null && <div className="quote">{String(result.statementText)}</div>}
            {result.explanation != null && <p className="hint">{String(result.explanation)}</p>}
          </section>
        )}

        <section className="card section-card" style={{ marginTop: 16 }}>
          <div className="section-heading"><h2>Frozen grounding locators</h2><span className="count">{detail.groundings.length} rows</span></div>
          {detail.groundings.length === 0 ? <div className="empty">No grounding locators were recorded.</div> : (
            <div className="item-list">
              {detail.groundings.map((grounding) => (
                <article className="item" key={String(grounding.id)}>
                  <div className="item-meta">Extraction revision {text(grounding.extraction_revision_id)} · Evidence {text(grounding.evidence_id)} · character offsets {text(grounding.start_offset)}–{text(grounding.end_offset)}</div>
                  <div className="quote">“{text(grounding.locator_quote, "") }”</div>
                  {grounding.locator_prefix != null && <div className="item-meta">Prefix: “{String(grounding.locator_prefix)}”</div>}
                  {grounding.locator_suffix != null && <div className="item-meta">Suffix: “{String(grounding.locator_suffix)}”</div>}
                </article>
              ))}
            </div>
          )}
        </section>

        {decision && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <div className="section-heading"><h2>Researcher decision</h2><span className={`status ${resolvedDecision === "accepted" ? "supported" : "stale"}`}>{resolvedDecision}</span></div>
            <div className="item-meta">Decision ID: {text(decision.id)} · made {text(decision.created_at)}</div>
            {decision.resulting_synthesis_revision_id != null && <div className="item-meta">Canonical synthesis revision: {String(decision.resulting_synthesis_revision_id)}</div>}
            {decision.statement_text != null && <div className="quote">{String(decision.statement_text)}</div>}
            {decision.researcher_note != null && <div className="hint">Researcher note: {String(decision.researcher_note)}</div>}
          </section>
        )}

        {!result && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <h2>Request actions</h2>
            <div className="item-row">
              <form action={executeAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={requestId} /><button className="button secondary" type="submit">Generate suggestion</button></form>
              <form action={expireAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={requestId} /><button className="button ghost" type="submit">Mark request timed out</button></form>
            </div>
          </section>
        )}

        {candidate && !decision && result && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <h2>Researcher decision</h2>
            <div className="item-row" style={{ marginTop: 12 }}>
              <form action={acceptAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="mode" value="accept" /><button className="button primary" type="submit">Use unchanged</button></form>
              <form action={rejectAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={requestId} /><button className="button ghost" type="submit">Reject</button></form>
            </div>
            <form action={acceptAiSynthesisSuggestionAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="mode" value="edit_and_accept" />
              <div className="field"><label htmlFor="ai-title">Edit title</label><input id="ai-title" name="title" defaultValue={String(result.title ?? "")} maxLength={500} /></div>
              <div className="field"><label htmlFor="ai-statement">Edit statement</label><textarea id="ai-statement" name="statementText" defaultValue={String(result.statementText ?? "")} maxLength={10000} required /></div>
              <div className="field"><label htmlFor="ai-note">Researcher note</label><textarea id="ai-note" name="researcherNote" maxLength={10000} /></div>
              <button className="button secondary" type="submit">Edit and accept</button>
            </form>
          </section>
        )}
        {outcome === "no_candidate" && !decision && <form action={rejectAiSynthesisSuggestionAction} style={{ marginTop: 16 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={requestId} /><button className="button ghost" type="submit">Acknowledge and reject</button></form>}
      </div>
    </div>
  );
}
