import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type {
  ResearchQuestionClaimLinkRow,
  ResearchQuestionEvidenceSetLinkRow,
  ResearchQuestionExtractionLinkRow,
  ResearchQuestionSynthesisLinkRow,
  ResearchQuestionTraceabilityTargetType,
} from "@/application/research-question-bounded-read-types";
import ResearchQuestionExtractionCoverage from "../../ResearchQuestionExtractionCoverage";
import ResearchQuestionTargetHistory from "../../ResearchQuestionTargetHistory";

const targetTypes: ResearchQuestionTraceabilityTargetType[] = ["extraction-field", "evidence-set", "synthesis-statement", "claim"];

function typeLabel(type: ResearchQuestionTraceabilityTargetType) {
  switch (type) {
    case "extraction-field": return "Extraction Field";
    case "evidence-set": return "Evidence Set";
    case "synthesis-statement": return "Synthesis Statement";
    case "claim": return "Manuscript Claim";
  }
}

export default async function ResearchQuestionTargetDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; questionId: string; targetType: string; targetId: string }>;
}) {
  const { projectId, questionId, targetType: rawType, targetId } = await params;
  if (!targetTypes.includes(rawType as ResearchQuestionTraceabilityTargetType)) notFound();
  const targetType = rawType as ResearchQuestionTraceabilityTargetType;
  let detail;
  try {
    detail = await reviewServices.getResearchQuestionTargetDetail(projectId, questionId, targetType, targetId, { pageSize: 20 });
  } catch (error) {
    if (error instanceof DomainError && ["NOT_FOUND", "PROJECT_NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) notFound();
    throw error;
  }

  let label: string;
  let state: React.ReactNode;
  if (targetType === "extraction-field") {
    const target = detail.target as ResearchQuestionExtractionLinkRow;
    label = target.name;
    state = <>{target.fieldType}{target.archivedAt ? " · archived" : " · active"} · {target.hasCurrentData ? "currently has data" : "no current included-Paper data"}</>;
  } else if (targetType === "evidence-set") {
    const target = detail.target as ResearchQuestionEvidenceSetLinkRow;
    label = target.name;
    state = <>{target.archivedAt ? "archived" : "active"} · {target.memberCount} member{target.memberCount === 1 ? "" : "s"} · {target.rejectedEvidenceCount} rejected · latest composition {target.latestCompositionRevisionId ?? "none"}</>;
  } else if (targetType === "synthesis-statement") {
    const target = detail.target as ResearchQuestionSynthesisLinkRow;
    label = target.currentTitle || "Untitled synthesis statement";
    state = <>{target.currentState ?? "no finalized revision"} · {target.supportCount} formal support edge{target.supportCount === 1 ? "" : "s"} · {target.interpretationAvailable ? "interpretation available" : "no interpretation"}</>;
  } else {
    const target = detail.target as ResearchQuestionClaimLinkRow;
    label = target.currentClaimText || "Claim without finalized revision";
    state = <>{target.currentState ?? "no finalized revision"} · {target.supportStatus} ({target.supportCount}) · {target.currentPlacementCount} active manuscript placement{target.currentPlacementCount === 1 ? "" : "s"}</>;
  }
  const detailKey = `${projectId}:${questionId}:${targetType}:${detail.target.id}:${detail.traceabilityEpoch}`;

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header">
      <div><p className="eyebrow">Exact Question-target history</p><h1>{typeLabel(targetType)} · {label}</h1><p>{detail.project.title} · {detail.question.identifier} · <code>{detail.target.id}</code></p></div>
      <div style={{ display: "grid", gap: 8, justifyItems: "end"}}>
        <span className={`status ${detail.currentlyLinked ? "supported" : "withdrawn"}`}>{detail.currentlyLinked ? "Currently linked" : "Currently unlinked"}</span>
        <Link className="button secondary" href={`/projects/${projectId}/research-questions/${questionId}`}>Back to Question workspace</Link>
      </div>
    </div>
    {!detail.currentlyLinked && <div className="curation-warning-box"><strong>Historical relationship:</strong> this exact target was linked to this Question previously but is currently unlinked. Its event history remains available.</div>}
    <section className="card section-card full">
      <div className="section-heading"><h2>Current target summary</h2><span className="count">{typeLabel(targetType)}</span></div>
      <div className="item"><div className="item-title">{label}</div><div className="item-meta">{state}</div><div className="item-meta">{detail.target.diagnosticFlags.join(" · ") || "No current diagnostic flags"}</div></div>
    </section>
    {targetType === "extraction-field" && <ResearchQuestionExtractionCoverage key={`coverage:${detailKey}`} projectId={projectId} questionId={questionId} fieldId={detail.target.id} />}
    <ResearchQuestionTargetHistory key={`history:${detailKey}`} projectId={projectId} questionId={questionId} targetType={targetType} targetId={targetId} initialDetail={detail} />
    <p className="footer-note">Traceability events preserve the exact Question-target relationship. Target state and Extraction coverage reflect current data.</p>
  </div></div>;
}
