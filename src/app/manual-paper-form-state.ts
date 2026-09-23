export type ManualPaperDraft = {
  title: string;
  authors: string;
  publicationYear: string;
  venue: string;
  doi: string;
  abstract: string;
  bibliographicNote: string;
};

export type ManualPaperReviewCandidate = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  candidateReason: string;
};

export type ManualPaperActionState = {
  version: string;
  status: "idle" | "reviewed" | "error";
  draft: ManualPaperDraft;
  candidates: ManualPaperReviewCandidate[];
  error: string | null;
};

export const initialManualPaperActionState: ManualPaperActionState = {
  version: "initial",
  status: "idle",
  draft: {
    title: "",
    authors: "",
    publicationYear: "",
    venue: "",
    doi: "",
    abstract: "",
    bibliographicNote: "",
  },
  candidates: [],
  error: null,
};
