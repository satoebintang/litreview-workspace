CREATE TABLE "screening_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"sort_order" bigint GENERATED ALWAYS AS IDENTITY (sequence name "screening_criteria_sort_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "screening_criteria_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "screening_criteria_project_id_id_type_unique" UNIQUE("project_id","id","type"),
	CONSTRAINT "screening_criteria_type_valid" CHECK ("screening_criteria"."type" in ('inclusion', 'exclusion')),
	CONSTRAINT "screening_criteria_text_nonblank" CHECK (btrim("screening_criteria"."text") <> '')
);
--> statement-breakpoint
CREATE TABLE "screening_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "screening_decisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"stage" text DEFAULT 'title_abstract' NOT NULL,
	"decision" text NOT NULL,
	"exclusion_criterion_id" uuid,
	"exclusion_criterion_type" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screening_decisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "screening_decisions_stage_valid" CHECK ("screening_decisions"."stage" = 'title_abstract'),
	CONSTRAINT "screening_decisions_decision_valid" CHECK ("screening_decisions"."decision" in ('include', 'exclude', 'maybe')),
	CONSTRAINT "screening_decisions_exclusion_shape" CHECK ((
      ("screening_decisions"."decision" = 'exclude' and "screening_decisions"."exclusion_criterion_id" is not null and "screening_decisions"."exclusion_criterion_type" = 'exclusion')
      or ("screening_decisions"."decision" in ('include', 'maybe') and "screening_decisions"."exclusion_criterion_id" is null and "screening_decisions"."exclusion_criterion_type" is null)
    )),
	CONSTRAINT "screening_decisions_note_nonblank" CHECK ("screening_decisions"."note" is null or btrim("screening_decisions"."note") <> '')
);
--> statement-breakpoint
ALTER TABLE "screening_criteria" ADD CONSTRAINT "screening_criteria_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_project_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_project_criterion_fk" FOREIGN KEY ("project_id","exclusion_criterion_id","exclusion_criterion_type") REFERENCES "public"."screening_criteria"("project_id","id","type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screening_criteria_project_order_idx" ON "screening_criteria" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "screening_decisions_project_paper_sequence_idx" ON "screening_decisions" USING btree ("project_id","paper_id","sequence");--> statement-breakpoint
CREATE INDEX "screening_decisions_project_stage_sequence_idx" ON "screening_decisions" USING btree ("project_id","stage","sequence");
--> statement-breakpoint
CREATE OR REPLACE VIEW "paper_screening_current" AS
SELECT DISTINCT ON (p.project_id, p.id)
  p.project_id,
  p.id AS paper_id,
  d.id AS decision_id,
  d.sequence,
  d.stage,
  d.decision,
  d.exclusion_criterion_id,
  d.exclusion_criterion_type,
  d.note,
  d.created_at
FROM papers p
LEFT JOIN screening_decisions d
  ON d.project_id = p.project_id
 AND d.paper_id = p.id
 AND d.stage = 'title_abstract'
ORDER BY p.project_id, p.id, d.sequence DESC NULLS LAST;
--> statement-breakpoint
CREATE FUNCTION prevent_screening_decision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'screening decisions are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER screening_decisions_append_only
BEFORE UPDATE OR DELETE ON screening_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_screening_decision_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_screening_criterion_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.text IS DISTINCT FROM OLD.text
    OR NEW.sort_order IS DISTINCT FROM OLD.sort_order
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'screening criteria are immutable; archive instead';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER screening_criteria_immutable_fields
BEFORE UPDATE ON screening_criteria
FOR EACH ROW EXECUTE FUNCTION prevent_screening_criterion_mutation();
