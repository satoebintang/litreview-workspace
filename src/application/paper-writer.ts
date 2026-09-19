import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { papers, projects } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { createPaperSchema, idSchema } from "@/domain/validation";
import { isPlausibleDoiForComparison, normalizeDoiForComparison, normalizeTitleForComparison } from "@/domain/search-normalization";

export type PaperWriteTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type PaperWriteInput = {
  title: string;
  authors?: string[];
  publicationYear?: number | null;
  venue?: string | null;
  doi?: string | null;
  abstract?: string | null;
  bibliographicNote?: string | null;
};

export type PaperWriteReviewContext = {
  /** The caller owns candidate discovery and policy. The writer only records
   * a validated canonical Paper inside its transaction. */
  source?: "manual" | "import" | "acquisition" | "dedup" | "pdf_intake";
};

export async function findPaperCandidates(executor: Pick<Database, "execute">, projectId: string, input: Pick<PaperWriteInput, "title" | "doi" | "publicationYear">) {
  const doi = isPlausibleDoiForComparison(input.doi) ? normalizeDoiForComparison(input.doi) : null;
  const title = normalizeTitleForComparison(input.title);
  if (!doi && !title) return [] as Array<Record<string, unknown>>;
  return (await executor.execute(sql`
    select p.*, case
      when ${doi}::text is not null and p.doi is not null and lower(trim(regexp_replace(regexp_replace(trim(p.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))=${doi} then 'doi'
      when ${title}::text is not null and ${input.publicationYear ?? null}::int is not null and lower(regexp_replace(trim(p.title), '[[:space:]]+', ' ', 'g'))=${title} and p.publication_year=${input.publicationYear ?? null} then 'title_year'
      else 'title'
    end as candidate_reason,
    case
      when ${doi}::text is not null and p.doi is not null and lower(trim(regexp_replace(regexp_replace(trim(p.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))=${doi} then 1
      when ${title}::text is not null and ${input.publicationYear ?? null}::int is not null and lower(regexp_replace(trim(p.title), '[[:space:]]+', ' ', 'g'))=${title} and p.publication_year=${input.publicationYear ?? null} then 2
      else 3
    end as candidate_priority
    from papers p where p.project_id=${projectId} and (
      (${doi}::text is not null and p.doi is not null and lower(trim(regexp_replace(regexp_replace(trim(p.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))=${doi})
      or (${title}::text is not null and lower(regexp_replace(trim(p.title), '[[:space:]]+', ' ', 'g'))=${title})
    ) order by candidate_priority, p.created_at,p.id
  `) as unknown as Array<Record<string, unknown>>);
}

function parseId(value: string, label: string): string {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`, result.error.issues);
  return result.data;
}

/**
 * The single canonical Paper insert seam. It is deliberately policy-neutral:
 * candidate discovery, explicit distinct-Paper acknowledgement, and source
 * record locking stay in the caller's workflow. This function validates the
 * final submitted payload and verifies project ownership in the same
 * transaction that inserts the Paper.
 */
export async function writePaper(
  tx: PaperWriteTransaction,
  projectId: string,
  input: PaperWriteInput,
  _reviewContext: PaperWriteReviewContext = {},
) {
  void _reviewContext;
  const checkedProjectId = parseId(projectId, "Project");
  const parsed = createPaperSchema.safeParse({
    title: input.title,
    authors: input.authors ?? [],
    publicationYear: input.publicationYear ?? null,
    venue: input.venue ?? null,
    doi: input.doi ?? null,
    abstract: input.abstract ?? null,
    bibliographicNote: input.bibliographicNote ?? null,
  });
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Paper input failed validation", parsed.error.issues);
  const values = parsed.data;
  const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, checkedProjectId)).limit(1);
  if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
  const [paper] = await tx.insert(papers).values({
    projectId: checkedProjectId,
    title: values.title,
    authors: values.authors,
    publicationYear: values.publicationYear ?? null,
    venue: values.venue ?? null,
    doi: values.doi ?? null,
    abstract: values.abstract ?? null,
    bibliographicNote: values.bibliographicNote ?? null,
  }).returning();
  if (!paper) throw new DomainError("DATABASE_CONSTRAINT", "Paper could not be created");
  return paper;
}

export async function writePaperInTransaction(
  db: Database,
  projectId: string,
  input: PaperWriteInput,
  context?: PaperWriteReviewContext,
) {
  return db.transaction((tx) => writePaper(tx, projectId, input, context));
}

export function samePaperMetadata(left: PaperWriteInput, right: PaperWriteInput): boolean {
  return left.title === right.title
    && JSON.stringify(left.authors ?? []) === JSON.stringify(right.authors ?? [])
    && (left.publicationYear ?? null) === (right.publicationYear ?? null)
    && (left.venue ?? null) === (right.venue ?? null)
    && (left.doi ?? null) === (right.doi ?? null)
    && (left.abstract ?? null) === (right.abstract ?? null)
    && (left.bibliographicNote ?? null) === (right.bibliographicNote ?? null);
}
