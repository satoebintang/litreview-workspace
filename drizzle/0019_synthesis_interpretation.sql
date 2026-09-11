CREATE TABLE "synthesis_interpretation_contradictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"interpretation_id" uuid NOT NULL,
	"synthesis_revision_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"left_extraction_revision_id" uuid NOT NULL,
	"right_extraction_revision_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_interpretation_contradictions_pair_unique" UNIQUE("project_id","interpretation_id","left_extraction_revision_id","right_extraction_revision_id"),
	CONSTRAINT "synthesis_interpretation_contradictions_sort_order_unique" UNIQUE("project_id","interpretation_id","sort_order"),
	CONSTRAINT "synthesis_interpretation_contradictions_canonical_order" CHECK ("synthesis_interpretation_contradictions"."left_extraction_revision_id" < "synthesis_interpretation_contradictions"."right_extraction_revision_id"),
	CONSTRAINT "synthesis_interpretation_contradictions_note_shape" CHECK ("synthesis_interpretation_contradictions"."note" is null or (btrim("synthesis_interpretation_contradictions"."note") <> '' and char_length("synthesis_interpretation_contradictions"."note") <= 5000)),
	CONSTRAINT "synthesis_interpretation_contradictions_sort_order_valid" CHECK ("synthesis_interpretation_contradictions"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "synthesis_interpretation_limitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"interpretation_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_interpretation_limitations_sort_order_unique" UNIQUE("project_id","interpretation_id","sort_order"),
	CONSTRAINT "synthesis_interpretation_limitations_category_valid" CHECK ("synthesis_interpretation_limitations"."category" in ('methodological', 'population', 'measurement', 'generalizability', 'missing_data', 'heterogeneity', 'reporting', 'other')),
	CONSTRAINT "synthesis_interpretation_limitations_body_shape" CHECK (btrim("synthesis_interpretation_limitations"."body") <> '' and char_length("synthesis_interpretation_limitations"."body") <= 5000),
	CONSTRAINT "synthesis_interpretation_limitations_sort_order_valid" CHECK ("synthesis_interpretation_limitations"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "synthesis_interpretation_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"interpretation_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_interpretation_questions_sort_order_unique" UNIQUE("project_id","interpretation_id","sort_order"),
	CONSTRAINT "synthesis_interpretation_questions_body_shape" CHECK (btrim("synthesis_interpretation_questions"."body") <> '' and char_length("synthesis_interpretation_questions"."body") <= 5000),
	CONSTRAINT "synthesis_interpretation_questions_sort_order_valid" CHECK ("synthesis_interpretation_questions"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "synthesis_interpretations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "synthesis_interpretations_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"synthesis_statement_id" uuid NOT NULL,
	"synthesis_revision_id" uuid NOT NULL,
	"convergence_state" text NOT NULL,
	"summary" text NOT NULL,
	"researcher_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "synthesis_interpretations_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "synthesis_interpretations_project_revision_key_unique" UNIQUE("project_id","id","synthesis_revision_id"),
	CONSTRAINT "synthesis_interpretations_convergence_state_valid" CHECK ("synthesis_interpretations"."convergence_state" in ('convergent', 'mixed', 'contradictory', 'inconclusive')),
	CONSTRAINT "synthesis_interpretations_summary_shape" CHECK (btrim("synthesis_interpretations"."summary") <> '' and char_length("synthesis_interpretations"."summary") <= 20000),
	CONSTRAINT "synthesis_interpretations_note_shape" CHECK ("synthesis_interpretations"."researcher_note" is null or (btrim("synthesis_interpretations"."researcher_note") <> '' and char_length("synthesis_interpretations"."researcher_note") <= 10000))
);
--> statement-breakpoint
ALTER TABLE "synthesis_interpretation_contradictions" ADD CONSTRAINT "synthesis_interpretation_contradictions_parent_fk" FOREIGN KEY ("project_id","interpretation_id","synthesis_revision_id") REFERENCES "public"."synthesis_interpretations"("project_id","id","synthesis_revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_interpretation_contradictions" ADD CONSTRAINT "synthesis_interpretation_contradictions_left_support_fk" FOREIGN KEY ("project_id","synthesis_revision_id","left_extraction_revision_id") REFERENCES "public"."synthesis_revision_supports"("project_id","synthesis_revision_id","extraction_revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_interpretation_contradictions" ADD CONSTRAINT "synthesis_interpretation_contradictions_right_support_fk" FOREIGN KEY ("project_id","synthesis_revision_id","right_extraction_revision_id") REFERENCES "public"."synthesis_revision_supports"("project_id","synthesis_revision_id","extraction_revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_interpretation_limitations" ADD CONSTRAINT "synthesis_interpretation_limitations_parent_fk" FOREIGN KEY ("project_id","interpretation_id") REFERENCES "public"."synthesis_interpretations"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_interpretation_questions" ADD CONSTRAINT "synthesis_interpretation_questions_parent_fk" FOREIGN KEY ("project_id","interpretation_id") REFERENCES "public"."synthesis_interpretations"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_interpretations" ADD CONSTRAINT "synthesis_interpretations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_interpretations" ADD CONSTRAINT "synthesis_interpretations_project_revision_fk" FOREIGN KEY ("project_id","synthesis_statement_id","synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","synthesis_statement_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synthesis_interpretation_contradictions_interpretation_idx" ON "synthesis_interpretation_contradictions" USING btree ("project_id","interpretation_id");--> statement-breakpoint
CREATE INDEX "synthesis_interpretation_contradictions_revision_idx" ON "synthesis_interpretation_contradictions" USING btree ("project_id","synthesis_revision_id");--> statement-breakpoint
CREATE INDEX "synthesis_interpretation_limitations_interpretation_idx" ON "synthesis_interpretation_limitations" USING btree ("project_id","interpretation_id");--> statement-breakpoint
CREATE INDEX "synthesis_interpretation_questions_interpretation_idx" ON "synthesis_interpretation_questions" USING btree ("project_id","interpretation_id");--> statement-breakpoint
CREATE INDEX "synthesis_interpretations_project_revision_sequence_idx" ON "synthesis_interpretations" USING btree ("project_id","synthesis_revision_id","sequence");--> statement-breakpoint
CREATE INDEX "synthesis_interpretations_project_sequence_idx" ON "synthesis_interpretations" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE INDEX "synthesis_interpretations_project_created_at_idx" ON "synthesis_interpretations" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_synthesis_interpretation_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rev_state text;
  rev_finalized_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'synthesis interpretations must be created in draft state' USING ERRCODE = '23514';
    END IF;

    SELECT state, finalized_at
    INTO rev_state, rev_finalized_at
    FROM synthesis_revisions
    WHERE project_id = NEW.project_id
      AND synthesis_statement_id = NEW.synthesis_statement_id
      AND id = NEW.synthesis_revision_id
    FOR UPDATE;

    IF rev_state IS NULL THEN
      RAISE EXCEPTION 'synthesis revision does not belong to this statement and project' USING ERRCODE = '23503';
    END IF;
    IF rev_finalized_at IS NULL THEN
      RAISE EXCEPTION 'interpretations can only be authored for finalized synthesis revisions' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'synthesis interpretations cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'finalized synthesis interpretations are immutable' USING ERRCODE = '23514';
    END IF;

    IF NEW.finalized_at IS NULL THEN
      RAISE EXCEPTION 'synthesis interpretation updates only permit finalization' USING ERRCODE = '23514';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.sequence IS DISTINCT FROM OLD.sequence
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.synthesis_statement_id IS DISTINCT FROM OLD.synthesis_statement_id
      OR NEW.synthesis_revision_id IS DISTINCT FROM OLD.synthesis_revision_id
      OR NEW.convergence_state IS DISTINCT FROM OLD.convergence_state
      OR NEW.summary IS DISTINCT FROM OLD.summary
      OR NEW.researcher_note IS DISTINCT FROM OLD.researcher_note
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'synthesis interpretation content and identity fields are immutable' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER synthesis_interpretations_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_interpretations
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_interpretation_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_synthesis_interpretation_child_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  interp_finalized_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'synthesis interpretation children are immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT finalized_at INTO interp_finalized_at
    FROM synthesis_interpretations
    WHERE project_id = NEW.project_id AND id = NEW.interpretation_id
    FOR UPDATE;

    IF interp_finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot add children to a finalized synthesis interpretation' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER synthesis_interpretation_limitations_guard
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_interpretation_limitations
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_interpretation_child_mutation();
--> statement-breakpoint
CREATE TRIGGER synthesis_interpretation_questions_guard
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_interpretation_questions
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_interpretation_child_mutation();
--> statement-breakpoint
CREATE TRIGGER synthesis_interpretation_contradictions_guard
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_interpretation_contradictions
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_interpretation_child_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_synthesis_interpretation_finalization() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_convergence_state text;
  current_finalized_at timestamptz;
  lim_count integer;
  q_count integer;
  cont_count integer;
BEGIN
  -- Query current persisted state using identity from trigger tuple (idempotent across deferred events)
  SELECT convergence_state, finalized_at
  INTO current_convergence_state, current_finalized_at
  FROM synthesis_interpretations
  WHERE project_id = NEW.project_id AND id = NEW.id;

  IF current_convergence_state IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_finalized_at IS NULL THEN
    RAISE EXCEPTION 'draft synthesis interpretation cannot survive transaction commit' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO lim_count
  FROM synthesis_interpretation_limitations
  WHERE project_id = NEW.project_id AND interpretation_id = NEW.id;

  IF lim_count > 100 THEN
    RAISE EXCEPTION 'synthesis interpretation limitations count (%) exceeds operational limit of 100', lim_count USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO q_count
  FROM synthesis_interpretation_questions
  WHERE project_id = NEW.project_id AND interpretation_id = NEW.id;

  IF q_count > 100 THEN
    RAISE EXCEPTION 'synthesis interpretation questions count (%) exceeds operational limit of 100', q_count USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO cont_count
  FROM synthesis_interpretation_contradictions
  WHERE project_id = NEW.project_id AND interpretation_id = NEW.id;

  IF cont_count > 500 THEN
    RAISE EXCEPTION 'synthesis interpretation contradictions count (%) exceeds operational limit of 500', cont_count USING ERRCODE = '23514';
  END IF;

  IF current_convergence_state = 'convergent' AND cont_count <> 0 THEN
    RAISE EXCEPTION 'convergent synthesis interpretations must have exactly 0 contradiction pairs, found %', cont_count USING ERRCODE = '23514';
  END IF;

  IF current_convergence_state = 'contradictory' AND cont_count = 0 THEN
    RAISE EXCEPTION 'contradictory synthesis interpretations must have at least 1 contradiction pair' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER synthesis_interpretations_finalization_validation
AFTER INSERT OR UPDATE ON synthesis_interpretations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_synthesis_interpretation_finalization();