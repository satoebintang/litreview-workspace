CREATE TABLE "synthesis_revision_supports" (
	"project_id" uuid NOT NULL,
	"synthesis_revision_id" uuid NOT NULL,
	"extraction_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_revision_supports_project_id_synthesis_revision_id_extraction_revision_id_pk" PRIMARY KEY("project_id","synthesis_revision_id","extraction_revision_id")
);
--> statement-breakpoint
CREATE TABLE "synthesis_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "synthesis_revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"synthesis_statement_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"title" text,
	"statement_text" text,
	"researcher_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "synthesis_revisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "synthesis_revisions_project_statement_id_id_unique" UNIQUE("project_id","synthesis_statement_id","id"),
	CONSTRAINT "synthesis_revisions_state_valid" CHECK ("synthesis_revisions"."state" in ('active', 'withdrawn')),
	CONSTRAINT "synthesis_revisions_title_nonblank" CHECK ("synthesis_revisions"."title" is null or btrim("synthesis_revisions"."title") <> ''),
	CONSTRAINT "synthesis_revisions_statement_shape" CHECK ((
      ("synthesis_revisions"."state" = 'active' and "synthesis_revisions"."statement_text" is not null and btrim("synthesis_revisions"."statement_text") <> '')
      or ("synthesis_revisions"."state" = 'withdrawn' and "synthesis_revisions"."statement_text" is null)
    )),
	CONSTRAINT "synthesis_revisions_note_nonblank" CHECK ("synthesis_revisions"."researcher_note" is null or btrim("synthesis_revisions"."researcher_note") <> '')
);
--> statement-breakpoint
CREATE TABLE "synthesis_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_statements_project_id_id_unique" UNIQUE("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "synthesis_revision_supports" ADD CONSTRAINT "synthesis_revision_supports_project_synthesis_revision_fk" FOREIGN KEY ("project_id","synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_revision_supports" ADD CONSTRAINT "synthesis_revision_supports_project_extraction_revision_fk" FOREIGN KEY ("project_id","extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_revisions" ADD CONSTRAINT "synthesis_revisions_project_statement_fk" FOREIGN KEY ("project_id","synthesis_statement_id") REFERENCES "public"."synthesis_statements"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_statements" ADD CONSTRAINT "synthesis_statements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synthesis_revision_supports_project_synthesis_revision_idx" ON "synthesis_revision_supports" USING btree ("project_id","synthesis_revision_id");--> statement-breakpoint
CREATE INDEX "synthesis_revision_supports_project_extraction_revision_idx" ON "synthesis_revision_supports" USING btree ("project_id","extraction_revision_id");--> statement-breakpoint
CREATE INDEX "synthesis_revisions_project_statement_sequence_idx" ON "synthesis_revisions" USING btree ("project_id","synthesis_statement_id","sequence");--> statement-breakpoint
CREATE INDEX "synthesis_revisions_project_sequence_idx" ON "synthesis_revisions" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE INDEX "synthesis_statements_project_created_at_idx" ON "synthesis_statements" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_synthesis_revision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'synthesis revisions must be finalized after creation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'synthesis revisions are append-only';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.synthesis_statement_id IS DISTINCT FROM OLD.synthesis_statement_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'synthesis revision identity is immutable';
  END IF;

  IF OLD.finalized_at IS NOT NULL THEN
    IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
      OR NEW.state IS DISTINCT FROM OLD.state
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.statement_text IS DISTINCT FROM OLD.statement_text
      OR NEW.researcher_note IS DISTINCT FROM OLD.researcher_note THEN
      RAISE EXCEPTION 'finalized synthesis revisions are immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.finalized_at IS NOT NULL
    AND NEW.state = 'withdrawn'
    AND EXISTS (
      SELECT 1
      FROM synthesis_revision_supports s
      WHERE s.project_id = NEW.project_id
        AND s.synthesis_revision_id = NEW.id
    ) THEN
    RAISE EXCEPTION 'withdrawn synthesis revisions cannot have support';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER synthesis_revisions_append_only
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_revision_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_synthesis_revision_support_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'synthesis revision supports are immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM synthesis_revisions r
    WHERE r.project_id = NEW.project_id
      AND r.id = NEW.synthesis_revision_id
      AND r.state = 'active'
      AND r.finalized_at IS NULL
  ) THEN
    RAISE EXCEPTION 'support can only be added to an active draft synthesis revision';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM extraction_value_revisions r
    WHERE r.project_id = NEW.project_id
      AND r.id = NEW.extraction_revision_id
      AND r.finalized_at IS NOT NULL
      AND r.value_state <> 'cleared'
  ) THEN
    RAISE EXCEPTION 'support must reference a finalized non-cleared extraction revision';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER synthesis_revision_supports_append_only
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_revision_supports
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_revision_support_mutation();
