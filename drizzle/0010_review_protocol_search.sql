-- Slice 9: review protocol questions and auditable search retrieval.
-- The migration is transactional under Drizzle.  The project question is
-- copied byte-for-byte before the legacy column is dropped.
CREATE TABLE "research_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "identifier" text NOT NULL,
  "label" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "research_questions_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "research_questions_project_identifier_unique" UNIQUE("project_id", "identifier"),
  CONSTRAINT "research_questions_identifier_nonblank" CHECK (btrim("identifier") <> ''),
  CONSTRAINT "research_questions_label_nonblank" CHECK (btrim("label") <> ''),
  CONSTRAINT "research_questions_sort_order_valid" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "research_questions" ADD CONSTRAINT "research_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Older development snapshots briefly used a project INSERT trigger for source
-- seeding. Remove it so SearchSource seeding has one application/migration
-- definition and cannot double-insert rows on upgrade.
DROP TRIGGER IF EXISTS projects_seed_builtin_search_sources ON "projects";
DROP FUNCTION IF EXISTS seed_builtin_search_sources();
--> statement-breakpoint
CREATE UNIQUE INDEX "research_questions_project_identifier_active_unique"
  ON "research_questions" USING btree ("project_id", lower(btrim("identifier")))
  WHERE "archived_at" IS NULL;
--> statement-breakpoint
INSERT INTO "research_questions" ("project_id", "identifier", "label", "sort_order", "created_at", "updated_at")
SELECT "id", 'RQ1', "research_question", 0, "created_at", "updated_at"
FROM "projects"
WHERE "research_question" IS NOT NULL AND btrim("research_question") <> '';
--> statement-breakpoint
DO $function$
DECLARE
  legacy_count bigint;
  migrated_count bigint;
  mismatch_count bigint;
BEGIN
  SELECT count(*) INTO legacy_count FROM "projects" WHERE "research_question" IS NOT NULL AND btrim("research_question") <> '';
  SELECT count(*) INTO migrated_count FROM "research_questions";
  IF legacy_count <> migrated_count THEN
    RAISE EXCEPTION 'ResearchQuestion backfill count mismatch: expected %, got %', legacy_count, migrated_count;
  END IF;
  SELECT count(*) INTO mismatch_count
  FROM "projects" p
  WHERE p."research_question" IS NOT NULL AND btrim(p."research_question") <> ''
    AND NOT EXISTS (
      SELECT 1 FROM "research_questions" q
      WHERE q."project_id" = p."id" AND q."identifier" = 'RQ1' AND q."label" = p."research_question"
    );
  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'ResearchQuestion backfill has % exact-text mismatches', mismatch_count;
  END IF;
END;
$function$;
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "research_question";
--> statement-breakpoint

CREATE TABLE "search_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "source_key" text NOT NULL,
  "display_name" text NOT NULL,
  "base_url" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "search_sources_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "search_sources_project_source_key_unique" UNIQUE("project_id", "source_key"),
  CONSTRAINT "search_sources_source_key_nonblank" CHECK (btrim("source_key") <> ''),
  CONSTRAINT "search_sources_display_name_nonblank" CHECK (btrim("display_name") <> ''),
  CONSTRAINT "search_sources_base_url_nonblank" CHECK ("base_url" IS NULL OR btrim("base_url") <> ''),
  CONSTRAINT "search_sources_notes_nonblank" CHECK ("notes" IS NULL OR btrim("notes") <> '')
);
--> statement-breakpoint
ALTER TABLE "search_sources" ADD CONSTRAINT "search_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Keep this definition in lockstep with SEARCH_SOURCE_DEFINITIONS in the
-- domain normalization module. New projects are seeded by the application
-- from that shared definition; this migration backfills existing projects.
INSERT INTO "search_sources" ("project_id", "source_key", "display_name")
SELECT p."id", d."source_key", d."display_name"
FROM "projects" p
CROSS JOIN (VALUES
  ('scopus', 'Scopus'),
  ('web_of_science', 'Web of Science'),
  ('ieee_xplore', 'IEEE Xplore'),
  ('pubmed', 'PubMed'),
  ('google_scholar', 'Google Scholar'),
  ('openalex', 'OpenAlex'),
  ('semantic_scholar', 'Semantic Scholar'),
  ('manual', 'Manual')
) AS d("source_key", "display_name")
ON CONFLICT ("project_id", "source_key") DO NOTHING;
--> statement-breakpoint

CREATE TABLE "search_strategies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "search_source_id" uuid NOT NULL,
  "name" text NOT NULL,
  "query_text" text NOT NULL,
  "filters_text" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "search_strategies_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "search_strategies_name_nonblank" CHECK (btrim("name") <> ''),
  CONSTRAINT "search_strategies_query_text_nonblank" CHECK (btrim("query_text") <> ''),
  CONSTRAINT "search_strategies_filters_text_nonblank" CHECK ("filters_text" IS NULL OR btrim("filters_text") <> ''),
  CONSTRAINT "search_strategies_notes_nonblank" CHECK ("notes" IS NULL OR btrim("notes") <> '')
);
--> statement-breakpoint
ALTER TABLE "search_strategies" ADD CONSTRAINT "search_strategies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_strategies" ADD CONSTRAINT "search_strategies_project_source_fk" FOREIGN KEY ("project_id", "search_source_id") REFERENCES "public"."search_sources"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "search_strategies_project_created_at_idx" ON "search_strategies" USING btree ("project_id", "created_at");
--> statement-breakpoint

CREATE TABLE "search_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "search_source_id" uuid NOT NULL,
  "source_key_snapshot" text NOT NULL,
  "source_display_name_snapshot" text NOT NULL,
  "strategy_id" uuid NOT NULL,
  "query_text" text NOT NULL,
  "filters_text_snapshot" text,
  "reported_result_count" integer NOT NULL,
  "executed_at" timestamp with time zone NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "search_runs_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "search_runs_project_id_id_source_unique" UNIQUE("project_id", "id", "search_source_id"),
  CONSTRAINT "search_runs_source_key_snapshot_nonblank" CHECK (btrim("source_key_snapshot") <> ''),
  CONSTRAINT "search_runs_source_display_name_snapshot_nonblank" CHECK (btrim("source_display_name_snapshot") <> ''),
  CONSTRAINT "search_runs_query_text_nonblank" CHECK (btrim("query_text") <> ''),
  CONSTRAINT "search_runs_reported_result_count_valid" CHECK ("reported_result_count" >= 0),
  CONSTRAINT "search_runs_filters_text_snapshot_nonblank" CHECK ("filters_text_snapshot" IS NULL OR btrim("filters_text_snapshot") <> ''),
  CONSTRAINT "search_runs_notes_nonblank" CHECK ("notes" IS NULL OR btrim("notes") <> '')
);
--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_project_source_fk" FOREIGN KEY ("project_id", "search_source_id") REFERENCES "public"."search_sources"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_project_strategy_fk" FOREIGN KEY ("project_id", "strategy_id") REFERENCES "public"."search_strategies"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "search_runs_project_sequence_idx" ON "search_runs" USING btree ("project_id", "sequence");
--> statement-breakpoint
CREATE INDEX "search_runs_project_source_sequence_idx" ON "search_runs" USING btree ("project_id", "search_source_id", "sequence");
--> statement-breakpoint

CREATE TABLE "retrieved_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "search_run_id" uuid NOT NULL,
  "search_source_id" uuid NOT NULL,
  "source_record_id" text,
  "title" text NOT NULL,
  "authors" text[] DEFAULT '{}' NOT NULL,
  "abstract" text,
  "doi" text,
  "url" text,
  "publication_year" integer,
  "venue" text,
  "raw_citation" text,
  "retrieved_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "retrieved_records_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "retrieved_records_source_record_id_nonblank" CHECK ("source_record_id" IS NULL OR btrim("source_record_id") <> ''),
  CONSTRAINT "retrieved_records_title_nonblank" CHECK (btrim("title") <> ''),
  CONSTRAINT "retrieved_records_publication_year_valid" CHECK ("publication_year" IS NULL OR ("publication_year" >= 1000 AND "publication_year" <= 3000)),
  CONSTRAINT "retrieved_records_venue_nonblank" CHECK ("venue" IS NULL OR btrim("venue") <> '')
);
--> statement-breakpoint
ALTER TABLE "retrieved_records" ADD CONSTRAINT "retrieved_records_project_search_run_fk" FOREIGN KEY ("project_id", "search_run_id") REFERENCES "public"."search_runs"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "retrieved_records" ADD CONSTRAINT "retrieved_records_project_source_fk" FOREIGN KEY ("project_id", "search_source_id") REFERENCES "public"."search_sources"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "retrieved_records" ADD CONSTRAINT "retrieved_records_project_run_source_fk" FOREIGN KEY ("project_id", "search_run_id", "search_source_id") REFERENCES "public"."search_runs"("project_id", "id", "search_source_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "retrieved_records_project_run_source_record_unique"
  ON "retrieved_records" USING btree ("project_id", "search_run_id", "search_source_id", "source_record_id")
  WHERE "source_record_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "retrieved_record_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "retrieved_record_id" uuid NOT NULL,
  "paper_id" uuid NOT NULL,
  "action" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "retrieved_record_matches_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "retrieved_record_matches_action_valid" CHECK ("action" IN ('linked', 'unlinked'))
);
--> statement-breakpoint
ALTER TABLE "retrieved_record_matches" ADD CONSTRAINT "retrieved_record_matches_project_record_fk" FOREIGN KEY ("project_id", "retrieved_record_id") REFERENCES "public"."retrieved_records"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "retrieved_record_matches" ADD CONSTRAINT "retrieved_record_matches_project_paper_fk" FOREIGN KEY ("project_id", "paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "retrieved_record_matches_project_record_sequence_idx" ON "retrieved_record_matches" USING btree ("project_id", "retrieved_record_id", "sequence");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_search_source_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SearchSources are archived, not deleted'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SearchSource identity is immutable';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    IF NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.base_url IS DISTINCT FROM OLD.base_url OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.updated_at IS DISTINCT FROM OLD.updated_at OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'Archived SearchSources cannot be changed or restored';
    END IF;
  ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND NEW.archived_at < OLD.created_at THEN
    RAISE EXCEPTION 'SearchSource archive timestamp must follow creation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER search_sources_mutation_guard BEFORE UPDATE OR DELETE ON "search_sources" FOR EACH ROW EXECUTE FUNCTION prevent_search_source_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_search_strategy_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SearchStrategies are archived, not deleted'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.search_source_id IS DISTINCT FROM OLD.search_source_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SearchStrategy identity is immutable';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    IF NEW.name IS DISTINCT FROM OLD.name OR NEW.query_text IS DISTINCT FROM OLD.query_text OR NEW.filters_text IS DISTINCT FROM OLD.filters_text OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.updated_at IS DISTINCT FROM OLD.updated_at OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'Archived SearchStrategies cannot be changed or restored';
    END IF;
  ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND NEW.archived_at < OLD.created_at THEN
    RAISE EXCEPTION 'SearchStrategy archive timestamp must follow creation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER search_strategies_mutation_guard BEFORE UPDATE OR DELETE ON "search_strategies" FOR EACH ROW EXECUTE FUNCTION prevent_search_strategy_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_search_run_source_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE expected_key text; expected_name text;
BEGIN
  SELECT source_key, display_name INTO expected_key, expected_name FROM search_sources
  WHERE project_id = NEW.project_id AND id = NEW.search_source_id;
  IF expected_key IS NULL THEN RAISE EXCEPTION 'SearchRun source must belong to the Project'; END IF;
  IF NEW.source_key_snapshot IS DISTINCT FROM expected_key OR NEW.source_display_name_snapshot IS DISTINCT FROM expected_name THEN
    RAISE EXCEPTION 'SearchRun source snapshots must match SearchSource identity at creation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM search_strategies WHERE project_id = NEW.project_id AND id = NEW.strategy_id AND search_source_id = NEW.search_source_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'SearchRun strategy must belong to the Project, match the source, and be active';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER search_runs_source_snapshot_guard BEFORE INSERT ON "search_runs" FOR EACH ROW EXECUTE FUNCTION validate_search_run_source_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_search_run_mutation() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN RAISE EXCEPTION 'SearchRuns are immutable'; END;
$function$;
--> statement-breakpoint
CREATE TRIGGER search_runs_append_only BEFORE UPDATE OR DELETE ON "search_runs" FOR EACH ROW EXECUTE FUNCTION prevent_search_run_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_retrieved_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN RAISE EXCEPTION 'RetrievedRecords are immutable'; END;
$function$;
--> statement-breakpoint
CREATE TRIGGER retrieved_records_append_only BEFORE UPDATE OR DELETE ON "retrieved_records" FOR EACH ROW EXECUTE FUNCTION prevent_retrieved_record_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_retrieved_record_match_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE latest_action text; latest_paper_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'RetrievedRecordMatches are append-only'; END IF;
  -- Serialize all transitions for a record, including direct SQL writers.
  PERFORM 1 FROM retrieved_records WHERE project_id = NEW.project_id AND id = NEW.retrieved_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RetrievedRecord does not belong to the Project'; END IF;
  SELECT action, paper_id INTO latest_action, latest_paper_id FROM retrieved_record_matches
  WHERE project_id = NEW.project_id AND retrieved_record_id = NEW.retrieved_record_id
  ORDER BY sequence DESC LIMIT 1;
  IF NEW.action = 'linked' AND latest_action = 'linked' THEN RAISE EXCEPTION 'RetrievedRecord is already linked to a Paper'; END IF;
  IF NEW.action = 'unlinked' AND (latest_action IS DISTINCT FROM 'linked' OR latest_paper_id IS DISTINCT FROM NEW.paper_id) THEN RAISE EXCEPTION 'RetrievedRecord match can only unlink its current Paper'; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER retrieved_record_matches_state_guard BEFORE INSERT OR UPDATE OR DELETE ON "retrieved_record_matches" FOR EACH ROW EXECUTE FUNCTION prevent_retrieved_record_match_mutation();
--> statement-breakpoint

-- Comparison-only, partial indexes: canonical DOI/title values remain exactly
-- as entered.  The expressions intentionally do only conservative cleanup.
CREATE INDEX "papers_project_doi_comparison_idx"
  ON "papers" USING btree ("project_id", lower(regexp_replace(regexp_replace(btrim("doi"), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))
  WHERE "doi" IS NOT NULL AND btrim("doi") <> '';
--> statement-breakpoint
CREATE INDEX "papers_project_title_comparison_idx"
  ON "papers" USING btree ("project_id", lower(regexp_replace(btrim("title"), '[[:space:]]+', ' ', 'g')), "publication_year")
  WHERE "title" IS NOT NULL AND btrim("title") <> '';
--> statement-breakpoint
CREATE INDEX "retrieved_records_project_doi_comparison_idx"
  ON "retrieved_records" USING btree ("project_id", lower(regexp_replace(regexp_replace(btrim("doi"), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))
  WHERE "doi" IS NOT NULL AND btrim("doi") <> '';
--> statement-breakpoint
CREATE INDEX "retrieved_records_project_title_comparison_idx"
  ON "retrieved_records" USING btree ("project_id", lower(regexp_replace(btrim("title"), '[[:space:]]+', ' ', 'g')), "publication_year")
  WHERE "title" IS NOT NULL AND btrim("title") <> '';
