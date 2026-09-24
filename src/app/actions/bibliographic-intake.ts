"use server";

import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "../server";
import { fail, optional, text, verbatimText } from "../action-helpers";

type BibliographicActionServices = {
  importFile: (projectId: string, input: { format: "bibtex" | "ris"; filename: string; bytes: Uint8Array }) => Promise<{ id: string }>;
  resolveImportRecord: (input: { projectId: string; importRecordId: string; action: "created_paper" | "matched_paper" | "cleared"; paperId?: string | null; expectedResolutionId?: string | null; note?: string | null; creation?: Record<string, unknown>; distinctPaperAcknowledged?: boolean }) => Promise<unknown>;
  bulkCreateImportRecords: (input: { projectId: string; importId: string; selection: Array<{ recordId: string; expectedResolutionId: string | null; fingerprint: string }> }) => Promise<unknown>;
};

function bibliographicActions(): BibliographicActionServices {
  const services = reviewServices as typeof reviewServices & Partial<BibliographicActionServices>;
  if (!services.importFile || !services.resolveImportRecord || !services.bulkCreateImportRecords) throw new DomainError("VALIDATION_ERROR", "Bibliographic import is not configured");
  return services as typeof services & BibliographicActionServices;
}

export async function uploadBibliographicImportAction(form: FormData) {
  const projectId = text(form, "projectId");
  const file = form.get("file");
  const format = text(form, "format").toLowerCase();
  if (!(file instanceof File) || !file.size) return fail(`/projects/${projectId}/papers/imports/upload`, new DomainError("VALIDATION_ERROR", "Choose a BibTeX or RIS file"));
  if (format !== "bibtex" && format !== "ris") return fail(`/projects/${projectId}/papers/imports/upload`, new DomainError("VALIDATION_ERROR", "Choose BibTeX or RIS format"));
  let imported: { id: string };
  try { imported = await bibliographicActions().importFile(projectId, { format, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }
  catch (error) { fail(`/projects/${projectId}/papers/imports/upload`, error); }
  redirect(`/projects/${projectId}/papers/imports/${imported.id}`);
}

export async function resolveBibliographicImportRecordAction(form: FormData) {
  const projectId = text(form, "projectId");
  const importId = text(form, "importId");
  const recordId = text(form, "recordId");
  const action = text(form, "resolutionAction") as "created_paper" | "matched_paper" | "cleared";
  try {
    await bibliographicActions().resolveImportRecord({
      projectId,
      importRecordId: recordId,
      action,
      paperId: optional(form, "paperId") ?? null,
      expectedResolutionId: optional(form, "expectedResolutionId") ?? null,
      note: optional(form, "note") ?? null,
      distinctPaperAcknowledged: form.get("distinctPaperAcknowledged") === "on",
      creation: {
        title: text(form, "title"),
        authors: form.getAll("authors").map(String).map((value) => value.trim()).filter(Boolean),
        publicationYear: optional(form, "publicationYear") ? Number(text(form, "publicationYear")) : null,
        venue: optional(form, "venue") ?? null,
        doi: optional(form, "doi") ?? null,
        abstract: optional(form, "abstract") ?? null,
        bibliographicNote: optional(form, "bibliographicNote") ?? null,
      },
    });
  } catch (error) { fail(`/projects/${projectId}/papers/imports/${importId}`, error); }
  redirect(`/projects/${projectId}/papers/imports/${importId}?saved=resolution`);
}

export async function bulkCreateBibliographicImportRecordsAction(form: FormData) {
  const projectId = text(form, "projectId");
  const importId = text(form, "importId");
  let selection: unknown;
  try { selection = JSON.parse(verbatimText(form, "selection")); }
  catch { return fail(`/projects/${projectId}/papers/imports/${importId}`, new DomainError("VALIDATION_ERROR", "Bulk selection is invalid")); }
  try {
    await bibliographicActions().bulkCreateImportRecords({ projectId, importId, selection: selection as Array<{ recordId: string; expectedResolutionId: string | null; fingerprint: string }> });
  } catch (error) { fail(`/projects/${projectId}/papers/imports/${importId}`, error); }
  redirect(`/projects/${projectId}/papers/imports/${importId}?saved=bulk-created`);
}
