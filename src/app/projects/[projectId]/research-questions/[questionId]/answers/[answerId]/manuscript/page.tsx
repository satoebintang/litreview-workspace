import Link from "next/link";
import { notFound } from "next/navigation";
import { applyResearchQuestionAnswerToSectionAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type {
  AnswerManuscriptOption,
  ResearchQuestionAnswerManuscriptProjection,
} from "@/domain/types";
import ClaimRevisionOrderField from "./ClaimRevisionOrderField";

type FormattedManuscriptItem = {
  id: string;
  itemType: "prose" | "claim";
  text?: string;
  placement?: { claimRevision?: { claimText?: string | null } };
};

type FormattedManuscriptView = {
  sections: Array<{ id: string; title: string; items: FormattedManuscriptItem[] }>;
};

type ManuscriptReadServices = {
  getOrCreateDefaultManuscript: (projectId: string) => Promise<{ id: string }>;
  getFormattedManuscript: (projectId: string, manuscriptId: string) => Promise<FormattedManuscriptView>;
};

type AnswerManuscriptServices = {
  getResearchQuestionAnswerManuscriptProjection: (
    projectId: string,
    questionId: string,
    answerId: string,
    selection?: { manuscriptId?: string; sectionId?: string },
  ) => Promise<ResearchQuestionAnswerManuscriptProjection>;
};

const manuscriptReadServices = reviewServices as unknown as ManuscriptReadServices;
const answerManuscriptServices = reviewServices as unknown as AnswerManuscriptServices;

function shortId(value: string): string {
  return value.slice(0, 8);
}

function targetHref(projectId: string, questionId: string, answerId: string, manuscriptId: string, sectionId?: string): string {
  const params = new URLSearchParams({ manuscriptId });
  if (sectionId) params.set("sectionId", sectionId);
  return `/projects/${projectId}/research-questions/${questionId}/answers/${answerId}/manuscript?${params.toString()}`;
}

function errorIsNotFound(error: unknown): boolean {
  return error instanceof DomainError && [
    "PROJECT_NOT_FOUND",
    "NOT_FOUND",
    "VALIDATION_ERROR",
    "CROSS_PROJECT_REFERENCE",
  ].includes(error.code);
}

function ActiveTargetNavigation({
  projectId,
  questionId,
  answerId,
  manuscripts,
  selectedManuscriptId,
  selectedSectionId,
}: {
  projectId: string;
  questionId: string;
  answerId: string;
  manuscripts: AnswerManuscriptOption[];
  selectedManuscriptId: string | null;
  selectedSectionId: string | null;
}) {
  return (
    <div data-testid="answer-manuscript-targets" style={{ display: "grid", gap: 12 }}>
      <div>
        <strong>Active Manuscripts</strong>
        <div className="claim-list-actions" style={{ marginTop: 8 }}>
          {manuscripts.map((manuscript) => (
            <Link
              key={manuscript.id}
              className={manuscript.id === selectedManuscriptId ? "button secondary" : "button ghost"}
              href={targetHref(projectId, questionId, answerId, manuscript.id, manuscript.sections[0]?.id)}
              aria-current={manuscript.id === selectedManuscriptId ? "page" : undefined}
            >
              {manuscript.title}{manuscript.isDefault ? " (default)" : ""}
            </Link>
          ))}
        </div>
      </div>
      <div>
        <strong>Active Sections</strong>
        {manuscripts.find((manuscript) => manuscript.id === selectedManuscriptId)?.sections.length ? (
          <div className="claim-list-actions" style={{ marginTop: 8 }}>
            {manuscripts.find((manuscript) => manuscript.id === selectedManuscriptId)!.sections.map((section) => (
              <Link
                key={section.id}
                className={section.id === selectedSectionId ? "button secondary" : "button ghost"}
                href={targetHref(projectId, questionId, answerId, selectedManuscriptId!, section.id)}
                aria-current={section.id === selectedSectionId ? "page" : undefined}
              >
                {section.title}
              </Link>
            ))}
          </div>
        ) : (
          <p className="hint" style={{ margin: "8px 0 0" }}>No active Sections exist in this Manuscript.</p>
        )}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Archived Sections cannot receive Answer content and are not offered as targets. The application service rejects archived targets as well.
      </p>
    </div>
  );
}

export default async function ResearchQuestionAnswerManuscriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; questionId: string; answerId: string }>;
  searchParams?: Promise<{ manuscriptId?: string; sectionId?: string; error?: string }>;
}) {
  const { projectId, questionId, answerId } = await params;
  const query = searchParams ? await searchParams : {};
  let projection: ResearchQuestionAnswerManuscriptProjection;
  let manuscriptView: FormattedManuscriptView | null = null;

  try {
    projection = await answerManuscriptServices.getResearchQuestionAnswerManuscriptProjection(
      projectId,
      questionId,
      answerId,
      { manuscriptId: query.manuscriptId, sectionId: query.sectionId },
    );
    if (projection.manuscripts.length === 0) {
      const manuscript = await manuscriptReadServices.getOrCreateDefaultManuscript(projectId);
      projection = await answerManuscriptServices.getResearchQuestionAnswerManuscriptProjection(
        projectId,
        questionId,
        answerId,
        { manuscriptId: manuscript.id },
      );
    }
    if (projection.selectedManuscriptId) {
      manuscriptView = await manuscriptReadServices.getFormattedManuscript(projectId, projection.selectedManuscriptId);
    }
  } catch (error) {
    if (errorIsNotFound(error)) notFound();
    throw error;
  }

  const selectedSection = manuscriptView?.sections.find((section) => section.id === projection.selectedSectionId);
  const activeItems = selectedSection?.items ?? [];
  const selectedManuscript = projection.manuscripts.find((manuscript: AnswerManuscriptOption) => manuscript.id === projection.selectedManuscriptId);

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container workspace">
        <Link className="back-link" href={`/projects/${projectId}/research-questions/${questionId}/answers/${answerId}`}>← Back to exact Answer snapshot</Link>
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Answer-centric manuscript drafting</p>
            <h1>{projection.researchQuestion.identifier} · Answer #{projection.answer.sequence}</h1>
            <p>{projection.researchQuestion.label}</p>
          </div>
          <span className="status supported">● Finalized Answer</span>
        </div>

        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {projection.researchQuestion.archivedAt && (
          <div className="curation-warning-box" data-testid="archived-rq-notice">
            <strong>Research Question archived:</strong> this historical state is shown factually. Answer manuscript drafting remains available; archival does not block this action.
          </div>
        )}

        <section className="card section-card full" data-testid="answer-drafting-context">
          <div className="section-heading"><h2>Exact Answer context</h2><span className="status supported">Immutable snapshot</span></div>
          <div className="quote" data-testid="answer-text" style={{ whiteSpace: "pre-wrap" }}>{projection.answer.answerText}</div>
          <aside className="item" data-testid="answer-researcher-note" style={{ marginTop: 12 }}>
            <strong>Researcher note</strong>
            <div className="item-meta" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{projection.answer.researcherNote || "No researcher note was recorded."}</div>
          </aside>
          <p className="hint" style={{ marginBottom: 0, marginTop: 12 }}>
            The note is context only and is never copied into manuscript prose. The prose field below is prefilled from the exact Answer text.
          </p>
        </section>

        <section className="card section-card full">
          <div className="section-heading"><h2>Choose manuscript target</h2><span className="count">Active targets only</span></div>
          {projection.manuscripts.length === 0 ? (
            <div className="empty">No Manuscript target is available. <Link className="back-link" href={`/projects/${projectId}/manuscript`}>Open the manuscript workspace to create one →</Link></div>
          ) : (
            <ActiveTargetNavigation
              projectId={projectId}
              questionId={questionId}
              answerId={answerId}
              manuscripts={projection.manuscripts}
              selectedManuscriptId={projection.selectedManuscriptId}
              selectedSectionId={projection.selectedSectionId}
            />
          )}
        </section>

        {projection.synthesisContexts.length > 0 && (
          <section className="card section-card full" data-testid="answer-synthesis-contexts">
            <div className="section-heading"><h2>Synthesis contexts</h2><span className="count">Read-only analytical context</span></div>
            <p className="hint">These exact SynthesisRevisions are shown for drafting context only. They have no apply, support, or citation controls here.</p>
            <div className="item-list">
              {projection.synthesisContexts.map((context) => (
                <article className="item" key={context.synthesisRevisionId}>
                  <div className="item-title">SynthesisRevision <code>{shortId(context.synthesisRevisionId)}</code> · sequence {context.synthesisRevisionSequence}</div>
                  {context.title && <div style={{ fontWeight: 600, marginTop: 5 }}>{context.title}</div>}
                  <div className="quote-inline" style={{ margin: "6px 0" }}>{context.statementText || "Statement text unavailable."}</div>
                  <div className="item-meta">Exact state: {context.synthesisRevisionState} · current revision: {context.isCurrentRevision ? "same exact revision" : `sequence ${context.currentRevisionSequence ?? "unknown"}`} · current state: {context.currentRevisionState ?? "unknown"}</div>
                  {context.interpretation && <div className="item-meta" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>Interpretation context ({context.interpretation.convergenceState}): {context.interpretation.summary}</div>}
                </article>
              ))}
            </div>
          </section>
        )}

        {projection.selectedManuscriptId && projection.selectedSectionId && selectedSection ? (
          <form action={applyResearchQuestionAnswerToSectionAction} data-testid="answer-manuscript-form">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="questionId" value={questionId} />
            <input type="hidden" name="answerId" value={answerId} />
            <input type="hidden" name="manuscriptId" value={projection.selectedManuscriptId} />
            <input type="hidden" name="sectionId" value={projection.selectedSectionId} />

            <section className="card section-card full">
              <div className="section-heading"><h2>Draft into {selectedManuscript?.title} / {selectedSection.title}</h2><span className="count">Explicit submission required</span></div>
              <div className="field">
                <label htmlFor="answer-prose">Manuscript prose <span className="hint">optional when ClaimRevisions are selected</span></label>
                <textarea id="answer-prose" name="proseText" defaultValue={projection.answer.answerText} maxLength={50000} rows={6} data-testid="answer-prose" />
              </div>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend>Insertion position</legend>
                <label style={{ display: "block", marginTop: 8 }}><input type="radio" name="insertionKind" value="append" defaultChecked /> Append after existing active items</label>
                <label style={{ display: "block", marginTop: 8 }}><input type="radio" name="insertionKind" value="before" disabled={activeItems.length === 0} /> Insert before an active SectionItem</label>
                <select name="sectionItemId" aria-label="Active SectionItem anchor" defaultValue="" disabled={activeItems.length === 0} style={{ marginTop: 8, minWidth: 280 }}>
                  <option value="">Select an active anchor</option>
                  {activeItems.map((item, index) => (
                    <option key={item.id} value={item.id}>{index + 1}. {item.itemType === "prose" ? "Prose" : "ClaimRevision"} · {item.itemType === "prose" ? String(item.text ?? "").slice(0, 60) : String(item.placement?.claimRevision?.claimText ?? "Claim").slice(0, 60)}</option>
                  ))}
                </select>
              </fieldset>
            </section>

            <section className="card section-card full">
              <div className="section-heading"><h2>Claim contexts</h2><span className="count">Order is submitted exactly as selected</span></div>
              <p className="hint">Choose prose-only, Claim-only, or a combined draft. The service rejects an empty submission.</p>
              <ClaimRevisionOrderField contexts={projection.claimContexts} />
            </section>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
              <button className="button secondary" type="submit" data-testid="apply-answer-to-manuscript">Use Answer in manuscript</button>
            </div>
          </form>
        ) : (
          <section className="card section-card full"><div className="empty">Select an active Section before drafting. <Link className="back-link" href={`/projects/${projectId}/manuscript`}>Open the manuscript workspace →</Link></div></section>
        )}

        <p className="footer-note">Answer context does not create an Answer reference on Manuscript records. Only researcher-authored prose and explicitly selected exact ClaimRevisions are applied.</p>
      </div>
    </main>
  );
}
