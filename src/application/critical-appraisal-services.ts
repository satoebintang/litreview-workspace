import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  appraisalItemInputSchema,
  appraisalItemUpdateSchema,
  appraisalOverallOptionsSchema,
  appraisalItemRemovalSchema,
  appraisalReorderSchema,
  appraisalResponseOptionInputSchema,
  appraisalResponseOptionRemovalSchema,
  appraisalResponseOptionUpdateSchema,
  appraisalSectionRemovalSchema,
  appraisalSectionInputSchema,
  appraisalSectionUpdateSchema,
  createAppraisalFrameworkSchema,
  saveAppraisalRevisionSchema,
  updateFrameworkDraftMetadataSchema,
  type SaveAppraisalRevisionInput,
} from "@/domain/validation";

type Row = Record<string, unknown>;
type Executor = Pick<Database, "execute">;

type Dependencies = {
  requireProject: (projectId: string) => Promise<unknown>;
  requirePaper: (projectId: string, paperId: string) => Promise<unknown>;
  requireEvidence: (projectId: string, evidenceId: string) => Promise<unknown>;
};

export type AppraisalFramework = {
  id: string;
  projectId: string;
  name: string;
  createdAt: Date;
  archivedAt: Date | null;
};

export type AppraisalFrameworkVersion = {
  id: string;
  projectId: string;
  frameworkId: string;
  versionNumber: number;
  versionLabel: string;
  description: string | null;
  citation: string | null;
  externalReferenceUrl: string | null;
  rightsNote: string | null;
  instructions: string | null;
  intendedStudyDesign: string | null;
  applicabilityNote: string | null;
  overallJudgementRequired: boolean;
  draftRevision: number;
  createdAt: Date;
  finalizedAt: Date | null;
};

export type AppraisalFrameworkSection = {
  id: string;
  projectId: string;
  frameworkVersionId: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type AppraisalFrameworkItem = {
  id: string;
  projectId: string;
  frameworkVersionId: string;
  sectionId: string;
  prompt: string;
  guidance: string | null;
  required: boolean;
  sortOrder: number;
  options: AppraisalFrameworkResponseOption[];
};

export type AppraisalFrameworkResponseOption = {
  id: string;
  projectId: string;
  frameworkVersionId: string;
  itemId: string;
  optionKey: string;
  label: string;
  sortOrder: number;
};

export type AppraisalFrameworkOverallOption = {
  id: string;
  projectId: string;
  frameworkVersionId: string;
  optionKey: string;
  label: string;
  sortOrder: number;
};

export type FrameworkVersionDetail = {
  framework: AppraisalFramework;
  version: AppraisalFrameworkVersion;
  sections: AppraisalFrameworkSection[];
  items: AppraisalFrameworkItem[];
  overallOptions: AppraisalFrameworkOverallOption[];
};

export type AppraisalEvidenceSnapshot = {
  id: string;
  evidenceId: string;
  paperId: string;
  frameworkItemId: string;
  responseId: string;
  evidenceReviewDecisionIdAtSave: string | null;
  evidenceReviewStateAtSave: "unreviewed" | "needs_review" | "accepted" | "rejected";
  currentReviewState: "unreviewed" | "needs_review" | "accepted" | "rejected";
  currentReviewDecisionId: string | null;
  currentReviewWarning: string | null;
  sourceText: string;
  pageNumber: number;
  note: string | null;
};

export type AppraisalResponseSnapshot = {
  id: string;
  frameworkItemId: string;
  selectedOptionId: string | null;
  selectedOptionLabel: string | null;
  rationale: string | null;
  evidence: AppraisalEvidenceSnapshot[];
};

export type AppraisalRevisionView = {
  id: string;
  sequence: number;
  revisionNumber: number;
  projectId: string;
  paperId: string;
  frameworkId: string;
  appraisalId: string;
  frameworkVersionId: string;
  frameworkVersionNumber: number;
  titleAbstractDecisionId: string;
  fullTextDecisionId: string;
  overallJudgementOptionId: string | null;
  overallJudgementLabel: string | null;
  overallRationale: string | null;
  createdAt: Date;
  finalizedAt: Date;
  completion: "in_progress" | "complete";
  responses: AppraisalResponseSnapshot[];
  historicalEligibility: boolean;
};

export type AppraisalStatusRow = {
  paperId: string;
  paperTitle: string;
  frameworkId: string;
  frameworkName: string;
  appraisalId: string | null;
  revisionId: string | null;
  revisionNumber: number | null;
  frameworkVersionId: string | null;
  versionNumber: number | null;
  versionLabel: string | null;
  latestAvailableVersionNumber: number;
  baseState: "not_started" | "in_progress" | "complete";
  overallJudgement: string | null;
  lastSavedAt: Date | null;
  historical: boolean;
  frameworkArchived: boolean;
  newerVersionAvailable: boolean;
};

export type PaperAppraisalView = {
  paper: { id: string; title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null };
  framework: AppraisalFramework;
  latestAvailableVersion: AppraisalFrameworkVersion | null;
  currentRevision: AppraisalRevisionView | null;
  historical: boolean;
  frameworkArchived: boolean;
  newerVersionAvailable: boolean;
};

export type AppraisalHistorySummary = {
  id: string;
  revisionNumber: number;
  frameworkVersionId: string;
  versionNumber: number;
  versionLabel: string;
  overallJudgementLabel: string | null;
  createdAt: Date;
  finalizedAt: Date;
  completion: "in_progress" | "complete";
  historicalEligibility: boolean;
  currentWarningCount: number;
};

function rows(value: unknown): Row[] {
  return value as Row[];
}

function stringValue(value: unknown): string {
  return String(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function dateValue(value: unknown): Date {
  return value as Date;
}

function ensureUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  }
  return value;
}

function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Input failed appraisal validation", result.error.issues);
  return result.data;
}

function mapFramework(row: Row): AppraisalFramework {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    name: stringValue(row.name),
    createdAt: dateValue(row.created_at),
    archivedAt: row.archived_at as Date | null,
  };
}

function mapVersion(row: Row): AppraisalFrameworkVersion {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    frameworkId: stringValue(row.framework_id),
    versionNumber: numberValue(row.version_number),
    versionLabel: stringValue(row.version_label),
    description: nullableString(row.description),
    citation: nullableString(row.citation),
    externalReferenceUrl: nullableString(row.external_reference_url),
    rightsNote: nullableString(row.rights_note),
    instructions: nullableString(row.instructions),
    intendedStudyDesign: nullableString(row.intended_study_design),
    applicabilityNote: nullableString(row.applicability_note),
    overallJudgementRequired: Boolean(row.overall_judgement_required),
    draftRevision: numberValue(row.draft_revision),
    createdAt: dateValue(row.created_at),
    finalizedAt: row.finalized_at as Date | null,
  };
}

function mapSection(row: Row): AppraisalFrameworkSection {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    frameworkVersionId: stringValue(row.framework_version_id),
    label: stringValue(row.label),
    description: nullableString(row.description),
    sortOrder: numberValue(row.sort_order),
  };
}

function mapOption(row: Row): AppraisalFrameworkResponseOption {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    frameworkVersionId: stringValue(row.framework_version_id),
    itemId: stringValue(row.item_id),
    optionKey: stringValue(row.option_key),
    label: stringValue(row.label),
    sortOrder: numberValue(row.sort_order),
  };
}

function mapOverallOption(row: Row): AppraisalFrameworkOverallOption {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    frameworkVersionId: stringValue(row.framework_version_id),
    optionKey: stringValue(row.option_key),
    label: stringValue(row.label),
    sortOrder: numberValue(row.sort_order),
  };
}

function parseJsonArray(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as Row[] : []; } catch { return []; }
  }
  return [];
}

function constraintError(error: unknown, message: string): never {
  if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", message);
  throw error;
}

async function lockProject(executor: Executor, projectId: string) {
  const locked = rows(await executor.execute(sql`select id from projects where id=${projectId} for update`));
  if (!locked.length) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
}

async function lockFramework(executor: Executor, projectId: string, frameworkId: string, forUpdate = true): Promise<Row> {
  const suffix = forUpdate ? sql` for update` : sql``;
  const found = rows(await executor.execute(sql`
    select * from appraisal_frameworks
    where project_id=${projectId} and id=${frameworkId}${suffix}
    limit 1
  `))[0];
  if (!found) throw new DomainError("CROSS_PROJECT_REFERENCE", "Appraisal framework does not belong to this project");
  return found;
}

async function lockVersion(executor: Executor, projectId: string, versionId: string, forUpdate = true): Promise<Row> {
  const suffix = forUpdate ? sql` for update` : sql``;
  const found = rows(await executor.execute(sql`
    select v.*, f.name as framework_name, f.archived_at as framework_archived_at
    from appraisal_framework_versions v
    join appraisal_frameworks f on f.project_id=v.project_id and f.id=v.framework_id
    where v.project_id=${projectId} and v.id=${versionId}${suffix}
    limit 1
  `))[0];
  if (!found) throw new DomainError("CROSS_PROJECT_REFERENCE", "Framework version does not belong to this project");
  return found;
}

function ensureDraft(version: Row) {
  if (version.finalized_at != null) throw new DomainError("VALIDATION_ERROR", "Finalized framework versions are immutable");
  if (version.framework_archived_at != null) throw new DomainError("VALIDATION_ERROR", "Archived appraisal frameworks cannot be edited");
}

const STALE_FRAMEWORK_DRAFT_MESSAGE = "This framework draft changed in another session. Reload the current definition before making further edits.";

async function lockAndRequireFrameworkDraft(executor: Executor, projectId: string, versionId: string, expectedDraftRevision: number): Promise<Row> {
  const version = await lockVersion(executor, projectId, versionId);
  ensureDraft(version);
  if (numberValue(version.draft_revision) !== expectedDraftRevision) {
    throw new DomainError("CONCURRENT_MODIFICATION", STALE_FRAMEWORK_DRAFT_MESSAGE);
  }
  return version;
}

function ensureNotArchived(framework: Row) {
  if (framework.archived_at != null) throw new DomainError("VALIDATION_ERROR", "Archived appraisal frameworks cannot be used for new appraisal work");
}

async function bumpDraft(executor: Executor, projectId: string, versionId: string, expectedDraftRevision: number): Promise<number> {
  const updated = rows(await executor.execute(sql`
    update appraisal_framework_versions
    set draft_revision=draft_revision + 1
    where project_id=${projectId} and id=${versionId} and finalized_at is null and draft_revision=${expectedDraftRevision}
    returning draft_revision
  `))[0];
  if (!updated) throw new DomainError("CONCURRENT_MODIFICATION", STALE_FRAMEWORK_DRAFT_MESSAGE);
  return numberValue(updated.draft_revision);
}

async function readFrameworkVersionWithExecutor(executor: Executor, projectId: string, versionId: string): Promise<FrameworkVersionDetail> {
  const versionRow = rows(await executor.execute(sql`
    select v.*, f.id as framework_id, f.name as framework_name, f.created_at as framework_created_at, f.archived_at as framework_archived_at,
      coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order, s.id) from appraisal_framework_sections s where s.project_id=v.project_id and s.framework_version_id=v.id), '[]'::jsonb) as sections,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'project_id', i.project_id, 'framework_version_id', i.framework_version_id, 'section_id', i.section_id,
        'prompt', i.prompt, 'guidance', i.guidance, 'required', i.required, 'sort_order', i.sort_order,
        'options', coalesce((select jsonb_agg(to_jsonb(o) order by o.sort_order, o.id) from appraisal_framework_response_options o where o.project_id=i.project_id and o.framework_version_id=i.framework_version_id and o.item_id=i.id), '[]'::jsonb)
      ) order by i.section_id, i.sort_order, i.id) from appraisal_framework_items i where i.project_id=v.project_id and i.framework_version_id=v.id), '[]'::jsonb) as items,
      coalesce((select jsonb_agg(to_jsonb(go) order by go.sort_order, go.id) from appraisal_framework_overall_judgement_options go where go.project_id=v.project_id and go.framework_version_id=v.id), '[]'::jsonb) as overall_options
    from appraisal_framework_versions v
    join appraisal_frameworks f on f.project_id=v.project_id and f.id=v.framework_id
    where v.project_id=${projectId} and v.id=${versionId}
    limit 1
  `))[0];
  if (!versionRow) throw new DomainError("CROSS_PROJECT_REFERENCE", "Framework version does not belong to this project");
  const version = mapVersion(versionRow);
  return {
    framework: {
      id: stringValue(versionRow.framework_id),
      projectId,
      name: stringValue(versionRow.framework_name),
      createdAt: dateValue(versionRow.framework_created_at),
      archivedAt: versionRow.framework_archived_at as Date | null,
    },
    version,
    sections: parseJsonArray(versionRow.sections).map(mapSection),
    items: parseJsonArray(versionRow.items).map((row) => ({
      id: stringValue(row.id),
      projectId: stringValue(row.project_id),
      frameworkVersionId: stringValue(row.framework_version_id),
      sectionId: stringValue(row.section_id),
      prompt: stringValue(row.prompt),
      guidance: nullableString(row.guidance),
      required: Boolean(row.required),
      sortOrder: numberValue(row.sort_order),
      options: parseJsonArray(row.options).map(mapOption),
    })),
    overallOptions: parseJsonArray(versionRow.overall_options).map(mapOverallOption),
  };
}

async function reorderDraftRows(executor: Executor, table: string, projectId: string, versionId: string, ids: string[], scopeColumn?: string, scopeId?: string) {
  const scope = scopeColumn && scopeId ? sql` and ${sql.raw(scopeColumn)}=${scopeId}` : sql``;
  const targetScope = scopeColumn && scopeId ? sql` and target.${sql.raw(scopeColumn)}=${scopeId}` : sql``;
  const existing = rows(await executor.execute(sql`
    select id from ${sql.raw(table)} where project_id=${projectId} and framework_version_id=${versionId}${scope} order by id
  `)).map((row) => stringValue(row.id));
  if (existing.length !== ids.length || [...existing].sort().join(",") !== [...ids].sort().join(",")) {
    throw new DomainError("VALIDATION_ERROR", "Reorder must include every draft definition row exactly once");
  }
  const assignments = sql.join(ids.map((id, index) => sql`(${id}::uuid,${index + 1}::integer)`), sql`, `);
  await executor.execute(sql`
    update ${sql.raw(table)} as target
    set sort_order=assignment.sort_order
    from (values ${assignments}) as assignment(id, sort_order)
    where target.project_id=${projectId} and target.framework_version_id=${versionId}
      and target.id=assignment.id${targetScope}
  `);
}

export function createCriticalAppraisalServices(db: Database, dependencies: Dependencies) {
  async function requireProject(projectId: string) {
    ensureUuid(projectId, "Project");
    await dependencies.requireProject(projectId);
  }

  async function createAppraisalFramework(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(createAppraisalFrameworkSchema, input);
    try {
      return await db.transaction(async (tx) => {
        await lockProject(tx, projectId);
        const framework = rows(await tx.execute(sql`
          insert into appraisal_frameworks (project_id, name) values (${projectId}, ${values.name}) returning *
        `))[0];
        const version = rows(await tx.execute(sql`
          insert into appraisal_framework_versions (project_id, framework_id, version_number, version_label)
          values (${projectId}, ${framework.id}, 1, '1') returning *
        `))[0];
        return { framework: mapFramework(framework), version: mapVersion(version) };
      });
    } catch (error) {
      return constraintError(error, "An appraisal framework with this name already exists in the project");
    }
  }

  async function listAppraisalFrameworks(projectId: string): Promise<Array<AppraisalFramework & { draftVersion: AppraisalFrameworkVersion | null; latestFinalizedVersion: AppraisalFrameworkVersion | null }>> {
    ensureUuid(projectId, "Project");
    const result = rows(await db.execute(sql`
      select f.*, d.id as draft_id, d.version_number as draft_version_number, d.version_label as draft_version_label,
        d.description as draft_description, d.citation as draft_citation, d.external_reference_url as draft_external_reference_url,
        d.rights_note as draft_rights_note, d.instructions as draft_instructions, d.intended_study_design as draft_intended_study_design,
        d.applicability_note as draft_applicability_note, d.overall_judgement_required as draft_overall_judgement_required,
        d.draft_revision as draft_draft_revision, d.created_at as draft_created_at, d.finalized_at as draft_finalized_at,
        v.id as latest_id, v.version_number as latest_version_number, v.version_label as latest_version_label,
        v.description as latest_description, v.citation as latest_citation, v.external_reference_url as latest_external_reference_url,
        v.rights_note as latest_rights_note, v.instructions as latest_instructions, v.intended_study_design as latest_intended_study_design,
        v.applicability_note as latest_applicability_note, v.overall_judgement_required as latest_overall_judgement_required,
        v.draft_revision as latest_draft_revision, v.created_at as latest_created_at, v.finalized_at as latest_finalized_at
      from appraisal_frameworks f
      left join lateral (select * from appraisal_framework_versions x where x.project_id=f.project_id and x.framework_id=f.id and x.finalized_at is null order by x.version_number desc limit 1) d on true
      left join lateral (select * from appraisal_framework_versions x where x.project_id=f.project_id and x.framework_id=f.id and x.finalized_at is not null order by x.version_number desc limit 1) v on true
      where f.project_id=${projectId}
      order by f.created_at, f.id
    `));
    const versionFrom = (row: Row, prefix: "draft" | "latest"): AppraisalFrameworkVersion | null => row[`${prefix}_id`] == null ? null : mapVersion({
      id: row[`${prefix}_id`], project_id: row.project_id, framework_id: row.id,
      version_number: row[`${prefix}_version_number`], version_label: row[`${prefix}_version_label`],
      description: row[`${prefix}_description`], citation: row[`${prefix}_citation`], external_reference_url: row[`${prefix}_external_reference_url`],
      rights_note: row[`${prefix}_rights_note`], instructions: row[`${prefix}_instructions`], intended_study_design: row[`${prefix}_intended_study_design`],
      applicability_note: row[`${prefix}_applicability_note`], overall_judgement_required: row[`${prefix}_overall_judgement_required`],
      draft_revision: row[`${prefix}_draft_revision`], created_at: row[`${prefix}_created_at`], finalized_at: row[`${prefix}_finalized_at`],
    });
    return result.map((row) => ({ ...mapFramework(row), draftVersion: versionFrom(row, "draft"), latestFinalizedVersion: versionFrom(row, "latest") }));
  }

  async function readFrameworkVersion(projectId: string, versionId: string) {
    ensureUuid(projectId, "Project");
    ensureUuid(versionId, "Framework version");
    return readFrameworkVersionWithExecutor(db, projectId, versionId);
  }

  async function updateFrameworkDraftMetadata(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(updateFrameworkDraftMetadataSchema, input);
    return db.transaction(async (tx) => {
      const version = await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const next = {
        versionLabel: values.versionLabel ?? stringValue(version.version_label),
        description: values.description === undefined ? nullableString(version.description) : values.description,
        citation: values.citation === undefined ? nullableString(version.citation) : values.citation,
        externalReferenceUrl: values.externalReferenceUrl === undefined ? nullableString(version.external_reference_url) : values.externalReferenceUrl,
        rightsNote: values.rightsNote === undefined ? nullableString(version.rights_note) : values.rightsNote,
        instructions: values.instructions === undefined ? nullableString(version.instructions) : values.instructions,
        intendedStudyDesign: values.intendedStudyDesign === undefined ? nullableString(version.intended_study_design) : values.intendedStudyDesign,
        applicabilityNote: values.applicabilityNote === undefined ? nullableString(version.applicability_note) : values.applicabilityNote,
        overallJudgementRequired: values.overallJudgementRequired ?? Boolean(version.overall_judgement_required),
      };
      try {
        await tx.execute(sql`
          update appraisal_framework_versions set version_label=${next.versionLabel}, description=${next.description}, citation=${next.citation},
            external_reference_url=${next.externalReferenceUrl}, rights_note=${next.rightsNote}, instructions=${next.instructions},
            intended_study_design=${next.intendedStudyDesign}, applicability_note=${next.applicabilityNote},
            overall_judgement_required=${next.overallJudgementRequired}
          where project_id=${projectId} and id=${values.versionId} and finalized_at is null
        `);
      } catch (error) { return constraintError(error, "Framework draft metadata could not be saved"); }
      await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return readFrameworkVersionWithExecutor(tx, projectId, values.versionId);
    });
  }

  async function addFrameworkSection(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalSectionInputSchema, input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const sectionCount = rows(await tx.execute(sql`select count(*)::int as value from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${values.versionId}`))[0];
      if (numberValue(sectionCount.value) >= 50) throw new DomainError("VALIDATION_ERROR", "A framework version cannot contain more than 50 sections");
      const last = rows(await tx.execute(sql`select coalesce(max(sort_order),0)::int as value from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${values.versionId}`))[0];
      const section = rows(await tx.execute(sql`insert into appraisal_framework_sections (project_id, framework_version_id, label, description, sort_order) values (${projectId},${values.versionId},${values.label},${values.description ?? null},${numberValue(last.value)+1}) returning *`))[0];
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...mapSection(section), draftRevision };
    });
  }

  async function updateFrameworkSection(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalSectionUpdateSchema, input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const section = rows(await tx.execute(sql`select * from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${values.versionId} and id=${values.sectionId} for update`))[0];
      if (!section) throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to this framework version");
      await tx.execute(sql`update appraisal_framework_sections set label=${values.label}, description=${values.description ?? null} where project_id=${projectId} and id=${values.sectionId}`);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...mapSection({ ...section, label: values.label, description: values.description ?? null }), draftRevision };
    });
  }

  async function reorderFrameworkSections(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalReorderSchema, input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      await reorderDraftRows(tx, "appraisal_framework_sections", projectId, values.versionId, values.ids);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...await readFrameworkVersionWithExecutor(tx, projectId, values.versionId), draftRevision };
    });
  }

  async function removeFrameworkSection(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalSectionRemovalSchema, input);
    const { versionId, sectionId, expectedDraftRevision } = values;
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, versionId, expectedDraftRevision);
      const item = rows(await tx.execute(sql`select 1 from appraisal_framework_items where project_id=${projectId} and framework_version_id=${versionId} and section_id=${sectionId} limit 1`));
      if (item.length) throw new DomainError("VALIDATION_ERROR", "Remove or move framework items before removing their section");
      const deleted = rows(await tx.execute(sql`delete from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${versionId} and id=${sectionId} returning id`));
      if (!deleted.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to this framework version");
      const draftRevision = await bumpDraft(tx, projectId, versionId, expectedDraftRevision);
      return { id: sectionId, draftRevision };
    });
  }

  async function addFrameworkItem(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalItemInputSchema, input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const section = rows(await tx.execute(sql`select id from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${values.versionId} and id=${values.sectionId}`));
      if (!section.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to this framework version");
      const itemCount = rows(await tx.execute(sql`select count(*)::int as value from appraisal_framework_items where project_id=${projectId} and framework_version_id=${values.versionId}`))[0];
      if (numberValue(itemCount.value) >= 200) throw new DomainError("VALIDATION_ERROR", "A framework version cannot contain more than 200 items");
      const last = rows(await tx.execute(sql`select coalesce(max(sort_order),0)::int as value from appraisal_framework_items where project_id=${projectId} and framework_version_id=${values.versionId} and section_id=${values.sectionId}`))[0];
      const item = rows(await tx.execute(sql`insert into appraisal_framework_items (project_id, framework_version_id, section_id, prompt, guidance, required, sort_order) values (${projectId},${values.versionId},${values.sectionId},${values.prompt},${values.guidance ?? null},${values.required},${numberValue(last.value)+1}) returning *`))[0];
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return {
        id: stringValue(item.id),
        projectId: stringValue(item.project_id),
        frameworkVersionId: stringValue(item.framework_version_id),
        sectionId: stringValue(item.section_id),
        prompt: stringValue(item.prompt),
        guidance: nullableString(item.guidance),
        required: Boolean(item.required),
        sortOrder: numberValue(item.sort_order),
        options: [],
        draftRevision,
      } satisfies AppraisalFrameworkItem & { draftRevision: number };
    });
  }

  async function updateFrameworkItem(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalItemUpdateSchema, input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const item = rows(await tx.execute(sql`select * from appraisal_framework_items where project_id=${projectId} and framework_version_id=${values.versionId} and id=${values.itemId} for update`))[0];
      if (!item) throw new DomainError("CROSS_PROJECT_REFERENCE", "Item does not belong to this framework version");
      const section = rows(await tx.execute(sql`select id from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${values.versionId} and id=${values.sectionId}`));
      if (!section.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to this framework version");
      await tx.execute(sql`update appraisal_framework_items set section_id=${values.sectionId}, prompt=${values.prompt}, guidance=${values.guidance ?? null}, required=${values.required} where project_id=${projectId} and id=${values.itemId}`);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...item, section_id: values.sectionId, prompt: values.prompt, guidance: values.guidance ?? null, required: values.required, draftRevision };
    });
  }

  async function reorderFrameworkItems(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalReorderSchema.extend({ sectionId: appraisalReorderSchema.shape.versionId }), input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      await reorderDraftRows(tx, "appraisal_framework_items", projectId, values.versionId, values.ids, "section_id", values.sectionId);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...await readFrameworkVersionWithExecutor(tx, projectId, values.versionId), draftRevision };
    });
  }

  async function removeFrameworkItem(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalItemRemovalSchema, input);
    const { versionId, itemId, expectedDraftRevision } = values;
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, versionId, expectedDraftRevision);
      await tx.execute(sql`delete from appraisal_framework_response_options where project_id=${projectId} and framework_version_id=${versionId} and item_id=${itemId}`);
      const deleted = rows(await tx.execute(sql`delete from appraisal_framework_items where project_id=${projectId} and framework_version_id=${versionId} and id=${itemId} returning id`));
      if (!deleted.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Item does not belong to this framework version");
      const draftRevision = await bumpDraft(tx, projectId, versionId, expectedDraftRevision);
      return { id: itemId, draftRevision };
    });
  }

  async function addFrameworkResponseOption(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalResponseOptionInputSchema.extend({ versionId: appraisalResponseOptionInputSchema.shape.itemId }), input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const item = rows(await tx.execute(sql`select id from appraisal_framework_items where project_id=${projectId} and framework_version_id=${values.versionId} and id=${values.itemId}`));
      if (!item.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Item does not belong to this framework version");
      const optionCount = rows(await tx.execute(sql`select count(*)::int as value from appraisal_framework_response_options where project_id=${projectId} and framework_version_id=${values.versionId} and item_id=${values.itemId}`))[0];
      if (numberValue(optionCount.value) >= 20) throw new DomainError("VALIDATION_ERROR", "An appraisal item cannot contain more than 20 response options");
      const last = rows(await tx.execute(sql`select coalesce(max(sort_order),0)::int as value from appraisal_framework_response_options where project_id=${projectId} and framework_version_id=${values.versionId} and item_id=${values.itemId}`))[0];
      try {
        const option = rows(await tx.execute(sql`insert into appraisal_framework_response_options (project_id, framework_version_id, item_id, option_key, label, sort_order) values (${projectId},${values.versionId},${values.itemId},${values.optionKey},${values.label},${numberValue(last.value)+1}) returning *`))[0];
        const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
        return { ...mapOption(option), draftRevision };
      } catch (error) { return constraintError(error, "Response option key or label already exists for this item"); }
    });
  }

  async function updateFrameworkResponseOption(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalResponseOptionUpdateSchema.extend({ versionId: appraisalResponseOptionUpdateSchema.shape.itemId }), input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      const option = rows(await tx.execute(sql`select * from appraisal_framework_response_options where project_id=${projectId} and framework_version_id=${values.versionId} and item_id=${values.itemId} and id=${values.optionId} for update`))[0];
      if (!option) throw new DomainError("CROSS_PROJECT_REFERENCE", "Response option does not belong to this framework item");
      try {
        await tx.execute(sql`update appraisal_framework_response_options set option_key=${values.optionKey}, label=${values.label} where project_id=${projectId} and id=${values.optionId}`);
      } catch (error) { return constraintError(error, "Response option key or label already exists for this item"); }
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...mapOption({ ...option, option_key: values.optionKey, label: values.label }), draftRevision };
    });
  }

  async function reorderFrameworkResponseOptions(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalReorderSchema.extend({ itemId: appraisalReorderSchema.shape.versionId }), input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      await reorderDraftRows(tx, "appraisal_framework_response_options", projectId, values.versionId, values.ids, "item_id", values.itemId);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...await readFrameworkVersionWithExecutor(tx, projectId, values.versionId), draftRevision };
    });
  }

  async function removeFrameworkResponseOption(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalResponseOptionRemovalSchema, input);
    const { versionId, itemId, optionId, expectedDraftRevision } = values;
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, versionId, expectedDraftRevision);
      const deleted = rows(await tx.execute(sql`delete from appraisal_framework_response_options where project_id=${projectId} and framework_version_id=${versionId} and item_id=${itemId} and id=${optionId} returning id`));
      if (!deleted.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Response option does not belong to this framework item");
      const draftRevision = await bumpDraft(tx, projectId, versionId, expectedDraftRevision);
      return { id: optionId, draftRevision };
    });
  }

  async function setFrameworkOverallJudgementOptions(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalOverallOptionsSchema, input);
    if (new Set(values.options.map((option) => option.optionKey.toLowerCase())).size !== values.options.length) throw new DomainError("VALIDATION_ERROR", "Overall judgement option keys must be unique");
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      await tx.execute(sql`delete from appraisal_framework_overall_judgement_options where project_id=${projectId} and framework_version_id=${values.versionId}`);
      for (let index = 0; index < values.options.length; index += 1) {
        const option = values.options[index];
        await tx.execute(sql`insert into appraisal_framework_overall_judgement_options (project_id, framework_version_id, option_key, label, sort_order) values (${projectId},${values.versionId},${option.optionKey},${option.label},${index + 1})`);
      }
      await tx.execute(sql`update appraisal_framework_versions set overall_judgement_required=${values.required} where project_id=${projectId} and id=${values.versionId}`);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...await readFrameworkVersionWithExecutor(tx, projectId, values.versionId), draftRevision };
    });
  }

  async function reorderFrameworkOverallJudgementOptions(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(appraisalReorderSchema, input);
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      await reorderDraftRows(tx, "appraisal_framework_overall_judgement_options", projectId, values.versionId, values.ids);
      const draftRevision = await bumpDraft(tx, projectId, values.versionId, values.expectedDraftRevision);
      return { ...await readFrameworkVersionWithExecutor(tx, projectId, values.versionId), draftRevision };
    });
  }

  async function finalizeFrameworkVersion(projectId: string, versionId: string, expectedDraftRevision: number) {
    await requireProject(projectId); ensureUuid(versionId, "Framework version");
    return db.transaction(async (tx) => {
      await lockAndRequireFrameworkDraft(tx, projectId, versionId, expectedDraftRevision);
      await bumpDraft(tx, projectId, versionId, expectedDraftRevision);
      try {
        await tx.execute(sql`update appraisal_framework_versions set finalized_at=now() where project_id=${projectId} and id=${versionId} and finalized_at is null`);
      } catch (error) { return constraintError(error, "Framework version could not be finalized"); }
      return readFrameworkVersionWithExecutor(tx, projectId, versionId);
    });
  }

  async function createNewFrameworkVersion(projectId: string, frameworkId: string, input?: { versionLabel?: string } | string) {
    await requireProject(projectId); ensureUuid(frameworkId, "Framework");
    return db.transaction(async (tx) => {
      const framework = await lockFramework(tx, projectId, frameworkId); ensureNotArchived(framework);
      const draft = rows(await tx.execute(sql`select id from appraisal_framework_versions where project_id=${projectId} and framework_id=${frameworkId} and finalized_at is null limit 1`));
      if (draft.length) throw new DomainError("VALIDATION_ERROR", "Finalize the existing framework draft before creating another version");
      const latest = rows(await tx.execute(sql`select * from appraisal_framework_versions where project_id=${projectId} and framework_id=${frameworkId} and finalized_at is not null order by version_number desc limit 1`))[0];
      if (!latest) throw new DomainError("VALIDATION_ERROR", "A new framework version requires a finalized version to clone");
      const nextNumber = numberValue(latest.version_number) + 1;
      const label = typeof input === "string" ? input : input?.versionLabel ?? String(nextNumber);
      let version: Row;
      try {
        version = rows(await tx.execute(sql`
          insert into appraisal_framework_versions (project_id, framework_id, version_number, version_label, description, citation, external_reference_url, rights_note, instructions, intended_study_design, applicability_note, overall_judgement_required)
          select project_id, framework_id, ${nextNumber}, ${label}, description, citation, external_reference_url, rights_note, instructions, intended_study_design, applicability_note, overall_judgement_required
          from appraisal_framework_versions where project_id=${projectId} and id=${latest.id} returning *
        `))[0];
      } catch (error) { return constraintError(error, "Framework version could not be created"); }
      const sectionMap = new Map<string, string>();
      const oldSections = rows(await tx.execute(sql`select * from appraisal_framework_sections where project_id=${projectId} and framework_version_id=${latest.id} order by sort_order, id`));
      for (const old of oldSections) {
        const id = randomUUID(); sectionMap.set(stringValue(old.id), id);
        await tx.execute(sql`insert into appraisal_framework_sections (id, project_id, framework_version_id, label, description, sort_order) values (${id},${projectId},${version.id},${old.label},${old.description ?? null},${old.sort_order})`);
      }
      const oldItems = rows(await tx.execute(sql`select * from appraisal_framework_items where project_id=${projectId} and framework_version_id=${latest.id} order by section_id, sort_order, id`));
      for (const old of oldItems) {
        const id = randomUUID();
        await tx.execute(sql`insert into appraisal_framework_items (id, project_id, framework_version_id, section_id, prompt, guidance, required, sort_order) values (${id},${projectId},${version.id},${sectionMap.get(stringValue(old.section_id))},${old.prompt},${old.guidance ?? null},${old.required},${old.sort_order})`);
        const oldOptions = rows(await tx.execute(sql`select * from appraisal_framework_response_options where project_id=${projectId} and framework_version_id=${latest.id} and item_id=${old.id} order by sort_order, id`));
        for (const option of oldOptions) await tx.execute(sql`insert into appraisal_framework_response_options (id, project_id, framework_version_id, item_id, option_key, label, sort_order) values (${randomUUID()},${projectId},${version.id},${id},${option.option_key},${option.label},${option.sort_order})`);
      }
      const oldOverall = rows(await tx.execute(sql`select * from appraisal_framework_overall_judgement_options where project_id=${projectId} and framework_version_id=${latest.id} order by sort_order, id`));
      for (const option of oldOverall) await tx.execute(sql`insert into appraisal_framework_overall_judgement_options (id, project_id, framework_version_id, option_key, label, sort_order) values (${randomUUID()},${projectId},${version.id},${option.option_key},${option.label},${option.sort_order})`);
      return readFrameworkVersionWithExecutor(tx, projectId, stringValue(version.id));
    });
  }

  async function archiveAppraisalFramework(projectId: string, frameworkId: string) {
    await requireProject(projectId); ensureUuid(frameworkId, "Framework");
    return db.transaction(async (tx) => {
      const framework = await lockFramework(tx, projectId, frameworkId);
      if (framework.archived_at == null) await tx.execute(sql`update appraisal_frameworks set archived_at=now() where project_id=${projectId} and id=${frameworkId} and archived_at is null`);
      return mapFramework({ ...framework, archived_at: framework.archived_at ?? new Date() });
    });
  }

  async function latestEligibility(executor: Executor, projectId: string, paperId: string) {
    const titleAbstract = rows(await executor.execute(sql`
      select id, decision from screening_decisions
      where project_id=${projectId} and paper_id=${paperId} and stage='title_abstract'
      order by sequence desc limit 1
    `))[0] ?? null;
    const fullText = rows(await executor.execute(sql`
      select id, decision from full_text_screening_decisions
      where project_id=${projectId} and paper_id=${paperId}
      order by sequence desc limit 1
    `))[0] ?? null;
    return {
      titleAbstract,
      fullText,
      included: titleAbstract?.decision === "include" && fullText?.decision === "include",
    };
  }

  async function latestFinalizedVersion(executor: Executor, projectId: string, frameworkId: string) {
    return rows(await executor.execute(sql`
      select * from appraisal_framework_versions
      where project_id=${projectId} and framework_id=${frameworkId} and finalized_at is not null
      order by version_number desc limit 1
    `))[0] ?? null;
  }

  async function readRevisionWithExecutor(executor: Executor, projectId: string, revisionId: string): Promise<AppraisalRevisionView> {
    const revision = rows(await executor.execute(sql`
      select r.*, v.version_number, v.overall_judgement_required, o.label as overall_judgement_label
      from appraisal_revisions r
      join appraisal_framework_versions v on v.project_id=r.project_id and v.id=r.framework_version_id
      left join appraisal_framework_overall_judgement_options o on o.project_id=r.project_id and o.framework_version_id=r.framework_version_id and o.id=r.overall_judgement_option_id
      where r.project_id=${projectId} and r.id=${revisionId} and r.finalized_at is not null
      limit 1
    `))[0];
    if (!revision) throw new DomainError("NOT_FOUND", "Appraisal revision was not found");
    const responseRows = rows(await executor.execute(sql`
      select r.*, o.label as selected_option_label
      from appraisal_revision_responses r
      left join appraisal_framework_response_options o on o.project_id=r.project_id and o.framework_version_id=r.framework_version_id and o.item_id=r.framework_item_id and o.id=r.selected_option_id
      where r.project_id=${projectId} and r.revision_id=${revisionId}
      order by r.framework_item_id, r.id
    `));
    const evidenceRows = rows(await executor.execute(sql`
      select l.*, e.source_text, e.page_number, e.note,
        coalesce(current_review.decision, 'unreviewed') as current_review_state,
        current_review.id as current_review_decision_id
      from appraisal_revision_response_evidence l
      join evidence e on e.project_id=l.project_id and e.paper_id=l.paper_id and e.id=l.evidence_id
      left join lateral (
        select d.id, d.decision from evidence_review_decisions d
        where d.project_id=l.project_id and d.evidence_id=l.evidence_id
        order by d.sequence desc limit 1
      ) current_review on true
      where l.project_id=${projectId} and l.revision_id=${revisionId}
      order by l.framework_item_id, e.page_number, e.id
    `));
    const evidenceByResponse = new Map<string, AppraisalEvidenceSnapshot[]>();
    for (const row of evidenceRows) {
      const savedState = stringValue(row.evidence_review_state_at_save) as AppraisalEvidenceSnapshot["evidenceReviewStateAtSave"];
      const currentState = stringValue(row.current_review_state) as AppraisalEvidenceSnapshot["currentReviewState"];
      const warning = savedState === currentState ? null : `${savedState} when saved; currently ${currentState}`;
      const snapshot: AppraisalEvidenceSnapshot = {
        id: stringValue(row.id),
        evidenceId: stringValue(row.evidence_id),
        paperId: stringValue(row.paper_id),
        frameworkItemId: stringValue(row.framework_item_id),
        responseId: stringValue(row.response_id),
        evidenceReviewDecisionIdAtSave: nullableString(row.evidence_review_decision_id_at_save),
        evidenceReviewStateAtSave: savedState,
        currentReviewState: currentState,
        currentReviewDecisionId: nullableString(row.current_review_decision_id),
        currentReviewWarning: warning,
        sourceText: stringValue(row.source_text),
        pageNumber: numberValue(row.page_number),
        note: nullableString(row.note),
      };
      evidenceByResponse.set(snapshot.responseId, [...(evidenceByResponse.get(snapshot.responseId) ?? []), snapshot]);
    }
    const versionItems = rows(await executor.execute(sql`
      select id, required from appraisal_framework_items
      where project_id=${projectId} and framework_version_id=${revision.framework_version_id}
    `));
    const responseByItem = new Map(responseRows.map((row) => [stringValue(row.framework_item_id), row]));
    const complete = versionItems.every((item) => !Boolean(item.required) || responseByItem.get(stringValue(item.id))?.selected_option_id != null)
      && (!Boolean(revision.overall_judgement_required) || revision.overall_judgement_option_id != null);
    const eligibility = await latestEligibility(executor, projectId, stringValue(revision.paper_id));
    return {
      id: stringValue(revision.id),
      sequence: numberValue(revision.sequence),
      revisionNumber: numberValue(revision.revision_number),
      projectId: stringValue(revision.project_id),
      paperId: stringValue(revision.paper_id),
      frameworkId: stringValue(revision.framework_id),
      appraisalId: stringValue(revision.appraisal_id),
      frameworkVersionId: stringValue(revision.framework_version_id),
      frameworkVersionNumber: numberValue(revision.version_number),
      titleAbstractDecisionId: stringValue(revision.title_abstract_decision_id),
      fullTextDecisionId: stringValue(revision.full_text_decision_id),
      overallJudgementOptionId: nullableString(revision.overall_judgement_option_id),
      overallJudgementLabel: nullableString(revision.overall_judgement_label),
      overallRationale: nullableString(revision.overall_rationale),
      createdAt: dateValue(revision.created_at),
      finalizedAt: dateValue(revision.finalized_at),
      completion: complete ? "complete" : "in_progress",
      responses: responseRows.map((row) => ({
        id: stringValue(row.id),
        frameworkItemId: stringValue(row.framework_item_id),
        selectedOptionId: nullableString(row.selected_option_id),
        selectedOptionLabel: nullableString(row.selected_option_label),
        rationale: nullableString(row.rationale),
        evidence: evidenceByResponse.get(stringValue(row.id)) ?? [],
      })),
      historicalEligibility: !eligibility.included,
    };
  }

  async function readRevisionSetWithExecutor(executor: Executor, projectId: string, revisionId: string): Promise<AppraisalRevisionView> {
    const joinedRows = rows(await executor.execute(sql`
      with current_ta as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from screening_decisions
        where project_id=${projectId} and stage='title_abstract'
        order by project_id, paper_id, sequence desc
      ), current_ft as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions
        where project_id=${projectId}
        order by project_id, paper_id, sequence desc
      )
      select r.*, v.version_number as framework_version_number, v.overall_judgement_required, o.label as overall_judgement_label,
        (select count(*)::int from appraisal_framework_items i where i.project_id=r.project_id and i.framework_version_id=r.framework_version_id) as item_count,
        (coalesce(current_ta.decision='include', false) and coalesce(current_ft.decision='include', false)) as eligibility_included,
        rr.id as response_id, rr.framework_item_id, framework_item.required as framework_item_required, rr.selected_option_id, rr.rationale, selected_option.label as selected_option_label,
        l.id as evidence_link_id, l.evidence_id, l.evidence_review_decision_id_at_save, l.evidence_review_state_at_save,
        e.source_text, e.page_number, e.note,
        coalesce(current_review.decision, 'unreviewed') as current_review_state,
        current_review.id as current_review_decision_id
      from appraisal_revisions r
      join appraisal_framework_versions v on v.project_id=r.project_id and v.id=r.framework_version_id
      left join appraisal_framework_overall_judgement_options o on o.project_id=r.project_id and o.framework_version_id=r.framework_version_id and o.id=r.overall_judgement_option_id
      left join current_ta on current_ta.project_id=r.project_id and current_ta.paper_id=r.paper_id
      left join current_ft on current_ft.project_id=r.project_id and current_ft.paper_id=r.paper_id
      left join appraisal_revision_responses rr on rr.project_id=r.project_id and rr.revision_id=r.id
      left join appraisal_framework_items framework_item on framework_item.project_id=rr.project_id and framework_item.framework_version_id=rr.framework_version_id and framework_item.id=rr.framework_item_id
      left join appraisal_framework_response_options selected_option on selected_option.project_id=rr.project_id and selected_option.framework_version_id=rr.framework_version_id and selected_option.item_id=rr.framework_item_id and selected_option.id=rr.selected_option_id
      left join appraisal_revision_response_evidence l on l.project_id=rr.project_id and l.revision_id=rr.revision_id and l.response_id=rr.id
      left join evidence e on e.project_id=l.project_id and e.paper_id=l.paper_id and e.id=l.evidence_id
      left join lateral (
        select d.id, d.decision from evidence_review_decisions d
        where d.project_id=l.project_id and d.evidence_id=l.evidence_id
        order by d.sequence desc limit 1
      ) current_review on true
      where r.project_id=${projectId} and r.id=${revisionId} and r.finalized_at is not null
      order by rr.framework_item_id, rr.id, e.page_number, e.id
    `));
    const first = joinedRows[0];
    if (!first) throw new DomainError("NOT_FOUND", "Appraisal revision was not found");
    const responseRows = new Map<string, Row>();
    const evidenceByResponse = new Map<string, AppraisalEvidenceSnapshot[]>();
    for (const row of joinedRows) {
      const responseId = nullableString(row.response_id);
      if (responseId && !responseRows.has(responseId)) responseRows.set(responseId, row);
      const evidenceLinkId = nullableString(row.evidence_link_id);
      if (!responseId || !evidenceLinkId) continue;
      const savedState = stringValue(row.evidence_review_state_at_save) as AppraisalEvidenceSnapshot["evidenceReviewStateAtSave"];
      const currentState = stringValue(row.current_review_state) as AppraisalEvidenceSnapshot["currentReviewState"];
      const snapshot: AppraisalEvidenceSnapshot = {
        id: evidenceLinkId,
        evidenceId: stringValue(row.evidence_id),
        paperId: stringValue(row.paper_id),
        frameworkItemId: stringValue(row.framework_item_id),
        responseId,
        evidenceReviewDecisionIdAtSave: nullableString(row.evidence_review_decision_id_at_save),
        evidenceReviewStateAtSave: savedState,
        currentReviewState: currentState,
        currentReviewDecisionId: nullableString(row.current_review_decision_id),
        currentReviewWarning: savedState === currentState ? null : `${savedState} when saved; currently ${currentState}`,
        sourceText: stringValue(row.source_text),
        pageNumber: numberValue(row.page_number),
        note: nullableString(row.note),
      };
      evidenceByResponse.set(responseId, [...(evidenceByResponse.get(responseId) ?? []), snapshot]);
    }
    const responseList = [...responseRows.values()];
    const complete = numberValue(first.item_count) === responseList.length
      && responseList.every((row) => !Boolean(row.framework_item_required) || row.selected_option_id != null)
      && (!Boolean(first.overall_judgement_required) || first.overall_judgement_option_id != null);
    return {
      id: stringValue(first.id),
      sequence: numberValue(first.sequence),
      revisionNumber: numberValue(first.revision_number),
      projectId: stringValue(first.project_id),
      paperId: stringValue(first.paper_id),
      frameworkId: stringValue(first.framework_id),
      appraisalId: stringValue(first.appraisal_id),
      frameworkVersionId: stringValue(first.framework_version_id),
      frameworkVersionNumber: numberValue(first.framework_version_number),
      titleAbstractDecisionId: stringValue(first.title_abstract_decision_id),
      fullTextDecisionId: stringValue(first.full_text_decision_id),
      overallJudgementOptionId: nullableString(first.overall_judgement_option_id),
      overallJudgementLabel: nullableString(first.overall_judgement_label),
      overallRationale: nullableString(first.overall_rationale),
      createdAt: dateValue(first.created_at),
      finalizedAt: dateValue(first.finalized_at),
      completion: complete ? "complete" : "in_progress",
      responses: responseList.map((row) => ({
        id: stringValue(row.response_id),
        frameworkItemId: stringValue(row.framework_item_id),
        selectedOptionId: nullableString(row.selected_option_id),
        selectedOptionLabel: nullableString(row.selected_option_label),
        rationale: nullableString(row.rationale),
        evidence: evidenceByResponse.get(stringValue(row.response_id)) ?? [],
      })),
      historicalEligibility: !Boolean(first.eligibility_included),
    };
  }

  async function readAppraisalRevision(projectId: string, revisionId: string) {
    await requireProject(projectId); ensureUuid(revisionId, "Appraisal revision");
    return readRevisionWithExecutor(db, projectId, revisionId);
  }

  async function readPaperAppraisal(projectId: string, paperId: string, frameworkId: string): Promise<PaperAppraisalView> {
    ensureUuid(projectId, "Project"); ensureUuid(paperId, "Paper"); ensureUuid(frameworkId, "Framework");
    const summary = rows(await db.execute(sql`
      with current_ta as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from screening_decisions
        where project_id=${projectId} and paper_id=${paperId} and stage='title_abstract'
        order by project_id, paper_id, sequence desc
      ), current_ft as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions
        where project_id=${projectId} and paper_id=${paperId}
        order by project_id, paper_id, sequence desc
      )
      select p.id as paper_id, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        f.id as framework_id, f.name as framework_name, f.created_at as framework_created_at, f.archived_at as framework_archived_at,
        lv.id as latest_id, lv.version_number as latest_version_number, lv.version_label as latest_version_label,
        lv.description as latest_description, lv.citation as latest_citation, lv.external_reference_url as latest_external_reference_url,
        lv.rights_note as latest_rights_note, lv.instructions as latest_instructions, lv.intended_study_design as latest_intended_study_design,
        lv.applicability_note as latest_applicability_note, lv.overall_judgement_required as latest_overall_judgement_required,
        lv.draft_revision as latest_draft_revision, lv.created_at as latest_created_at, lv.finalized_at as latest_finalized_at,
        current_revision.id as current_revision_id, current_revision.framework_version_id as current_revision_version_id,
        current_version.version_number as current_revision_version_number,
        (coalesce(current_ta.decision='include', false) and coalesce(current_ft.decision='include', false)) as finally_included
      from papers p
      join appraisal_frameworks f on f.project_id=p.project_id and f.id=${frameworkId}
      left join lateral (
        select * from appraisal_framework_versions v
        where v.project_id=p.project_id and v.framework_id=f.id and v.finalized_at is not null
        order by v.version_number desc limit 1
      ) lv on true
      left join lateral (
        select r.* from appraisal_revisions r
        join appraisals a on a.project_id=r.project_id and a.id=r.appraisal_id
        where r.project_id=p.project_id and a.paper_id=p.id and a.framework_id=f.id and r.finalized_at is not null
        order by r.revision_number desc limit 1
      ) current_revision on true
      left join appraisal_framework_versions current_version on current_version.project_id=current_revision.project_id and current_version.id=current_revision.framework_version_id
      left join current_ta on current_ta.project_id=p.project_id and current_ta.paper_id=p.id
      left join current_ft on current_ft.project_id=p.project_id and current_ft.paper_id=p.id
      where p.project_id=${projectId} and p.id=${paperId}
      limit 1
    `))[0];
    if (!summary) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    const framework = mapFramework({ id: summary.framework_id, project_id: projectId, name: summary.framework_name, created_at: summary.framework_created_at, archived_at: summary.framework_archived_at });
    const latestAvailableVersion = summary.latest_id == null ? null : mapVersion({
      id: summary.latest_id, project_id: projectId, framework_id: frameworkId, version_number: summary.latest_version_number, version_label: summary.latest_version_label,
      description: summary.latest_description, citation: summary.latest_citation, external_reference_url: summary.latest_external_reference_url,
      rights_note: summary.latest_rights_note, instructions: summary.latest_instructions, intended_study_design: summary.latest_intended_study_design,
      applicability_note: summary.latest_applicability_note, overall_judgement_required: summary.latest_overall_judgement_required,
      draft_revision: summary.latest_draft_revision, created_at: summary.latest_created_at, finalized_at: summary.latest_finalized_at,
    });
    const currentRevision = summary.current_revision_id ? await readRevisionSetWithExecutor(db, projectId, stringValue(summary.current_revision_id)) : null;
    const newerVersionAvailable = Boolean(latestAvailableVersion && currentRevision && latestAvailableVersion.versionNumber > currentRevision.frameworkVersionNumber);
    return {
      paper: { id: paperId, title: stringValue(summary.paper_title), authors: Array.isArray(summary.authors) ? summary.authors.map(String) : [], publicationYear: summary.publication_year == null ? null : numberValue(summary.publication_year), venue: nullableString(summary.venue), doi: nullableString(summary.doi) },
      framework,
      latestAvailableVersion,
      currentRevision,
      historical: !Boolean(summary.finally_included),
      frameworkArchived: framework.archivedAt != null,
      newerVersionAvailable,
    };
  }

  async function readAppraisalHistory(projectId: string, paperId: string, frameworkId: string, input: { page?: number; pageSize?: number } = {}): Promise<{ paperId: string; frameworkId: string; page: number; pageSize: number; revisions: AppraisalHistorySummary[]; currentRevision: AppraisalHistorySummary | null }> {
    await dependencies.requirePaper(projectId, paperId); await requireProject(projectId); ensureUuid(frameworkId, "Framework");
    const page = input.page ?? 1;
    const pageSize = Math.min(input.pageSize ?? 20, 20);
    const offset = (page - 1) * pageSize;
    const revisionRows = rows(await db.execute(sql`
      with current_ta as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from screening_decisions
        where project_id=${projectId} and paper_id=${paperId} and stage='title_abstract'
        order by project_id, paper_id, sequence desc
      ), current_ft as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions
        where project_id=${projectId} and paper_id=${paperId}
        order by project_id, paper_id, sequence desc
      )
      select r.id, r.revision_number, r.framework_version_id, v.version_number, v.version_label,
        v.overall_judgement_required, r.overall_judgement_option_id, o.label as overall_judgement_label,
        r.created_at, r.finalized_at,
        case when exists (
          select 1 from appraisal_framework_items i
          where i.project_id=r.project_id and i.framework_version_id=r.framework_version_id and i.required=true
            and not exists (select 1 from appraisal_revision_responses rr where rr.project_id=r.project_id and rr.revision_id=r.id and rr.framework_item_id=i.id and rr.selected_option_id is not null)
        ) or (v.overall_judgement_required and r.overall_judgement_option_id is null) then 'in_progress' else 'complete' end as completion,
        not (coalesce(current_ta.decision='include', false) and coalesce(current_ft.decision='include', false)) as historical_eligibility,
        (select count(*)::int
         from appraisal_revision_response_evidence l
         left join lateral (select d.decision from evidence_review_decisions d where d.project_id=l.project_id and d.evidence_id=l.evidence_id order by d.sequence desc limit 1) current_review on true
         where l.project_id=r.project_id and l.revision_id=r.id
           and l.evidence_review_state_at_save is distinct from coalesce(current_review.decision, 'unreviewed')) as current_warning_count
      from appraisal_revisions r
      join appraisal_framework_versions v on v.project_id=r.project_id and v.id=r.framework_version_id
      left join appraisal_framework_overall_judgement_options o on o.project_id=r.project_id and o.framework_version_id=r.framework_version_id and o.id=r.overall_judgement_option_id
      left join current_ta on current_ta.project_id=r.project_id and current_ta.paper_id=r.paper_id
      left join current_ft on current_ft.project_id=r.project_id and current_ft.paper_id=r.paper_id
      where r.project_id=${projectId} and r.paper_id=${paperId} and r.framework_id=${frameworkId} and r.finalized_at is not null
      order by r.revision_number desc
      limit ${pageSize} offset ${offset}
    `));
    const revisions = revisionRows.map((row) => ({
      id: stringValue(row.id),
      revisionNumber: numberValue(row.revision_number),
      frameworkVersionId: stringValue(row.framework_version_id),
      versionNumber: numberValue(row.version_number),
      versionLabel: stringValue(row.version_label),
      overallJudgementLabel: nullableString(row.overall_judgement_label),
      createdAt: dateValue(row.created_at),
      finalizedAt: dateValue(row.finalized_at),
      completion: stringValue(row.completion) as AppraisalHistorySummary["completion"],
      historicalEligibility: Boolean(row.historical_eligibility),
      currentWarningCount: numberValue(row.current_warning_count),
    } satisfies AppraisalHistorySummary));
    return { paperId, frameworkId, page, pageSize, revisions, currentRevision: revisions[0] ?? null };
  }

  async function listPaperEvidence(projectId: string, paperId: string, input: { search?: string; page?: number; pageSize?: number } = {}) {
    await dependencies.requirePaper(projectId, paperId); await requireProject(projectId);
    const page = input.page ?? 1; const pageSize = Math.min(input.pageSize ?? 25, 50); const offset = (page - 1) * pageSize; const search = input.search?.trim() ?? "";
    const result = rows(await db.execute(sql`
      select e.id, e.paper_id, e.source_text, e.page_number, e.note, e.created_at,
        coalesce(current_review.decision, 'unreviewed') as review_state, current_review.id as review_decision_id,
        count(*) over() as total_count
      from evidence e
      left join lateral (select d.id, d.decision from evidence_review_decisions d where d.project_id=e.project_id and d.evidence_id=e.id order by d.sequence desc limit 1) current_review on true
      where e.project_id=${projectId} and e.paper_id=${paperId}
        and (${search} = '' or e.source_text ilike ${`%${search}%`} or coalesce(e.note,'') ilike ${`%${search}%`})
      order by e.page_number, e.created_at, e.id limit ${pageSize} offset ${offset}
    `));
    return { evidence: result.map((row) => ({ id: stringValue(row.id), paperId, sourceText: stringValue(row.source_text), pageNumber: numberValue(row.page_number), note: nullableString(row.note), reviewState: stringValue(row.review_state), reviewDecisionId: nullableString(row.review_decision_id), createdAt: dateValue(row.created_at) })), page, pageSize, totalCount: numberValue(result[0]?.total_count) };
  }

  async function listPaperAppraisalStatus(projectId: string, input: { page?: number; pageSize?: number; frameworkId?: string; baseState?: string; paperTitle?: string; attention?: string } = {}) {
    ensureUuid(projectId, "Project");
    const page = input.page ?? 1; const pageSize = Math.min(input.pageSize ?? 50, 50); const offset = (page - 1) * pageSize;
    const frameworkFilter = input.frameworkId ?? null; const titleFilter = input.paperTitle?.trim() ?? ""; const baseFilter = input.baseState ?? null; const attention = input.attention ?? null;
    const result = rows(await db.execute(sql`
      with current_ta as (
        select distinct on (project_id, paper_id) project_id, paper_id, id, decision from screening_decisions
        where project_id=${projectId} and stage='title_abstract' order by project_id, paper_id, sequence desc
      ), current_ft as (
        select distinct on (project_id, paper_id) project_id, paper_id, id, decision from full_text_screening_decisions
        where project_id=${projectId} order by project_id, paper_id, sequence desc
      ), included as (
        select t.project_id, t.paper_id from current_ta t join current_ft f on f.project_id=t.project_id and f.paper_id=t.paper_id where t.decision='include' and f.decision='include'
      ), latest_versions as (
        select distinct on (project_id, framework_id) * from appraisal_framework_versions where project_id=${projectId} and finalized_at is not null order by project_id, framework_id, version_number desc
      ), active_frameworks as (
        select f.*, v.id as latest_version_id, v.version_number as latest_version_number, v.version_label as latest_version_label
        from appraisal_frameworks f join latest_versions v on v.project_id=f.project_id and v.framework_id=f.id where f.archived_at is null
      ), pairs as (
        select i.paper_id, af.id as framework_id from included i cross join active_frameworks af
        union
        select a.paper_id, a.framework_id from appraisals a where a.project_id=${projectId}
      ), latest_revisions as (
        select distinct on (r.project_id, r.appraisal_id) r.* from appraisal_revisions r where r.project_id=${projectId} and r.finalized_at is not null order by r.project_id, r.appraisal_id, r.revision_number desc
      ), rows_with_state as (
        select p.id as paper_id, p.title as paper_title, f.id as framework_id, f.name as framework_name, f.archived_at,
          a.id as appraisal_id, r.id as revision_id, r.revision_number, r.framework_version_id, rv.version_number, rv.version_label,
          coalesce(af.latest_version_number, rv.version_number, 0) as latest_available_version_number,
          case when r.id is null then 'not_started'
            when exists (select 1 from appraisal_framework_items i where i.project_id=r.project_id and i.framework_version_id=r.framework_version_id and i.required=true and not exists (select 1 from appraisal_revision_responses rr where rr.project_id=r.project_id and rr.revision_id=r.id and rr.framework_item_id=i.id and rr.selected_option_id is not null))
              or (rv.overall_judgement_required and r.overall_judgement_option_id is null) then 'in_progress' else 'complete' end as base_state,
          overall.label as overall_judgement, r.created_at as last_saved_at,
          case when inc.paper_id is null then true else false end as historical,
          (f.archived_at is not null) as framework_archived,
          (af.latest_version_number is not null and r.id is not null and af.latest_version_number > rv.version_number) as newer_version_available
        from pairs pair
        join papers p on p.project_id=${projectId} and p.id=pair.paper_id
        join appraisal_frameworks f on f.project_id=${projectId} and f.id=pair.framework_id
        left join appraisals a on a.project_id=${projectId} and a.paper_id=pair.paper_id and a.framework_id=pair.framework_id
        left join latest_revisions r on r.project_id=a.project_id and r.appraisal_id=a.id
        left join appraisal_framework_versions rv on rv.project_id=r.project_id and rv.id=r.framework_version_id
        left join active_frameworks af on af.project_id=f.project_id and af.id=f.id
        left join appraisal_framework_versions lv on lv.project_id=af.project_id and lv.id=af.latest_version_id
        left join appraisal_framework_overall_judgement_options overall on overall.project_id=r.project_id and overall.framework_version_id=r.framework_version_id and overall.id=r.overall_judgement_option_id
        left join included inc on inc.project_id=p.project_id and inc.paper_id=p.id
      ), filtered_rows as (
        select rows_with_state.*, count(*) over() as total_count
        from rows_with_state
        where (${frameworkFilter}::uuid is null or framework_id=${frameworkFilter}::uuid)
          and (${titleFilter} = '' or paper_title ilike ${`%${titleFilter}%`})
          and (${baseFilter}::text is null or base_state=${baseFilter}::text)
          and (${attention}::text is null or (${attention}::text='historical' and historical) or (${attention}::text='archived' and framework_archived) or (${attention}::text='newer' and newer_version_available))
      )
      select * from filtered_rows
      order by paper_title, framework_name, paper_id, framework_id
      limit ${pageSize} offset ${offset}
    `));
    return {
      rows: result.map((row) => ({ paperId: stringValue(row.paper_id), paperTitle: stringValue(row.paper_title), frameworkId: stringValue(row.framework_id), frameworkName: stringValue(row.framework_name), appraisalId: nullableString(row.appraisal_id), revisionId: nullableString(row.revision_id), revisionNumber: row.revision_number == null ? null : numberValue(row.revision_number), frameworkVersionId: nullableString(row.framework_version_id), versionNumber: row.version_number == null ? null : numberValue(row.version_number), versionLabel: nullableString(row.version_label), latestAvailableVersionNumber: numberValue(row.latest_available_version_number), baseState: stringValue(row.base_state) as AppraisalStatusRow["baseState"], overallJudgement: nullableString(row.overall_judgement), lastSavedAt: row.last_saved_at as Date | null, historical: Boolean(row.historical), frameworkArchived: Boolean(row.framework_archived), newerVersionAvailable: Boolean(row.newer_version_available) } satisfies AppraisalStatusRow)),
      page,
      pageSize,
      totalCount: numberValue(result[0]?.total_count),
    };
  }

  async function saveAppraisalRevision(projectId: string, input: unknown) {
    await requireProject(projectId);
    const values = validate(saveAppraisalRevisionSchema, input) as SaveAppraisalRevisionInput;
    ensureUuid(values.paperId, "Paper"); ensureUuid(values.frameworkId, "Framework"); ensureUuid(values.frameworkVersionId, "Framework version");
    if (values.responses.some((response) => {
      const evidenceIds = response.evidenceIds ?? [];
      return new Set(evidenceIds).size !== evidenceIds.length;
    })) throw new DomainError("VALIDATION_ERROR", "Evidence cannot be repeated within one appraisal response");
    let saved: string;
    try {
      saved = await db.transaction(async (tx) => {
      // Canonical appraisal write lock order: Paper -> Framework -> FrameworkVersion
      // -> Appraisal -> Evidence rows in UUID order -> revision children.
      const paper = rows(await tx.execute(sql`select id from papers where project_id=${projectId} and id=${values.paperId} for update`))[0];
      if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
      const eligibility = await latestEligibility(tx, projectId, values.paperId);
      if (!eligibility.included || !eligibility.titleAbstract || !eligibility.fullText) throw new DomainError("VALIDATION_ERROR", "New appraisal revisions require current final inclusion");
      const frameworkRow = await lockFramework(tx, projectId, values.frameworkId); ensureNotArchived(frameworkRow);
      const versionRow = await lockVersion(tx, projectId, values.frameworkVersionId);
      if (versionRow.framework_id !== values.frameworkId) throw new DomainError("CROSS_PROJECT_REFERENCE", "Framework version does not belong to the framework");
      if (versionRow.finalized_at == null) throw new DomainError("VALIDATION_ERROR", "Appraisal revisions require a finalized framework version");
      const detail = await readFrameworkVersionWithExecutor(tx, projectId, values.frameworkVersionId);
      const itemById = new Map(detail.items.map((item) => [item.id, item]));
      if (values.responses.length !== detail.items.length) throw new DomainError("VALIDATION_ERROR", "The appraisal snapshot must include every framework item exactly once");
      const responseByItem = new Map<string, SaveAppraisalRevisionInput["responses"][number]>();
      for (const response of values.responses) {
        if (responseByItem.has(response.itemId)) throw new DomainError("VALIDATION_ERROR", "The appraisal snapshot cannot repeat a framework item");
        const item = itemById.get(response.itemId);
        if (!item) throw new DomainError("CROSS_PROJECT_REFERENCE", "Appraisal response item does not belong to the exact framework version");
        if (response.selectedOptionId != null && !item.options.some((option) => option.id === response.selectedOptionId)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Selected response option does not belong to the exact framework item");
        responseByItem.set(response.itemId, response);
      }
      for (const item of detail.items) if (!responseByItem.has(item.id)) throw new DomainError("VALIDATION_ERROR", "The appraisal snapshot must include every framework item exactly once");
      const overallJudgementOptionId = values.overallJudgementOptionId ?? null;
      if (overallJudgementOptionId != null && !detail.overallOptions.some((option) => option.id === overallJudgementOptionId)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Overall judgement option does not belong to the exact framework version");
      await tx.execute(sql`insert into appraisals (project_id, paper_id, framework_id) values (${projectId},${values.paperId},${values.frameworkId}) on conflict (project_id,paper_id,framework_id) do nothing`);
      const appraisal = rows(await tx.execute(sql`select * from appraisals where project_id=${projectId} and paper_id=${values.paperId} and framework_id=${values.frameworkId} for update`))[0];
      const previous = rows(await tx.execute(sql`select * from appraisal_revisions where project_id=${projectId} and appraisal_id=${appraisal.id} and finalized_at is not null order by revision_number desc limit 1`))[0] ?? null;
      const expected = values.expectedCurrentRevisionId;
      if ((previous ? stringValue(previous.id) : null) !== expected) throw new DomainError("CONCURRENT_MODIFICATION", "The appraisal has a newer revision; reload before saving");
      const latestVersionRow = await latestFinalizedVersion(tx, projectId, values.frameworkId);
      if (!latestVersionRow) throw new DomainError("VALIDATION_ERROR", "A finalized framework version is required before appraisal");
      if (!previous && stringValue(latestVersionRow.id) !== values.frameworkVersionId) throw new DomainError("VALIDATION_ERROR", "The first appraisal revision must use the latest finalized framework version");
      if (previous) {
        const previousVersion = await lockVersion(tx, projectId, stringValue(previous.framework_version_id), false);
        if (numberValue(versionRow.version_number) < numberValue(previousVersion.version_number)) throw new DomainError("VALIDATION_ERROR", "Framework version movement is monotonic; a lower version cannot become current");
        if (numberValue(versionRow.version_number) === numberValue(previousVersion.version_number) && stringValue(versionRow.id) !== stringValue(previousVersion.id)) throw new DomainError("VALIDATION_ERROR", "An appraisal revision must keep its current framework version");
        if (numberValue(versionRow.version_number) > numberValue(previousVersion.version_number) && stringValue(latestVersionRow.id) !== values.frameworkVersionId) throw new DomainError("VALIDATION_ERROR", "A reassessment must use the latest finalized framework version");
      }
      const evidenceIds = [...new Set(values.responses.flatMap((response) => response.evidenceIds ?? []))].sort();
      const evidenceSnapshots = new Map<string, { decisionId: string | null; state: "unreviewed" | "needs_review" | "accepted" | "rejected" }>();
      for (const evidenceId of evidenceIds) {
        const evidence = rows(await tx.execute(sql`select id, paper_id from evidence where project_id=${projectId} and id=${evidenceId} for update`))[0];
        if (!evidence) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
        if (stringValue(evidence.paper_id) !== values.paperId) throw new DomainError("CROSS_PROJECT_REFERENCE", "Appraisal Evidence must belong to the same Paper");
        const review = rows(await tx.execute(sql`select id, decision from evidence_review_decisions where project_id=${projectId} and evidence_id=${evidenceId} order by sequence desc limit 1`))[0] ?? null;
        const state = (review ? stringValue(review.decision) : "unreviewed") as "unreviewed" | "needs_review" | "accepted" | "rejected";
        evidenceSnapshots.set(evidenceId, { decisionId: review ? stringValue(review.id) : null, state });
      }
      const revisionNumber = previous ? numberValue(previous.revision_number) + 1 : 1;
      const revision = rows(await tx.execute(sql`
        insert into appraisal_revisions (revision_number, project_id, paper_id, framework_id, appraisal_id, framework_version_id, title_abstract_decision_id, full_text_decision_id, overall_judgement_option_id, overall_rationale)
        values (${revisionNumber},${projectId},${values.paperId},${values.frameworkId},${appraisal.id},${values.frameworkVersionId},${eligibility.titleAbstract.id},${eligibility.fullText.id},${overallJudgementOptionId},${values.overallRationale ?? null}) returning *
      `))[0];
      for (const item of detail.items) {
        const response = responseByItem.get(item.id)!;
        const responseRow = rows(await tx.execute(sql`
          insert into appraisal_revision_responses (project_id, revision_id, framework_version_id, framework_item_id, selected_option_id, rationale)
          values (${projectId},${revision.id},${values.frameworkVersionId},${item.id},${response.selectedOptionId ?? null},${response.rationale ?? null}) returning *
        `))[0];
        for (const evidenceId of response.evidenceIds ?? []) {
          const snapshot = evidenceSnapshots.get(evidenceId)!;
          await tx.execute(sql`
            insert into appraisal_revision_response_evidence (project_id, paper_id, framework_id, appraisal_id, revision_id, framework_version_id, framework_item_id, response_id, evidence_id, evidence_review_decision_id_at_save, evidence_review_state_at_save)
            values (${projectId},${values.paperId},${values.frameworkId},${appraisal.id},${revision.id},${values.frameworkVersionId},${item.id},${responseRow.id},${evidenceId},${snapshot.decisionId},${snapshot.state})
          `);
        }
      }
      await tx.execute(sql`update appraisal_revisions set finalized_at=now() where project_id=${projectId} and id=${revision.id}`);
        return stringValue(revision.id);
      });
    } catch (error) {
      if (isConstraintError(error)) throw new DomainError("VALIDATION_ERROR", "Appraisal revision violates the current eligibility, Evidence, or exact framework-version invariants");
      throw error;
    }
    return readAppraisalRevision(projectId, saved);
  }

  return {
    createAppraisalFramework,
    listAppraisalFrameworks,
    readFrameworkVersion,
    updateFrameworkDraftMetadata,
    addFrameworkSection,
    updateFrameworkSection,
    reorderFrameworkSections,
    removeFrameworkSection,
    addFrameworkItem,
    updateFrameworkItem,
    reorderFrameworkItems,
    removeFrameworkItem,
    addFrameworkResponseOption,
    updateFrameworkResponseOption,
    reorderFrameworkResponseOptions,
    removeFrameworkResponseOption,
    setFrameworkOverallJudgementOptions,
    reorderFrameworkOverallJudgementOptions,
    finalizeFrameworkVersion,
    createNewFrameworkVersion,
    archiveAppraisalFramework,
    saveAppraisalRevision,
    listPaperAppraisalStatus,
    readPaperAppraisal,
    readAppraisalHistory,
    readAppraisalRevision,
    listPaperEvidence,
  };
}
