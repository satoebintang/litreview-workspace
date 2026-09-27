"use client";

import type { EvidencePaperOption } from "@/application/evidence-workspace-read-services";
import { PaperPicker } from "../papers/PaperPicker";

export function EvidencePaperPicker({
  projectId,
  fieldName,
  label,
  initialPaperId,
  initialSelectedPaper,
  onSelectionChange,
}: {
  projectId: string;
  fieldName: "paperId" | "capturePaperId";
  label: string;
  initialPaperId?: string;
  initialSelectedPaper: EvidencePaperOption | null;
  onSelectionChange?: (paper: EvidencePaperOption | null, paperId: string) => void;
}) {
  return <PaperPicker
    projectId={projectId}
    pickerKey={fieldName === "paperId" ? "evidence-filter-paper" : "evidence-capture-paper"}
    fieldName={fieldName}
    label={label}
    initialPaperId={initialPaperId}
    initialSelectedPaper={initialSelectedPaper}
    required={fieldName === "capturePaperId"}
    className="evidence-paper-picker"
    onSelectionChange={onSelectionChange}
  />;
}
