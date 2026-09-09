CREATE TABLE "full_text_screening_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"text" text NOT NULL,
	"sort_order" bigint GENERATED ALWAYS AS IDENTITY (sequence name "full_text_screening_criteria_sort_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "full_text_screening_criteria_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "full_text_screening_criteria_text_nonblank" CHECK (btrim("full_text_screening_criteria"."text") <> '')
);
--> statement-breakpoint
CREATE TABLE "full_text_screening_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "full_text_screening_decisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"exclusion_criterion_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "full_text_screening_decisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "full_text_screening_decisions_decision_valid" CHECK ("full_text_screening_decisions"."decision" in ('include', 'exclude', 'maybe')),
	CONSTRAINT "full_text_screening_decisions_exclusion_shape" CHECK ((
      ("full_text_screening_decisions"."decision" = 'exclude' and "full_text_screening_decisions"."exclusion_criterion_id" is not null)
      or ("full_text_screening_decisions"."decision" in ('include', 'maybe') and "full_text_screening_decisions"."exclusion_criterion_id" is null)
    )),
	CONSTRAINT "full_text_screening_decisions_note_nonblank" CHECK ("full_text_screening_decisions"."note" is null or btrim("full_text_screening_decisions"."note") <> '')
);
--> statement-breakpoint
ALTER TABLE "full_text_screening_criteria" ADD CONSTRAINT "full_text_screening_criteria_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "full_text_screening_decisions" ADD CONSTRAINT "full_text_screening_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "full_text_screening_decisions" ADD CONSTRAINT "full_text_screening_decisions_project_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "full_text_screening_decisions" ADD CONSTRAINT "full_text_screening_decisions_project_criterion_fk" FOREIGN KEY ("project_id","exclusion_criterion_id") REFERENCES "public"."full_text_screening_criteria"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "full_text_screening_criteria_project_order_idx" ON "full_text_screening_criteria" USING btree ("project_id","sort_order");
--> statement-breakpoint
CREATE INDEX "full_text_screening_decisions_project_paper_sequence_idx" ON "full_text_screening_decisions" USING btree ("project_id","paper_id","sequence");
--> statement-breakpoint
CREATE FUNCTION prevent_full_text_screening_decision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'full-text screening decisions are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_screening_decisions_append_only
BEFORE UPDATE OR DELETE ON full_text_screening_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_full_text_screening_decision_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_full_text_screening_criterion_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.text IS DISTINCT FROM OLD.text
    OR NEW.sort_order IS DISTINCT FROM OLD.sort_order
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at)
    OR (OLD.archived_at IS NULL AND NEW.archived_at IS NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'full-text screening criteria are immutable; archive instead';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_screening_criteria_immutable_fields
BEFORE UPDATE ON full_text_screening_criteria
FOR EACH ROW EXECUTE FUNCTION prevent_full_text_screening_criterion_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_full_text_screening_criterion_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'full-text screening criteria are archive-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_screening_criteria_archive_only
BEFORE DELETE ON full_text_screening_criteria
FOR EACH ROW EXECUTE FUNCTION prevent_full_text_screening_criterion_delete();
--> statement-breakpoint
CREATE FUNCTION lock_screening_paper_before_insert() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM papers p WHERE p.project_id = NEW.project_id AND p.id = NEW.paper_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'screening decision references an invalid project Paper';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER screening_decisions_lock_paper
BEFORE INSERT ON screening_decisions
FOR EACH ROW EXECUTE FUNCTION lock_screening_paper_before_insert();
--> statement-breakpoint
CREATE FUNCTION validate_full_text_screening_decision() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM papers p WHERE p.project_id = NEW.project_id AND p.id = NEW.paper_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'full-text screening decision references an invalid project Paper';
  END IF;
  IF COALESCE((
    SELECT sd.decision = 'include' FROM screening_decisions sd
    WHERE sd.project_id = NEW.project_id
      AND sd.paper_id = NEW.paper_id
      AND sd.stage = 'title_abstract'
    ORDER BY sd.sequence DESC
    LIMIT 1
  ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'full-text screening requires a current title/abstract include decision';
  END IF;
  IF NEW.decision = 'exclude' AND NOT EXISTS (
    SELECT 1 FROM full_text_screening_criteria c
    WHERE c.project_id = NEW.project_id
      AND c.id = NEW.exclusion_criterion_id
      AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'full-text exclusion criterion must be active and project-owned';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_screening_decisions_validate
BEFORE INSERT ON full_text_screening_decisions
FOR EACH ROW EXECUTE FUNCTION validate_full_text_screening_decision();
