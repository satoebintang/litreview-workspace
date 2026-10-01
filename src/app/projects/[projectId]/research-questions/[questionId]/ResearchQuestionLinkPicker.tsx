"use client";

import { useState } from "react";
import {
  linkClaimAction,
  linkEvidenceSetAction,
  linkExtractionFieldAction,
  linkSynthesisStatementAction,
} from "@/app/actions";
import { getResearchQuestionTargetPickerPageAction } from "@/app/actions/research-question-bounded";
import type {
  ResearchQuestionTargetPickerPage,
  ResearchQuestionTraceabilityTargetType,
} from "@/application/research-question-bounded-read-types";

const config: Record<ResearchQuestionTraceabilityTargetType, { noun: string; fieldName: string }> = {
  "extraction-field": { noun: "field", fieldName: "fieldId" },
  "evidence-set": { noun: "set", fieldName: "evidenceSetId" },
  "synthesis-statement": { noun: "statement", fieldName: "statementId" },
  claim: { noun: "claim", fieldName: "claimId" },
};

export default function ResearchQuestionLinkPicker({
  projectId,
  questionId,
  targetType,
}: {
  projectId: string;
  questionId: string;
  targetType: ResearchQuestionTraceabilityTargetType;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<ResearchQuestionTargetPickerPage | null>(null);
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const item = config[targetType];
  const queryLength = Array.from(query.trim()).length;

  const linkAction = targetType === "extraction-field" ? linkExtractionFieldAction
    : targetType === "evidence-set" ? linkEvidenceSetAction
      : targetType === "synthesis-statement" ? linkSynthesisStatementAction
        : linkClaimAction;

  async function load(cursor?: string | null, search = query) {
    setBusy(true);
    setError(null);
    const result = await getResearchQuestionTargetPickerPageAction(projectId, questionId, targetType, {
      pageSize: 25,
      cursor,
      search,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPage(result.value);
    setAppliedSearch(result.value.search);
    setSelectedId((current) => result.value.items.some((row) => row.id === current) ? current : "");
  }

  async function open() {
    setOpened(true);
    if (!page) await load(null, "");
  }

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await load(null, query);
  }

  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
      <h3 style={{ fontSize: 15 }}>Link {item.noun.charAt(0).toUpperCase() + item.noun.slice(1)}</h3>
      {!opened ? <button className="button secondary" type="button" onClick={() => void open()}>Browse {item.noun}s</button> : (
        <>
          <form onSubmit={(event) => void search(event)} className="inline-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
            <label htmlFor={`${targetType}-search`}>Search by label</label>
            <input id={`${targetType}-search`} value={query} maxLength={400} onChange={(event) => setQuery(event.target.value)} placeholder="Literal substring" />
            <button className="button ghost" type="submit" disabled={busy || queryLength > 200}>Search</button>
            <button className="button ghost" type="button" disabled={busy} onClick={() => { setQuery(""); void load(null, ""); }}>Browse all</button>
            <span className="hint">{queryLength}/200 Unicode code points</span>
          </form>
          {error && <div className="curation-warning-box" role="alert">{error} <button className="button ghost" type="button" onClick={() => void load(null)}>Refresh picker</button></div>}
          {page && page.items.length === 0 && <p className="hint">No unlinked {item.noun}s match this search.</p>}
          {page && page.items.length > 0 && (
            <form action={linkAction} className="inline-form" style={{ flexWrap: "wrap" }}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="questionId" value={questionId} />
              <select
                name={item.fieldName}
                required
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
                style={{ minWidth: 260 }}
                aria-label={`Select ${item.noun} to link`}
              >
                <option value="" disabled>Select a {item.noun}...</option>
                {page.items.map((target) => <option key={target.id} value={target.id}>
                  {target.label}{target.state ? ` [${target.state}]` : ""}{target.archivedAt ? " [archived]" : ""}
                </option>)}
              </select>
              <input name="note" placeholder="Optional link rationale or note (max 2000 chars)" style={{ flex: 1, minWidth: 200 }} />
              <button className="button secondary" type="submit">Link {item.noun}</button>
            </form>
          )}
          {page && <div className="inline-form" style={{ marginTop: 10 }}>
            <span className="hint">Showing {page.items.length} candidates. Archived targets and targets without active revisions remain available when the writer allows them.</span>
            {page.hasMore && <button className="button ghost" type="button" disabled={busy} onClick={() => void load(page.nextCursor, appliedSearch)}>Next candidates</button>}
          </div>}
        </>
      )}
    </div>
  );
}
