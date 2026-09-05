import {
  integer,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  foreignKey,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  researchQuestion: text("research_question"),
  ...timestamps,
}, (table) => ({
  titleNonblank: check("projects_title_nonblank", sql`btrim(${table.title}) <> ''`),
}));

export const papers = pgTable(
  "papers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    authors: text("authors").array().notNull().default([]),
    publicationYear: integer("publication_year"),
    venue: text("venue"),
    doi: text("doi"),
    abstract: text("abstract"),
    bibliographicNote: text("bibliographic_note"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("papers_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("papers_project_created_at_idx").on(table.projectId, table.createdAt),
    titleNonblank: check("papers_title_nonblank", sql`btrim(${table.title}) <> ''`),
  }),
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    sourceText: text("source_text").notNull(),
    pageNumber: integer("page_number").notNull(),
    note: text("note"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("evidence_project_id_id_unique").on(table.projectId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "evidence_project_paper_fk",
    }).onDelete("restrict"),
    projectPaperCreatedAt: index("evidence_project_paper_created_at_idx").on(
      table.projectId,
      table.paperId,
      table.createdAt,
    ),
    sourceTextNonblank: check("evidence_source_text_nonblank", sql`btrim(${table.sourceText}) <> ''`),
    pagePositive: check("evidence_page_positive", sql`${table.pageNumber} > 0`),
  }),
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    claimText: text("claim_text").notNull(),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("claims_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("claims_project_created_at_idx").on(table.projectId, table.createdAt),
    claimTextNonblank: check("claims_text_nonblank", sql`btrim(${table.claimText}) <> ''`),
  }),
);

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    projectId: uuid("project_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimId, table.evidenceId] }),
    claimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "claim_evidence_project_claim_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "claim_evidence_project_evidence_fk",
    }).onDelete("restrict"),
    claimLookup: index("claim_evidence_project_claim_idx").on(table.projectId, table.claimId),
    evidenceLookup: index("claim_evidence_project_evidence_idx").on(table.projectId, table.evidenceId),
  }),
);

export const schema = { projects, papers, evidence, claims, claimEvidence };
