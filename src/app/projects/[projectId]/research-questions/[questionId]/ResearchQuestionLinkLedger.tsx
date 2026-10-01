"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  unlinkClaimAction,
  unlinkEvidenceSetAction,
  unlinkExtractionFieldAction,
  unlinkSynthesisStatementAction,
} from "@/app/actions";
import { listResearchQuestionLinkPageAction } from "@/app/actions/research-question-bounded";
import type {
  ResearchQuestionBoundedPage,
  ResearchQuestionClaimLinkRow,
  ResearchQuestionEvidenceSetLinkRow,
  ResearchQuestionExtractionLinkRow,
  ResearchQuestionSynthesisLinkRow,
  ResearchQuestionTraceabilityTargetType,
} from "@/application/research-question-bounded-read-types";
import ResearchQuestionLinkPicker from "./ResearchQuestionLinkPicker";

type LinkRow = ResearchQuestionExtractionLinkRow | ResearchQuestionEvidenceSetLinkRow | ResearchQuestionSynthesisLinkRow | ResearchQuestionClaimLinkRow;
type LinkPage = ResearchQuestionBoundedPage<LinkRow>;

const heading: Record<ResearchQuestionTraceabilityTargetType, string> = {
  "extraction-field": "Extraction Fields",
  "evidence-set": "Evidence Sets",
  "synthesis-statement": "Synthesis Statements",
  claim: "Manuscript Claims",
};

const unlinkAction = {
  "extraction-field": unlinkExtractionFieldAction,
  "evidence-set": unlinkEvidenceSetAction,
  "synthesis-statement": unlinkSynthesisStatementAction,
  claim: unlinkClaimAction,
} as const;

function targetIdField(type: ResearchQuestionTraceabilityTargetType) {
  switch (type) {
    case "extraction-field": return "fieldId";
    case "evidence-set": return "evidenceSetId";
    case "synthesis-statement": return "statementId";
    case "claim": return "claimId";
  }
}

function detailHref(projectId: string, questionId: string, type: ResearchQuestionTraceabilityTargetType, targetId: string) {
  return `/projects/${projectId}/research-questions/${questionId}/traceability/${type}/${targetId}`;
}

function diagnosticText(flags: string[]) {
  return flags.length ? flags.map((flag) => flag.split("_").join(" ")).join(" · ") : "No current diagnostic flags";
}

export default function ResearchQuestionLinkLedger({
  projectId,
  questionId,
  targetType,
  initialPage,
  linkedCount,
  isArchived,
}: {
  projectId: string;
  questionId: string;
  targetType: ResearchQuestionTraceabilityTargetType;
  initialPage: ResearchQuestionBoundedPage<LinkRow>;
  linkedCount: number;
  isArchived: boolean;
}) {
  const router = useRouter();
  const [page, setPage] = useState<LinkPage>(initialPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(initialPage);
    setError(null);
  }, [initialPage]);

  async function load(cursor?: string | null) {
    setBusy(true);
    setError(null);
    const result = await listResearchQuestionLinkPageAction(projectId, questionId, targetType, { pageSize: 25, cursor });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPage(result.value as LinkPage);
  }

  function refresh() { router.refresh(); }

  function renderRow(item: LinkRow) {
    const id = item.id;
    const href = detailHref(projectId, questionId, targetType, id);
    const unlinkField = targetIdField(targetType);
    let label: string;
    let summary: React.ReactNode;
    if (targetType === "extraction-field") {
      const row = item as ResearchQuestionExtractionLinkRow;
      label = row.name;
      summary = <>{row.fieldType}{row.archivedAt ? " · archived" : ""} · {row.hasCurrentData ? "current data present" : "no current data"}</>;
    } else if (targetType === "evidence-set") {
      const row = item as ResearchQuestionEvidenceSetLinkRow;
      label = row.name;
      summary = <>{row.archivedAt ? "archived · " : ""}{row.memberCount} member{row.memberCount === 1 ? "" : "s"} · {row.rejectedEvidenceCount} rejected · latest composition {row.latestCompositionRevisionId ? row.latestCompositionRevisionId.slice(0, 8) : "none"}</>;
    } else if (targetType === "synthesis-statement") {
      const row = item as ResearchQuestionSynthesisLinkRow;
      label = row.currentTitle || "Untitled synthesis statement";
      summary = <>{row.currentState ?? "no finalized revision"} · {row.supportCount} formal support edge{row.supportCount === 1 ? "" : "s"} · {row.interpretationAvailable ? "interpretation available" : "no interpretation"}</>;
    } else {
      const row = item as ResearchQuestionClaimLinkRow;
      label = row.currentClaimText || "Claim without finalized revision";
      summary = <>{row.currentState ?? "no finalized revision"} · {row.supportStatus} ({row.supportCount}) · {row.currentPlacementCount} active placement{row.currentPlacementCount === 1 ? "" : "s"}</>;
    }

    return <article className="item" key={id}>
      <div className="item-row">
        <div style={{ minWidth: 0 }}>
          <div className="item-title"><Link href={href}>{label}</Link></div>
          <div className="item-meta">{summary} · <code>{id}</code></div>
          <div className="item-meta">{diagnosticText(item.diagnosticFlags)}</div>
        </div>
        {!isArchived && <form action={unlinkAction[targetType]} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="questionId" value={questionId} />
          <input type="hidden" name={unlinkField} value={id} />
          <input name="note" aria-label={`Unlink note for ${label}`} placeholder="Optional unlink note" style={{ width: 180, padding: "5px 8px", fontSize: 12 }} />
          <button className="button ghost danger" type="submit">Unlink</button>
        </form>}
      </div>
      <div className="item-meta" style={{ marginTop: 6 }}><Link href={href}>View exact Event History →</Link></div>
    </article>;
  }

  const countForNoun = linkedCount === 1 ? "linked target" : "linked targets";
  const emptyText: Record<ResearchQuestionTraceabilityTargetType, string> = {
    "extraction-field": "No extraction fields linked to this research question yet.",
    "evidence-set": "No evidence sets linked to this research question yet.",
    "synthesis-statement": "No synthesis statements linked to this research question yet.",
    claim: "No claims linked to this research question yet.",
  };

  return <section className="card section-card full">
    <div className="section-heading"><h2>{heading[targetType]}</h2><span className="count">{linkedCount} linked</span></div>
    {targetType === "extraction-field" && <p className="hint" style={{ marginBottom: 18 }}>Fields are linked to the question as planning context. Per-Paper coverage is available on each exact Field page.</p>}
    {page.items.length === 0 ? <div className="empty">{emptyText[targetType]}</div> : <div className="item-list">{page.items.map(renderRow)}</div>}
    {error && <div className="curation-warning-box" role="alert">Question traceability changed, or the page could not be loaded. {error} Use Refresh to start a new traversal.</div>}
    <div className="inline-form" style={{ justifyContent: "space-between", marginTop: 12 }}>
      <span className="hint">Showing {page.items.length} of {linkedCount} {countForNoun}. Target summaries are live; a Question link change invalidates continuation and requires Refresh.</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="button ghost" type="button" disabled={busy} onClick={refresh}>Refresh</button>
        <button className="button secondary" type="button" disabled={busy || !page.hasMore} onClick={() => void load(page.nextCursor)}>Next page</button>
      </div>
    </div>
    {!isArchived && <ResearchQuestionLinkPicker projectId={projectId} questionId={questionId} targetType={targetType} />}
  </section>;
}
