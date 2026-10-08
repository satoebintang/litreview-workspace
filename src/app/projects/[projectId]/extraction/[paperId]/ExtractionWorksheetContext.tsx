"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ExtractionEvidencePreview } from "@/application/extraction-evidence-selection-read-services";

type BrowseState = {
  open: boolean;
  fieldId: string | null;
  after: string | null;
  pageSize: number;
};

type WorksheetContextValue = {
  selectedByFieldId: Record<string, ExtractionEvidencePreview[]>;
  setFieldSelection: (fieldId: string, supports: ExtractionEvidencePreview[]) => void;
  addFieldSupport: (fieldId: string, support: ExtractionEvidencePreview) => void;
  removeFieldSupport: (fieldId: string, evidenceId: string) => void;
  browse: BrowseState;
  setBrowse: (browse: BrowseState, historyMode?: "push" | "replace" | "none") => void;
};

const ExtractionWorksheetContext = createContext<WorksheetContextValue | null>(null);

export function ExtractionWorksheetProvider({
  fieldIds,
  initialSelectedByFieldId,
  initialBrowse,
  children,
}: {
  fieldIds: string[];
  initialSelectedByFieldId: Record<string, ExtractionEvidencePreview[]>;
  initialBrowse: BrowseState;
  children: ReactNode;
}) {
  const [selectedByFieldId, setSelectedByFieldId] = useState(initialSelectedByFieldId);
  const [browse, setBrowse] = useState(initialBrowse);
  const defaultFieldId = fieldIds[0] ?? null;
  const commitBrowse = useCallback((next: BrowseState, historyMode: "push" | "replace" | "none" = "push") => {
    setBrowse(next);
    if (historyMode === "none" || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next.open && next.fieldId) {
      url.searchParams.set("evidenceField", next.fieldId);
      url.searchParams.set("evidencePageSize", String(next.pageSize));
      if (next.after) url.searchParams.set("evidenceAfter", next.after);
      else url.searchParams.delete("evidenceAfter");
    } else {
      url.searchParams.delete("evidenceField");
      url.searchParams.delete("evidenceAfter");
      url.searchParams.delete("evidencePageSize");
    }
    const method = historyMode === "replace" ? "replaceState" : "pushState";
    window.history[method](window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const restoreBrowseFromLocation = useCallback(() => {
    const url = new URL(window.location.href);
    const hasBrowse = ["evidenceField", "evidenceAfter", "evidencePageSize"].some((name) => url.searchParams.has(name));
    if (!hasBrowse) {
      setBrowse({ open: false, fieldId: defaultFieldId, after: null, pageSize: 20 });
      return;
    }
    const requestedFieldId = url.searchParams.get("evidenceField");
    const fieldId = requestedFieldId && fieldIds.includes(requestedFieldId) ? requestedFieldId : defaultFieldId;
    const requestedPageSize = url.searchParams.get("evidencePageSize");
    const parsedPageSize = requestedPageSize && /^\d+$/.test(requestedPageSize) ? Number(requestedPageSize) : 20;
    const validPageSize = Number.isSafeInteger(parsedPageSize) && parsedPageSize >= 1 && parsedPageSize <= 50;
    const pageSize = validPageSize ? parsedPageSize : 20;
    const invalidField = !requestedFieldId || !fieldIds.includes(requestedFieldId);
    const invalidBrowseShape = invalidField || !validPageSize;
    const next: BrowseState = {
      open: fieldId !== null,
      fieldId,
      after: invalidBrowseShape ? null : url.searchParams.get("evidenceAfter"),
      pageSize,
    };
    if (invalidBrowseShape) {
      setBrowse(next);
      const repaired = new URL(window.location.href);
      repaired.searchParams.set("evidenceField", fieldId ?? "");
      repaired.searchParams.set("evidencePageSize", String(pageSize));
      repaired.searchParams.delete("evidenceAfter");
      window.history.replaceState(window.history.state, "", `${repaired.pathname}${repaired.search}${repaired.hash}`);
      return;
    }
    setBrowse(next);
  }, [defaultFieldId, fieldIds]);
  useEffect(() => {
    window.addEventListener("popstate", restoreBrowseFromLocation);
    return () => window.removeEventListener("popstate", restoreBrowseFromLocation);
  }, [restoreBrowseFromLocation]);
  const setFieldSelection = useCallback((fieldId: string, supports: ExtractionEvidencePreview[]) => {
    setSelectedByFieldId((current) => ({ ...current, [fieldId]: supports }));
  }, []);
  const addFieldSupport = useCallback((fieldId: string, support: ExtractionEvidencePreview) => {
    setSelectedByFieldId((current) => {
      const currentSupports = current[fieldId] ?? [];
      if (currentSupports.some((item) => item.id.toLowerCase() === support.id.toLowerCase())) return current;
      return { ...current, [fieldId]: [...currentSupports, support] };
    });
  }, []);
  const removeFieldSupport = useCallback((fieldId: string, evidenceId: string) => {
    setSelectedByFieldId((current) => ({
      ...current,
      [fieldId]: (current[fieldId] ?? []).filter((item) => item.id.toLowerCase() !== evidenceId.toLowerCase()),
    }));
  }, []);
  const value = useMemo(() => ({ selectedByFieldId, setFieldSelection, addFieldSupport, removeFieldSupport, browse, setBrowse: commitBrowse }), [
    selectedByFieldId,
    setFieldSelection,
    addFieldSupport,
    removeFieldSupport,
    browse,
    commitBrowse,
  ]);
  useEffect(() => {
    if (initialBrowse.open) commitBrowse(initialBrowse, "replace");
  }, [initialBrowse, commitBrowse]);
  return <ExtractionWorksheetContext.Provider value={value}>{children}</ExtractionWorksheetContext.Provider>;
}

export function useExtractionWorksheet() {
  const value = useContext(ExtractionWorksheetContext);
  if (!value) throw new Error("Extraction worksheet context is unavailable");
  return value;
}
