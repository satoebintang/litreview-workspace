import { reviewServices } from "@/app/server";

export type ClaimLifecycle = "active" | "withdrawn";
export type ClaimSupportKind = "evidence" | "extraction" | "synthesis";

export interface PaperView { id: string; title: string; doi?: string | null; authors?: string[]; publicationYear?: number | null; venue?: string | null; }
export interface EvidenceView { id: string; sourceText: string; pageNumber: number; note?: string | null; paper?: PaperView; }
export interface ExtractionView { id: string; sequence?: number; valueState?: string; textValue?: string | null; numberValue?: string | null; booleanValue?: boolean | null; optionId?: string | null; researcherNote?: string | null; evidence: EvidenceView[]; paper?: PaperView; field?: { id: string; name: string }; isCurrent?: boolean; paperScreeningState?: string; }
export interface SynthesisView { id: string; sequence?: number; state?: ClaimLifecycle; title?: string | null; statementText?: string | null; researcherNote?: string | null; evidence: EvidenceView[]; extractions: ExtractionView[]; paperCount?: number; isCurrent?: boolean; }
export interface ClaimSupportView { kind: ClaimSupportKind; id: string; evidence?: EvidenceView; extraction?: ExtractionView; synthesis?: SynthesisView; paper?: PaperView; }
export interface CitationCandidateView { paper: PaperView; pathCount: number; paths?: Array<{ kind?: ClaimSupportKind; label?: string } | string>; }
export interface ClaimRevisionView { id: string; sequence: number; state: ClaimLifecycle; claimText: string | null; researcherNote?: string | null; finalizedAt?: string | null; supports: { evidence: ClaimSupportView[]; extraction: ClaimSupportView[]; synthesis: ClaimSupportView[] }; supportStatus: "supported" | "unsupported"; citationCandidates: CitationCandidateView[]; distinctPaperCount: number; citationCandidateCount: number; }
export interface ClaimView { id: string; createdAt?: string; currentRevision: ClaimRevisionView; }

export interface ClaimReadServices {
  listCurrentClaims?: (projectId: string) => Promise<unknown>;
  listClaims?: (projectId: string) => Promise<unknown>;
  getCurrentClaim?: (projectId: string, claimId: string) => Promise<unknown>;
  getClaimProvenance?: (projectId: string, claimId: string) => Promise<unknown>;
  getClaimHistory?: (projectId: string, claimId: string) => Promise<unknown>;
  listEvidence?: (projectId: string) => Promise<unknown>;
  listPapers?: (projectId: string) => Promise<unknown>;
  listExtractionComparison?: (projectId: string, fieldId?: string) => Promise<unknown>;
  listProjectSynthesis?: (projectId: string) => Promise<unknown>;
  listClaimSupportOptions?: (projectId: string) => Promise<unknown>;
  listProjectExtractionRevisions?: (projectId: string) => Promise<unknown>;
  listProjectSynthesisRevisions?: (projectId: string) => Promise<unknown>;
}

export const claimReadServices = reviewServices as unknown as ClaimReadServices;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function string(value: unknown, fallback = "") { return typeof value === "string" ? value : fallback; }
function number(value: unknown, fallback = 0) { return typeof value === "number" ? value : fallback; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function paper(value: unknown): PaperView | undefined {
  const row = object(value);
  if (!row.id) return undefined;
  return { id: string(row.id), title: string(row.title, "Untitled paper"), doi: typeof row.doi === "string" ? row.doi : null, authors: Array.isArray(row.authors) ? row.authors.filter((item): item is string => typeof item === "string") : [], publicationYear: typeof row.publicationYear === "number" ? row.publicationYear : null, venue: typeof row.venue === "string" ? row.venue : null };
}

function evidence(value: unknown, fallbackPaper?: PaperView): EvidenceView {
  const row = object(value);
  const nested = object(row.evidence);
  const source = nested.sourceText !== undefined ? nested : row;
  return { id: string(source.id), sourceText: string(source.sourceText), pageNumber: number(source.pageNumber), note: typeof source.note === "string" ? source.note : null, paper: paper(row.paper) ?? paper(source.paper) ?? fallbackPaper };
}

export function normalizeExtraction(value: unknown, fallbackPaper?: PaperView): ExtractionView {
  const row = object(value);
  const extractionEvidence = array(row.evidence ?? row.supportingEvidence).map((item) => evidence(item, fallbackPaper));
  return { id: string(row.id ?? row.revisionId), sequence: number(row.sequence), valueState: string(row.valueState ?? row.state), textValue: typeof row.textValue === "string" ? row.textValue : null, numberValue: typeof row.numberValue === "string" ? row.numberValue : null, booleanValue: typeof row.booleanValue === "boolean" ? row.booleanValue : null, optionId: typeof row.optionId === "string" ? row.optionId : null, researcherNote: typeof row.researcherNote === "string" ? row.researcherNote : null, evidence: extractionEvidence, paper: paper(row.paper) ?? fallbackPaper, field: object(row.field).id ? { id: string(object(row.field).id), name: string(object(row.field).name, "Extraction field") } : undefined, isCurrent: Boolean(row.isCurrentExtractionRevision ?? row.isCurrent), paperScreeningState: typeof row.paperScreeningState === "string" ? row.paperScreeningState : typeof row.screeningState === "string" ? row.screeningState : undefined };
}

function support(value: unknown, kind: ClaimSupportKind): ClaimSupportView {
  const row = object(value);
  const rowPaper = paper(row.paper);
  const target = kind === "evidence" ? evidence(row.evidence ?? row, rowPaper) : kind === "extraction" ? normalizeExtraction(row.extractionRevision ?? row.extraction ?? row, rowPaper) : normalizeSynthesis(row.synthesisRevision ?? row.synthesis ?? row);
  if (kind === "evidence") return { kind, id: string(row.evidenceId ?? object(row.evidence).id ?? row.id), evidence: target as EvidenceView, paper: rowPaper ?? (target as EvidenceView).paper };
  if (kind === "extraction") { const result = target as ExtractionView; result.isCurrent = Boolean(row.isCurrentExtractionRevision ?? row.isCurrent ?? result.isCurrent); if (!result.field && object(row.field).id) result.field = { id: string(object(row.field).id), name: string(object(row.field).name, "Extraction field") }; return { kind, id: string(row.extractionRevisionId ?? object(row.extractionRevision).id ?? object(row.extraction).id ?? row.id), extraction: result, paper: rowPaper ?? result.paper }; }
  const synthesisTarget = target as SynthesisView;
  synthesisTarget.isCurrent = Boolean(row.isCurrentSynthesisRevision ?? row.isCurrent ?? synthesisTarget.isCurrent);
  return { kind, id: string(row.synthesisRevisionId ?? object(row.synthesisRevision).id ?? object(row.synthesis).id ?? row.id), synthesis: synthesisTarget };
}

export function normalizeSynthesis(value: unknown): SynthesisView {
  const row = object(value);
  const nested = array(row.supports ?? row.extractions ?? row.extractionRevisions).map((item) => {
    const supportRow = object(item);
    return normalizeExtraction(supportRow.extractionRevision ?? supportRow.extraction ?? supportRow, paper(supportRow.paper));
  });
  const evidenceRows = nested.flatMap((item) => item.evidence);
  return { id: string(row.id ?? row.revisionId), sequence: number(row.sequence), state: string(row.state, "active") as ClaimLifecycle, title: typeof row.title === "string" ? row.title : null, statementText: typeof row.statementText === "string" ? row.statementText : null, researcherNote: typeof row.researcherNote === "string" ? row.researcherNote : null, evidence: evidenceRows, extractions: nested, paperCount: number(row.supportingPaperCount), isCurrent: Boolean(row.isCurrentSynthesisRevision ?? row.isCurrent) };
}

function supportGroups(value: unknown): ClaimRevisionView["supports"] {
  const row = object(value);
  const raw = value && !Array.isArray(value) ? row : {};
  const groups = {
    evidence: array(raw.evidence ?? raw.evidenceSupports),
    extraction: array(raw.extraction ?? raw.extractions ?? raw.extractionRevisions ?? raw.extractionSupports),
    synthesis: array(raw.synthesis ?? raw.syntheses ?? raw.synthesisRevisions ?? raw.synthesisSupports),
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const rawKind = string(object(item).supportType ?? object(item).kind);
      const kind = (rawKind === "extractionRevision" ? "extraction" : rawKind === "synthesisRevision" ? "synthesis" : rawKind) as ClaimSupportKind;
      if (kind in groups) groups[kind].push(item);
    }
  }
  return { evidence: groups.evidence.map((item) => support(item, "evidence")), extraction: groups.extraction.map((item) => support(item, "extraction")), synthesis: groups.synthesis.map((item) => support(item, "synthesis")) };
}

function revision(value: unknown): ClaimRevisionView {
  const row = object(value);
  const claim = object(row.claim);
  const rawSupportValue = row.supports ?? row.support ?? (row.evidence ? { evidence: row.evidence } : []);
  const groups = supportGroups(rawSupportValue);
  const total = groups.evidence.length + groups.extraction.length + groups.synthesis.length;
  const candidates = array(row.citationCandidates).map((item) => {
    const candidate = object(item);
    const candidatePaper = paper(candidate.paper) ?? paper(candidate);
    return { paper: candidatePaper ?? { id: string(candidate.paperId), title: string(candidate.paperTitle, "Untitled paper") }, pathCount: number(candidate.pathCount ?? candidate.supportPathCount, 1), paths: Array.isArray(candidate.paths) ? candidate.paths.map((path) => typeof path === "string" ? path : { kind: string(object(path).kind) as ClaimSupportKind, label: string(object(path).label) }) : undefined };
  });
  return { id: string(row.id ?? row.revisionId), sequence: number(row.sequence), state: string(row.lifecycle ?? row.state, "active") as ClaimLifecycle, claimText: typeof row.claimText === "string" ? row.claimText : typeof claim.claimText === "string" ? claim.claimText : null, researcherNote: typeof row.researcherNote === "string" ? row.researcherNote : null, finalizedAt: typeof row.finalizedAt === "string" ? row.finalizedAt : null, supports: groups, supportStatus: string(row.supportStatus, total > 0 ? "supported" : "unsupported") as "supported" | "unsupported", citationCandidates: candidates, distinctPaperCount: number(row.distinctPaperCount ?? row.supportingPaperCount), citationCandidateCount: number(row.citationCandidateCount ?? candidates.length) };
}

export function normalizeClaim(value: unknown): ClaimView {
  const row = object(value);
  const current = row.currentRevision ?? row.revision ?? row.current ?? value;
  return { id: string(row.id ?? object(row.claim).id), createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined, currentRevision: revision(current) };
}

export function normalizeClaims(value: unknown): ClaimView[] { const row = object(value); return array(Array.isArray(value) ? value : row.claims ?? row.items ?? value).map(normalizeClaim); }
export function normalizeHistory(value: unknown): ClaimRevisionView[] { const row = object(value); return array(Array.isArray(value) ? value : row.revisions ?? row.history ?? value).map(revision); }

export function supportCount(view: ClaimRevisionView) { return view.supports.evidence.length + view.supports.extraction.length + view.supports.synthesis.length; }
export function extractionDisplay(value: ExtractionView) { return value.textValue ?? value.numberValue ?? (value.booleanValue === null || value.booleanValue === undefined ? value.optionId : value.booleanValue ? "Yes" : "No") ?? value.valueState ?? "No value"; }
