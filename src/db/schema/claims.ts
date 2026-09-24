import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  foreignKey,
  primaryKey,
  check,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./foundation";
import { evidence } from "./documents-evidence";
import { extractionValueRevisions } from "./extraction";
import { synthesisRevisions } from "./synthesis";

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("claims_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("claims_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const claimRevisions = pgTable(
  "claim_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    state: text("state").notNull().default("active"),
    claimText: text("claim_text"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("claim_revisions_project_id_id_unique").on(table.projectId, table.id),
    claimIdentity: unique("claim_revisions_project_claim_id_id_unique").on(table.projectId, table.claimId, table.id),
    claimSequence: index("claim_revisions_project_claim_sequence_idx").on(table.projectId, table.claimId, table.sequence),
    projectSequence: index("claim_revisions_project_sequence_idx").on(table.projectId, table.sequence),
    claimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "claim_revisions_project_claim_fk",
    }).onDelete("restrict"),
    stateValid: check("claim_revisions_state_valid", sql`${table.state} in ('active', 'withdrawn')`),
    claimTextShape: check("claim_revisions_claim_text_shape", sql`(
      (${table.state} = 'active' and ${table.claimText} is not null and btrim(${table.claimText}) <> '')
      or (${table.state} = 'withdrawn' and ${table.claimText} is null)
    )`),
    noteNonblank: check("claim_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const claimRevisionEvidenceSupports = pgTable(
  "claim_revision_evidence_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.evidenceId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_evidence_supports_project_revision_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "claim_revision_evidence_supports_project_evidence_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_evidence_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    evidenceLookup: index("claim_revision_evidence_supports_project_evidence_idx").on(table.projectId, table.evidenceId),
  }),
);

export const claimRevisionExtractionSupports = pgTable(
  "claim_revision_extraction_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.extractionRevisionId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_extraction_supports_project_revision_fk",
    }).onDelete("restrict"),
    extractionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.extractionRevisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id],
      name: "claim_revision_extraction_supports_project_extraction_revision_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_extraction_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    extractionRevisionLookup: index("claim_revision_extraction_supports_project_extraction_revision_idx").on(table.projectId, table.extractionRevisionId),
  }),
);

export const claimRevisionSynthesisSupports = pgTable(
  "claim_revision_synthesis_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.synthesisRevisionId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_synthesis_supports_project_revision_fk",
    }).onDelete("restrict"),
    synthesisRevisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id],
      name: "claim_revision_synthesis_supports_project_synthesis_revision_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_synthesis_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    synthesisRevisionLookup: index("claim_revision_synthesis_supports_project_synthesis_revision_idx").on(table.projectId, table.synthesisRevisionId),
  }),
);
