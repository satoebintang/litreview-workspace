import type { Database } from "@/db/client";
import { ensureId } from "@/application/review-services/shared";
import {
  decodeScreeningHistoryCursor,
  effectiveScreeningHistoryPageSize,
} from "./screening-history-cursor";
import {
  getFullTextDecisionEvent,
  getFullTextDecisionPage,
  getFullTextDetail,
  getRetrievalDetail,
  getRetrievalEvent,
  getRetrievalPage,
  getScreeningHistoryContext,
  getTitleAbstractDetail,
  getTitleAbstractEvent,
  getTitleAbstractPage,
} from "./screening-history-read-queries";
import type { ReviewTransaction } from "@/application/review-services/shared";
import {
  SCREENING_HISTORY_DEFAULT_PAGE_SIZE,
  type FullTextRetrievalAttemptEvent,
  type FullTextRetrievalHistoryItem,
  type FullTextScreeningDecisionEvent,
  type FullTextScreeningDecisionHistoryItem,
  type ScreeningDecisionEvent,
  type ScreeningDecisionHistoryItem,
  type ScreeningHistoryCursor,
  type ScreeningHistoryPage,
  type ScreeningHistoryPageOptions,
  type ScreeningHistoryPageRead,
  type ScreeningHistoryExactRead,
} from "./screening-history-read-types";

const READ_TRANSACTION = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
type LoadedContext = Awaited<ReturnType<typeof getScreeningHistoryContext>>;

function scopeIds(projectId: string, paperId: string) {
  return { projectId: ensureId(projectId).toLowerCase(), paperId: ensureId(paperId).toLowerCase() };
}

function pageCursor(projectId: string, paperId: string, historyType: ScreeningHistoryCursor["historyType"], options: ScreeningHistoryPageOptions) {
  const pageSize = effectiveScreeningHistoryPageSize(options.pageSize);
  const cursor = decodeScreeningHistoryCursor(options.cursor, { projectId, paperId, historyType, pageSize });
  return { pageSize, cursor };
}

async function readPage<T, C>(
  db: Database,
  projectId: string,
  paperId: string,
  historyType: ScreeningHistoryCursor["historyType"],
  options: ScreeningHistoryPageOptions,
  current: (context: LoadedContext) => C,
  load: (tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null, currentEvent: C) => Promise<ScreeningHistoryPage<T>>,
): Promise<ScreeningHistoryPageRead<T>> {
  const scope = scopeIds(projectId, paperId);
  const { pageSize, cursor } = pageCursor(scope.projectId, scope.paperId, historyType, options);
  return db.transaction(async (tx) => {
    const context = await getScreeningHistoryContext(tx, scope.projectId, scope.paperId, cursor, historyType, false);
    return {
      route: context.route,
      page: await load(tx, scope.projectId, scope.paperId, pageSize, cursor, current(context)),
    };
  }, READ_TRANSACTION);
}

async function readExact<T>(
  db: Database,
  projectId: string,
  paperId: string,
  eventId: string,
  load: (tx: ReviewTransaction, projectId: string, paperId: string, eventId: string) => Promise<T>,
): Promise<ScreeningHistoryExactRead<T>> {
  const scope = scopeIds(projectId, paperId);
  const exactEventId = ensureId(eventId).toLowerCase();
  return db.transaction(async (tx) => {
    const context = await getScreeningHistoryContext(tx, scope.projectId, scope.paperId, null, "exact", false);
    return { route: context.route, event: await load(tx, scope.projectId, scope.paperId, exactEventId) };
  }, READ_TRANSACTION);
}

export function createScreeningHistoryReadServices(db: Database) {
  return {
    async getTitleAbstractScreeningDetail(projectId: string, paperId: string) {
      const scope = scopeIds(projectId, paperId);
      return db.transaction((tx) => getTitleAbstractDetail(tx, scope.projectId, scope.paperId, SCREENING_HISTORY_DEFAULT_PAGE_SIZE), READ_TRANSACTION);
    },

    async getFullTextScreeningDetail(projectId: string, paperId: string) {
      const scope = scopeIds(projectId, paperId);
      return db.transaction((tx) => getFullTextDetail(tx, scope.projectId, scope.paperId, SCREENING_HISTORY_DEFAULT_PAGE_SIZE), READ_TRANSACTION);
    },

    async getFullTextRetrievalDetail(projectId: string, paperId: string) {
      const scope = scopeIds(projectId, paperId);
      return db.transaction((tx) => getRetrievalDetail(tx, scope.projectId, scope.paperId, SCREENING_HISTORY_DEFAULT_PAGE_SIZE), READ_TRANSACTION);
    },

    getScreeningDecisionHistoryPage(projectId: string, paperId: string, options: ScreeningHistoryPageOptions = {}) {
      return readPage<ScreeningDecisionHistoryItem, LoadedContext["titleAbstractCurrent"]>(
        db, projectId, paperId, "title-abstract-decision", options,
        (context) => context.titleAbstractCurrent,
        getTitleAbstractPage,
      );
    },

    getFullTextScreeningDecisionHistoryPage(projectId: string, paperId: string, options: ScreeningHistoryPageOptions = {}) {
      return readPage<FullTextScreeningDecisionHistoryItem, LoadedContext["fullTextCurrent"]>(
        db, projectId, paperId, "full-text-decision", options,
        (context) => context.fullTextCurrent,
        getFullTextDecisionPage,
      );
    },

    getFullTextRetrievalAttemptHistoryPage(projectId: string, paperId: string, options: ScreeningHistoryPageOptions = {}) {
      return readPage<FullTextRetrievalHistoryItem, LoadedContext["retrievalCurrent"]>(
        db, projectId, paperId, "full-text-retrieval-attempt", options,
        (context) => context.retrievalCurrent,
        getRetrievalPage,
      );
    },

    getScreeningDecisionEvent(projectId: string, paperId: string, decisionId: string) {
      return readExact<ScreeningDecisionEvent>(db, projectId, paperId, decisionId, getTitleAbstractEvent);
    },

    getFullTextScreeningDecisionEvent(projectId: string, paperId: string, decisionId: string) {
      return readExact<FullTextScreeningDecisionEvent>(db, projectId, paperId, decisionId, getFullTextDecisionEvent);
    },

    getFullTextRetrievalAttemptEvent(projectId: string, paperId: string, attemptId: string) {
      return readExact<FullTextRetrievalAttemptEvent>(db, projectId, paperId, attemptId, getRetrievalEvent);
    },
  };
}

export type ScreeningHistoryReadServices = ReturnType<typeof createScreeningHistoryReadServices>;
