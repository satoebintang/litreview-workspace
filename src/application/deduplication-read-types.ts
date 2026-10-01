export type DeduplicationQueueMappingStatus = "unmapped" | "linked" | "unlinked";

export type DeduplicationQueueRecord = {
  id: string;
  title: string;
  authors: string;
  publicationYear: number | null;
  doi: string | null;
  sourceRecordId: string | null;
  currentPaperId: string | null;
  mappingStatus: DeduplicationQueueMappingStatus;
};

export type DeduplicationQueueItem = {
  leftRetrievedRecord: DeduplicationQueueRecord;
  rightRetrievedRecord: DeduplicationQueueRecord;
  reasons: string[];
  strength: "strong" | "possible";
};

export type DeduplicationQueuePage = {
  project: { id: string; title: string };
  items: DeduplicationQueueItem[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type DeduplicationHistoryItem = {
  id: string;
  sequence: string;
  decision: "same_work" | "different_work";
  notePreview: string | null;
  noteTruncated: boolean;
  createdAt: Date;
};

export type DeduplicationHistoryPage = {
  project: { id: string; title: string };
  items: DeduplicationHistoryItem[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type DeduplicationDecisionEvent = {
  id: string;
  sequence: string;
  projectId: string;
  leftRetrievedRecordId: string;
  rightRetrievedRecordId: string;
  decision: "same_work" | "different_work";
  note: string | null;
  createdAt: Date;
};
