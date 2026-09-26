"use client";

import { useEffect, useState } from "react";
import { recordEvidenceAction } from "@/app/actions/documents-evidence";
import type { EvidencePaperOption } from "@/application/evidence-workspace-read-services";
import { EvidencePaperPicker } from "./EvidencePaperPicker";

type PaperPage = {
  items: EvidencePaperOption[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

export function EvidenceCaptureForm({
  projectId,
  capturePaperId,
  selectedPaper,
  papers,
}: {
  projectId: string;
  capturePaperId?: string;
  selectedPaper: EvidencePaperOption | null;
  papers: PaperPage;
}) {
  const selectedIsValid = Boolean(capturePaperId && selectedPaper?.id === capturePaperId);
  const [canSubmit, setCanSubmit] = useState(selectedIsValid);

  useEffect(() => {
    setCanSubmit(Boolean(capturePaperId && selectedPaper?.id === capturePaperId));
  }, [capturePaperId, selectedPaper?.id]);

  return <form action={recordEvidenceAction}>
    <input type="hidden" name="projectId" value={projectId} />
    <EvidencePaperPicker
      projectId={projectId}
      fieldName="capturePaperId"
      label="manual Evidence capture"
      initialPaperId={capturePaperId}
      initialSelectedPaper={selectedPaper}
      initialPage={papers}
      onSelectionChange={(paper) => setCanSubmit(Boolean(paper))}
    />
    <div className="field"><label htmlFor="source-text">Verbatim source passage</label><textarea id="source-text" name="sourceText" required placeholder="Copy the exact passage that supports your work" /></div>
    <div className="field"><label htmlFor="page-number">Page number</label><input id="page-number" name="pageNumber" required type="number" min="1" placeholder="12" /></div>
    <div className="field"><label htmlFor="evidence-note">Researcher note <span className="hint">optional · not source text</span></label><textarea id="evidence-note" name="note" placeholder="Your context or interpretation" /></div>
    <button className="button" type="submit" disabled={!canSubmit}>Record evidence</button>
    {!canSubmit && <p className="hint">Select a Paper in this Project before recording Evidence.</p>}
  </form>;
}
