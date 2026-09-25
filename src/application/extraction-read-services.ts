import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { extractionFields, extractionOptions } from "@/db/schema";
import { ensureId } from "@/application/review-services/shared";
import { EvidenceRepository, PaperRepository, PaperReviewRepository } from "@/application/repositories";
import { createExtractionProgressReadServices } from "@/application/extraction-progress-read-services";
import { createExtractionWorksheetReadServices } from "@/application/extraction-worksheet-read-services";

export type ExtractionProtocolField = typeof extractionFields.$inferSelect & {
  options: Array<typeof extractionOptions.$inferSelect>;
};

/**
 * Project Extraction reads. Protocol definitions are loaded with two queries,
 * while progress and worksheet projections keep their own bounded read paths.
 */
export function createExtractionReadServices(db: Database) {
  const paperRepo = new PaperRepository(db);
  const paperReviewRepo = new PaperReviewRepository(db);
  const evidenceRepo = new EvidenceRepository(db);
  const progressReads = createExtractionProgressReadServices(db);
  const worksheetReads = createExtractionWorksheetReadServices(db, {
    paperRepo,
    paperReviewRepo,
    evidenceRepo,
  });

  return {
    ...progressReads,
    ...worksheetReads,

    async getExtractionProtocol(projectId: string): Promise<{ fields: ExtractionProtocolField[] }> {
      ensureId(projectId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '15000ms'`);
        const fields = await tx.select().from(extractionFields)
          .where(eq(extractionFields.projectId, projectId))
          .orderBy(asc(extractionFields.sortOrder), asc(extractionFields.id));
        const options = await tx.select().from(extractionOptions)
          .where(and(
            eq(extractionOptions.projectId, projectId),
            inArray(extractionOptions.fieldId, fields.map((field) => field.id)),
          ))
          .orderBy(asc(extractionOptions.fieldId), asc(extractionOptions.sortOrder), asc(extractionOptions.id));
        const optionsByFieldId = new Map<string, typeof options>();
        for (const option of options) {
          optionsByFieldId.set(option.fieldId, [...(optionsByFieldId.get(option.fieldId) ?? []), option]);
        }
        return { fields: fields.map((field) => ({ ...field, options: optionsByFieldId.get(field.id) ?? [] })) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}

export type ExtractionReadServices = ReturnType<typeof createExtractionReadServices>;
