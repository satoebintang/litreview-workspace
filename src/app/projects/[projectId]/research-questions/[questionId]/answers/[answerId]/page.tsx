import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { AnswerSnapshotCard } from "../../ResearchQuestionAnswerPanel";

export default async function ResearchQuestionAnswerSnapshotPage({
  params,
}: {
  params: Promise<{ projectId: string; questionId: string; answerId: string }>;
}) {
  const { projectId, questionId, answerId } = await params;
  let project;
  let detail;
  let snapshot;
  try {
    [project, detail, snapshot] = await Promise.all([
      reviewServices.getProject(projectId),
      reviewServices.getQuestionTraceability(projectId, questionId),
      reviewServices.getResearchQuestionAnswerSnapshot(projectId, questionId, answerId),
    ]);
  } catch (error) {
    if (error instanceof DomainError && [
      "PROJECT_NOT_FOUND",
      "NOT_FOUND",
      "VALIDATION_ERROR",
      "CROSS_PROJECT_REFERENCE",
    ].includes(error.code)) {
      notFound();
    }
    throw error;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">T</span> Tracework
        </Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container workspace">
        <Link className="back-link" href={`/projects/${projectId}/research-questions/${questionId}`}>
          ← Back to {detail.question.identifier} workspace
        </Link>
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Research Question Answer Snapshot</p>
            <h1>{detail.question.identifier} · Answer #{snapshot.sequence}</h1>
            <p>{project.title} · immutable historical analytical context</p>
          </div>
          <span className="status supported">● Finalized</span>
        </div>
        <section className="card section-card full" data-testid="answer-snapshot-page">
          <p className="hint" style={{ marginTop: 0 }}>
            This page shows the exact Answer text and typed revision contexts captured at finalization. Later lifecycle, link, or revision changes produce derived drift annotations only and do not rewrite this snapshot.
          </p>
          <AnswerSnapshotCard snapshot={snapshot} />
        </section>
        <p className="footer-note">
          Answer contexts are not formal support or citation edges and are not projected into manuscript, ReviewFlow, or PRISMA records.
        </p>
      </div>
    </main>
  );
}
