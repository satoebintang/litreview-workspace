"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

// Slice 9 acquisition actions intentionally stay thin: validation, project
// ownership, and immutable history are owned by reviewServices.
export async function createResearchQuestionAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createResearchQuestion(projectId, { identifier: text(form, "identifier"), label: text(form, "label") }); }
  catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=question`);
}

export async function createSearchSourceAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createSearchSource(projectId, { sourceKey: text(form, "sourceKey"), displayName: text(form, "displayName"), baseUrl: optional(form, "baseUrl"), notes: optional(form, "notes") }); }
  catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=source`);
}

export async function createSearchStrategyAction(form: FormData) {
  const projectId = text(form, "projectId");
  try { await reviewServices.createSearchStrategy(projectId, { searchSourceId: text(form, "searchSourceId"), name: text(form, "name"), queryText: verbatimText(form, "queryText"), filtersText: optional(form, "filtersText"), notes: optional(form, "notes") }); }
  catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=strategy`);
}

export async function createSearchRunAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    await reviewServices.createSearchRun(projectId, {
      searchSourceId: text(form, "searchSourceId"), sourceKeySnapshot: text(form, "sourceKeySnapshot"), sourceDisplayNameSnapshot: text(form, "sourceDisplayNameSnapshot"), strategyId: text(form, "strategyId"),
      queryText: verbatimText(form, "queryText"), filtersTextSnapshot: optional(form, "filtersTextSnapshot"), reportedResultCount: Number(text(form, "reportedResultCount")), executedAt: text(form, "executedAt"), notes: optional(form, "notes"),
    });
  } catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=run`);
}

export async function createRetrievedRecordAction(form: FormData) {
  const projectId = text(form, "projectId");
  try {
    const authorText = text(form, "authors");
    await reviewServices.createRetrievedRecord(projectId, {
      searchRunId: text(form, "searchRunId"), searchSourceId: text(form, "searchSourceId"), sourceRecordId: optional(form, "sourceRecordId"), title: text(form, "title"),
      authors: authorText ? authorText.split(",").map((author) => author.trim()).filter(Boolean) : [], abstract: optional(form, "abstract"), doi: optional(form, "doi"), url: optional(form, "url"), publicationYear: text(form, "publicationYear") ? Number(text(form, "publicationYear")) : undefined,
      venue: optional(form, "venue"), rawCitation: optional(form, "rawCitation"), retrievedAt: text(form, "retrievedAt") || new Date().toISOString(),
    });
  } catch (error) { fail(`/projects/${projectId}/protocol`, error); }
  redirect(`/projects/${projectId}/protocol?saved=record`);
}

export async function createPaperFromRetrievedRecordAction(form: FormData) {
  const projectId = text(form, "projectId"); const recordId = text(form, "recordId");
  let result;
  try { result = await reviewServices.createPaperFromRetrievedRecord(projectId, recordId, { title: optional(form, "title"), bibliographicNote: optional(form, "bibliographicNote") }); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${text(form, "runId")}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${text(form, "runId")}?saved=paper&paperId=${encodeURIComponent(result.paper.id)}`);
}

export async function linkRetrievedRecordToPaperAction(form: FormData) {
  const projectId = text(form, "projectId"); const runId = text(form, "runId");
  try { await reviewServices.linkRetrievedRecordToPaper(projectId, text(form, "recordId"), text(form, "paperId")); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${runId}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${runId}?saved=linked`);
}

export async function unlinkRetrievedRecordFromPaperAction(form: FormData) {
  const projectId = text(form, "projectId"); const runId = text(form, "runId");
  try { await reviewServices.unlinkRetrievedRecordFromPaper(projectId, text(form, "recordId"), text(form, "paperId")); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${runId}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${runId}?saved=unlinked`);
}

export async function relinkRetrievedRecordAction(form: FormData) {
  const projectId = text(form, "projectId"); const runId = text(form, "runId");
  try { await reviewServices.relinkRetrievedRecord(projectId, text(form, "recordId"), text(form, "fromPaperId"), text(form, "toPaperId")); }
  catch (error) { fail(`/projects/${projectId}/protocol/runs/${runId}`, error); }
  redirect(`/projects/${projectId}/protocol/runs/${runId}?saved=relinked`);
}

function deduplicationPairPath(projectId: string, leftRecordId: string, rightRecordId: string) {
  return `/projects/${projectId}/deduplication/${encodeURIComponent(leftRecordId)}/${encodeURIComponent(rightRecordId)}`;
}

export async function confirmSameWorkAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  try {
    await reviewServices.confirmSameWork(projectId, leftRecordId, rightRecordId, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=same_work`);
}

export async function confirmSameWorkAndResolveAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  const resolutionType = text(form, "resolutionType");
  const resolution = resolutionType === "existing"
    ? { paperId: text(form, "paperId") }
    : { createFromRecordId: text(form, "createFromRecordId"), overrides: { title: optional(form, "title") } };
  try {
    await reviewServices.confirmSameWorkAndResolve(projectId, leftRecordId, rightRecordId, resolution, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=same_work_resolved`);
}

export async function decideDifferentWorkAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  try {
    await reviewServices.decideDifferentWork(projectId, leftRecordId, rightRecordId, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=different_work`);
}

export async function correctDifferentWorkAndResolveAction(form: FormData) {
  const projectId = text(form, "projectId");
  const leftRecordId = text(form, "leftRecordId");
  const rightRecordId = text(form, "rightRecordId");
  const path = deduplicationPairPath(projectId, leftRecordId, rightRecordId);
  try {
    await reviewServices.correctDifferentWorkAndResolve(projectId, leftRecordId, rightRecordId, {
      relinkRecordId: text(form, "relinkRecordId"),
      toPaperId: text(form, "toPaperId"),
    }, optional(form, "note"));
  } catch (error) { fail(path, error); }
  redirect(`${path}?saved=different_work_resolved`);
}
