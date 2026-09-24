import {
  integer,
  index,
  pgTable,
  text,
  unique,
  uuid,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./shared";

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
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
    doiComparison: index("papers_project_doi_comparison_idx")
      .using("btree", table.projectId, sql`lower(regexp_replace(regexp_replace(btrim(${table.doi}), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))`)
      .where(sql`${table.doi} is not null and btrim(${table.doi}) <> ''`),
    titleComparison: index("papers_project_title_comparison_idx")
      .using("btree", table.projectId, sql`lower(regexp_replace(btrim(${table.title}), '[[:space:]]+', ' ', 'g'))`, table.publicationYear)
      .where(sql`${table.title} is not null and btrim(${table.title}) <> ''`),
    titleNonblank: check("papers_title_nonblank", sql`btrim(${table.title}) <> ''`),
  }),
);
