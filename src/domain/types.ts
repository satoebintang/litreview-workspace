export type ProjectId = string;
export type PaperId = string;
export type EvidenceId = string;
export type ClaimId = string;

export type SupportStatus = "supported" | "unsupported";

export interface Project {
  id: ProjectId;
  title: string;
  description: string | null;
  researchQuestion: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Paper {
  id: PaperId;
  projectId: ProjectId;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  abstract: string | null;
  bibliographicNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Evidence {
  id: EvidenceId;
  projectId: ProjectId;
  paperId: PaperId;
  sourceText: string;
  pageNumber: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Claim {
  id: ClaimId;
  projectId: ProjectId;
  claimText: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimEvidenceLink {
  projectId: ProjectId;
  claimId: ClaimId;
  evidenceId: EvidenceId;
  createdAt: Date;
}

export interface EvidenceWithPaper {
  evidence: Evidence;
  paper: Paper;
}

export interface ClaimProvenance {
  claim: Claim;
  supportStatus: SupportStatus;
  evidence: EvidenceWithPaper[];
}
