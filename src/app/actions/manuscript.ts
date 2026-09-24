"use server";

import { redirect } from "next/navigation";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

const manuscriptServices = reviewServices as typeof reviewServices & {
  createDefaultManuscript: (projectId: string) => Promise<{ id: string }>;
  createSection: (projectId: string, manuscriptId: string, input: { title: string; sectionType?: string }) => Promise<unknown>;
  renameSection: (projectId: string, manuscriptId: string, sectionId: string, title: string) => Promise<unknown>;
  reorderSections: (projectId: string, manuscriptId: string, ids: string[]) => Promise<unknown>;
  archiveSection: (projectId: string, manuscriptId: string, sectionId: string) => Promise<unknown>;
  placeClaimRevision: (projectId: string, manuscriptId: string, sectionId: string, revisionId: string, position?: number) => Promise<unknown>;
  replacePlacedClaimRevision: (projectId: string, manuscriptId: string, placementId: string, revisionId: string, expected?: string) => Promise<unknown>;
  removeClaimPlacement: (projectId: string, manuscriptId: string, placementId: string) => Promise<unknown>;
  createProseBlock: (projectId: string, manuscriptId: string, sectionId: string, input: { text: string; position?: number }) => Promise<unknown>;
  reviseProseBlock: (projectId: string, manuscriptId: string, proseBlockId: string, input: { text: string; expectedCurrentRevisionId: string }) => Promise<unknown>;
  updateProseBlock: (projectId: string, manuscriptId: string, proseBlockId: string, input: { text: string; expectedCurrentRevisionId: string }) => Promise<unknown>;
  removeProseBlock: (projectId: string, manuscriptId: string, proseBlockId: string) => Promise<unknown>;
  reorderSectionItems: (projectId: string, manuscriptId: string, sectionId: string, ids: string[]) => Promise<unknown>;
};

const manuscriptReviewServices = reviewServices as typeof reviewServices & {
  openManuscriptReviewThread: (projectId: string, manuscriptId: string, input: { sectionItemId: string; title: string; initialComment: string }) => Promise<unknown>;
  commentOnManuscriptReviewThread: (projectId: string, manuscriptId: string, threadId: string, body: string) => Promise<unknown>;
  resolveManuscriptReviewThread: (projectId: string, manuscriptId: string, threadId: string, note?: string | null) => Promise<unknown>;
  reopenManuscriptReviewThread: (projectId: string, manuscriptId: string, threadId: string, note?: string | null) => Promise<unknown>;
};

const manuscriptSnapshotServices = reviewServices as typeof reviewServices & {
  createManuscriptSnapshot: (projectId: string, manuscriptId: string) => Promise<{ id: string }>;
};

function many(form: FormData, key: string) { return form.getAll(key).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()); }

export async function createDefaultManuscriptAction(form: FormData) {
  const projectId = text(form, "projectId");
  let manuscript: { id: string };
  try { manuscript = await manuscriptServices.createDefaultManuscript(projectId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?created=${encodeURIComponent(manuscript.id)}`);
}

export async function createManuscriptSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  try { await manuscriptServices.createSection(projectId, manuscriptId, { title: text(form, "title"), sectionType: optional(form, "sectionType") }); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=section`);
}

export async function renameManuscriptSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  try { await manuscriptServices.renameSection(projectId, manuscriptId, sectionId, text(form, "title")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=section`);
}

export async function reorderManuscriptSectionsAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  try { await manuscriptServices.reorderSections(projectId, manuscriptId, many(form, "sectionIds")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=reordered`);
}

export async function archiveManuscriptSectionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  try { await manuscriptServices.archiveSection(projectId, manuscriptId, sectionId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=archived`);
}

export async function placeClaimRevisionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  const rawPosition = text(form, "position");
  const position = rawPosition === "" ? undefined : Number(rawPosition);
  try { await manuscriptServices.placeClaimRevision(projectId, manuscriptId, sectionId, text(form, "claimRevisionId"), position); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=placed`);
}

export async function replacePlacedClaimRevisionAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const placementId = text(form, "placementId");
  try { await manuscriptServices.replacePlacedClaimRevision(projectId, manuscriptId, placementId, text(form, "claimRevisionId"), optional(form, "expectedCurrentClaimRevisionId")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=replaced`);
}

export async function removeClaimPlacementAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const placementId = text(form, "placementId");
  try { await manuscriptServices.removeClaimPlacement(projectId, manuscriptId, placementId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=removed`);
}

export async function createManuscriptProseBlockAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  const rawPosition = text(form, "position");
  const position = rawPosition === "" ? undefined : Number(rawPosition);
  try { await manuscriptServices.createProseBlock(projectId, manuscriptId, sectionId, { text: verbatimText(form, "text"), position }); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=prose`);
}

export async function updateManuscriptProseBlockAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const proseBlockId = text(form, "proseBlockId");
  const expectedCurrentRevisionId = text(form, "expectedCurrentRevisionId");
  try { await manuscriptServices.reviseProseBlock(projectId, manuscriptId, proseBlockId, { text: verbatimText(form, "text"), expectedCurrentRevisionId }); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=prose`);
}

export async function removeManuscriptProseBlockAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const proseBlockId = text(form, "proseBlockId");
  try { await manuscriptServices.removeProseBlock(projectId, manuscriptId, proseBlockId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=removed-prose`);
}

export async function reorderManuscriptSectionItemsAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const sectionId = text(form, "sectionId");
  try { await manuscriptServices.reorderSectionItems(projectId, manuscriptId, sectionId, many(form, "itemIds")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=reordered`);
}

export async function setManuscriptCitationStyleAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  try { await manuscriptServices.setManuscriptCitationStyle(projectId, manuscriptId, text(form, "citationStyle")); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript?saved=citation-style`);
}

export async function createManuscriptSnapshotAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  let snapshot: { id: string };
  try { snapshot = await manuscriptSnapshotServices.createManuscriptSnapshot(projectId, manuscriptId); }
  catch (error) { fail(`/projects/${projectId}/manuscript`, error); }
  redirect(`/projects/${projectId}/manuscript/snapshots/${encodeURIComponent(snapshot.id)}?manuscriptId=${encodeURIComponent(manuscriptId)}&saved=created`);
}

export async function openManuscriptReviewThreadAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId");
  let thread: { id: string };
  try {
    thread = await manuscriptReviewServices.openManuscriptReviewThread(projectId, manuscriptId, {
      sectionItemId: text(form, "sectionItemId"),
      title: text(form, "title"),
      initialComment: verbatimText(form, "initialComment"),
    }) as { id: string };
  } catch (error) { fail(`/projects/${projectId}/manuscript/review`, error); }
  redirect(`/projects/${projectId}/manuscript/review?thread=${encodeURIComponent(thread.id)}`);
}

export async function commentManuscriptReviewThreadAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const threadId = text(form, "threadId");
  try { await manuscriptReviewServices.commentOnManuscriptReviewThread(projectId, manuscriptId, threadId, verbatimText(form, "body")); }
  catch (error) { fail(`/projects/${projectId}/manuscript/review`, error); }
  redirect(`/projects/${projectId}/manuscript/review?thread=${encodeURIComponent(threadId)}&saved=comment`);
}

export async function resolveManuscriptReviewThreadAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const threadId = text(form, "threadId");
  try { await manuscriptReviewServices.resolveManuscriptReviewThread(projectId, manuscriptId, threadId, optional(form, "note") ?? null); }
  catch (error) { fail(`/projects/${projectId}/manuscript/review`, error); }
  redirect(`/projects/${projectId}/manuscript/review?thread=${encodeURIComponent(threadId)}&saved=resolved`);
}

export async function reopenManuscriptReviewThreadAction(form: FormData) {
  const projectId = text(form, "projectId"); const manuscriptId = text(form, "manuscriptId"); const threadId = text(form, "threadId");
  try { await manuscriptReviewServices.reopenManuscriptReviewThread(projectId, manuscriptId, threadId, optional(form, "note") ?? null); }
  catch (error) { fail(`/projects/${projectId}/manuscript/review`, error); }
  redirect(`/projects/${projectId}/manuscript/review?thread=${encodeURIComponent(threadId)}&saved=reopened`);
}
