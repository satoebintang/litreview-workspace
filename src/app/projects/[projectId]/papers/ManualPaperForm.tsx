"use client";

import { useActionState, useEffect, useState } from "react";
import { addPaperAction } from "@/app/actions";
import { initialManualPaperActionState, type ManualPaperDraft } from "@/app/manual-paper-form-state";

export function ManualPaperForm({ projectId }: { projectId: string }) {
  const [state, formAction, isPending] = useActionState(addPaperAction, initialManualPaperActionState);
  const [draft, setDraft] = useState<ManualPaperDraft>(state.draft);
  const [reviewIsFresh, setReviewIsFresh] = useState(false);
  const [distinctPaperAcknowledged, setDistinctPaperAcknowledged] = useState(false);

  useEffect(() => {
    setDraft(state.draft);
    setReviewIsFresh(state.status === "reviewed");
    setDistinctPaperAcknowledged(false);
  }, [state.draft, state.status, state.version]);

  function updateDraft(field: keyof ManualPaperDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setReviewIsFresh(false);
    setDistinctPaperAcknowledged(false);
  }

  const showReview = reviewIsFresh && state.status === "reviewed";

  return (
    <form action={formAction} className="manual-paper-form" data-testid="manual-paper-form">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="form-grid form-grid--two">
        <div className="field">
          <label htmlFor="paper-title">Title</label>
          <input id="paper-title" name="title" required maxLength={1000} value={draft.title} onChange={(event) => updateDraft("title", event.currentTarget.value)} placeholder="Paper title" />
        </div>
        <div className="field">
          <label htmlFor="paper-authors">Authors <span className="hint">comma-separated, in order</span></label>
          <input id="paper-authors" name="authors" value={draft.authors} onChange={(event) => updateDraft("authors", event.currentTarget.value)} placeholder="First Author, Second Author" />
        </div>
        <div className="field">
          <label htmlFor="paper-year">Publication year <span className="hint">optional</span></label>
          <input id="paper-year" name="publicationYear" type="number" min="1000" max="3000" value={draft.publicationYear} onChange={(event) => updateDraft("publicationYear", event.currentTarget.value)} placeholder="2024" />
        </div>
        <div className="field">
          <label htmlFor="paper-venue">Venue <span className="hint">optional</span></label>
          <input id="paper-venue" name="venue" value={draft.venue} onChange={(event) => updateDraft("venue", event.currentTarget.value)} placeholder="Journal or conference" />
        </div>
        <div className="field">
          <label htmlFor="paper-doi">DOI <span className="hint">optional</span></label>
          <input id="paper-doi" name="doi" value={draft.doi} onChange={(event) => updateDraft("doi", event.currentTarget.value)} placeholder="10.1234/example" />
        </div>
        <div className="field form-field--wide">
          <label htmlFor="paper-abstract">Abstract <span className="hint">optional · used for screening</span></label>
          <textarea id="paper-abstract" name="abstract" value={draft.abstract} onChange={(event) => updateDraft("abstract", event.currentTarget.value)} placeholder="Paste the title/abstract text for screening" />
        </div>
        <div className="field form-field--wide">
          <label htmlFor="paper-bibliographic-note">Bibliographic note <span className="hint">optional · researcher-authored</span></label>
          <textarea id="paper-bibliographic-note" name="bibliographicNote" value={draft.bibliographicNote} onChange={(event) => updateDraft("bibliographicNote", event.currentTarget.value)} placeholder="Optional note about this Paper's bibliographic record" />
        </div>
      </div>

      {state.error && <p className="error-banner" role="alert">{state.error}</p>}

      {showReview && (
        <section className="duplicate-review" role="region" aria-labelledby="duplicate-heading" data-testid="manual-paper-review">
          <h3 id="duplicate-heading">Review possible duplicate Papers</h3>
          {state.candidates.length > 0 ? (
            <>
              <p className="hint">Review these existing canonical records before confirming that this is a distinct work.</p>
              <div className="item-list">
                {state.candidates.map((candidate) => (
                  <article className="item" key={candidate.id}>
                    <div className="item-title">{candidate.title}</div>
                    <div className="item-meta">{candidate.authors.join(", ") || "Authors absent"}{candidate.publicationYear ? ` · ${candidate.publicationYear}` : ""}{candidate.venue ? ` · ${candidate.venue}` : ""}</div>
                    {candidate.doi && <div className="item-meta">DOI: {candidate.doi}</div>}
                    <div className="item-meta">Match signal: {candidate.candidateReason}</div>
                  </article>
                ))}
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="distinctPaperAcknowledged"
                  value="on"
                  required
                  checked={distinctPaperAcknowledged}
                  onChange={(event) => setDistinctPaperAcknowledged(event.currentTarget.checked)}
                />
                I reviewed these candidate Papers and confirm this is a distinct work.
              </label>
            </>
          ) : (
            <p className="hint">No possible duplicate Papers were found. You can add this Paper after reviewing the empty candidate list.</p>
          )}
          {state.candidates.map((candidate) => <input key={candidate.id} type="hidden" name="candidatePaperIds" value={candidate.id} />)}
          <button className="button" type="submit" name="manualPaperIntent" value="confirm" disabled={isPending || (state.candidates.length > 0 && !distinctPaperAcknowledged)}>
            Add Paper
          </button>
        </section>
      )}

      {!showReview && state.status === "reviewed" && <p className="hint" role="status">The draft changed. Review possible duplicates again before adding this Paper.</p>}

      <button className="button secondary" type="submit" name="manualPaperIntent" value="review" disabled={isPending}>
        {isPending ? "Reviewing…" : "Review possible duplicates"}
      </button>
    </form>
  );
}
