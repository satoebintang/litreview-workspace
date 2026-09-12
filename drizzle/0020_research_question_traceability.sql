CREATE TABLE "research_question_claim_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_question_claim_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rq_claim_events_action_valid" CHECK ("research_question_claim_events"."action" in ('linked', 'unlinked')),
	CONSTRAINT "rq_claim_events_note_shape" CHECK ("research_question_claim_events"."note" is null or (btrim("research_question_claim_events"."note") <> '' and char_length("research_question_claim_events"."note") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "research_question_evidence_set_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_question_evidence_set_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rq_evidence_set_events_action_valid" CHECK ("research_question_evidence_set_events"."action" in ('linked', 'unlinked')),
	CONSTRAINT "rq_evidence_set_events_note_shape" CHECK ("research_question_evidence_set_events"."note" is null or (btrim("research_question_evidence_set_events"."note") <> '' and char_length("research_question_evidence_set_events"."note") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "research_question_extraction_field_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_question_extraction_field_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"extraction_field_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rq_extraction_field_events_action_valid" CHECK ("research_question_extraction_field_events"."action" in ('linked', 'unlinked')),
	CONSTRAINT "rq_extraction_field_events_note_shape" CHECK ("research_question_extraction_field_events"."note" is null or (btrim("research_question_extraction_field_events"."note") <> '' and char_length("research_question_extraction_field_events"."note") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "research_question_synthesis_statement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_question_synthesis_statement_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"synthesis_statement_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rq_synthesis_statement_events_action_valid" CHECK ("research_question_synthesis_statement_events"."action" in ('linked', 'unlinked')),
	CONSTRAINT "rq_synthesis_statement_events_note_shape" CHECK ("research_question_synthesis_statement_events"."note" is null or (btrim("research_question_synthesis_statement_events"."note") <> '' and char_length("research_question_synthesis_statement_events"."note") <= 2000))
);
--> statement-breakpoint
ALTER TABLE "research_question_claim_events" ADD CONSTRAINT "rq_claim_events_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_claim_events" ADD CONSTRAINT "rq_claim_events_project_rq_fk" FOREIGN KEY ("project_id","research_question_id") REFERENCES "public"."research_questions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_claim_events" ADD CONSTRAINT "rq_claim_events_project_claim_fk" FOREIGN KEY ("project_id","claim_id") REFERENCES "public"."claims"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_evidence_set_events" ADD CONSTRAINT "rq_evidence_set_events_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_evidence_set_events" ADD CONSTRAINT "rq_evidence_set_events_project_rq_fk" FOREIGN KEY ("project_id","research_question_id") REFERENCES "public"."research_questions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_evidence_set_events" ADD CONSTRAINT "rq_evidence_set_events_project_set_fk" FOREIGN KEY ("project_id","evidence_set_id") REFERENCES "public"."evidence_sets"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_extraction_field_events" ADD CONSTRAINT "rq_extraction_field_events_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_extraction_field_events" ADD CONSTRAINT "rq_extraction_field_events_project_rq_fk" FOREIGN KEY ("project_id","research_question_id") REFERENCES "public"."research_questions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_extraction_field_events" ADD CONSTRAINT "rq_extraction_field_events_project_field_fk" FOREIGN KEY ("project_id","extraction_field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_synthesis_statement_events" ADD CONSTRAINT "rq_synthesis_statement_events_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_synthesis_statement_events" ADD CONSTRAINT "rq_synthesis_statement_events_project_rq_fk" FOREIGN KEY ("project_id","research_question_id") REFERENCES "public"."research_questions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_synthesis_statement_events" ADD CONSTRAINT "rq_synthesis_statement_events_project_stmt_fk" FOREIGN KEY ("project_id","synthesis_statement_id") REFERENCES "public"."synthesis_statements"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rq_claim_events_project_rq_seq_idx" ON "research_question_claim_events" USING btree ("project_id","research_question_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_claim_events_project_claim_seq_idx" ON "research_question_claim_events" USING btree ("project_id","claim_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_claim_events_project_pair_seq_idx" ON "research_question_claim_events" USING btree ("project_id","research_question_id","claim_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_evidence_set_events_project_rq_seq_idx" ON "research_question_evidence_set_events" USING btree ("project_id","research_question_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_evidence_set_events_project_set_seq_idx" ON "research_question_evidence_set_events" USING btree ("project_id","evidence_set_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_evidence_set_events_project_pair_seq_idx" ON "research_question_evidence_set_events" USING btree ("project_id","research_question_id","evidence_set_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_extraction_field_events_project_rq_seq_idx" ON "research_question_extraction_field_events" USING btree ("project_id","research_question_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_extraction_field_events_project_field_seq_idx" ON "research_question_extraction_field_events" USING btree ("project_id","extraction_field_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_extraction_field_events_project_pair_seq_idx" ON "research_question_extraction_field_events" USING btree ("project_id","research_question_id","extraction_field_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_synthesis_events_project_rq_seq_idx" ON "research_question_synthesis_statement_events" USING btree ("project_id","research_question_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_synthesis_events_project_stmt_seq_idx" ON "research_question_synthesis_statement_events" USING btree ("project_id","synthesis_statement_id","sequence");--> statement-breakpoint
CREATE INDEX "rq_synthesis_events_project_pair_seq_idx" ON "research_question_synthesis_statement_events" USING btree ("project_id","research_question_id","synthesis_statement_id","sequence");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_rq_traceability_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Research question traceability events are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER rq_extraction_field_events_append_only
BEFORE UPDATE OR DELETE ON research_question_extraction_field_events
FOR EACH ROW EXECUTE FUNCTION prevent_rq_traceability_event_mutation();
--> statement-breakpoint
CREATE TRIGGER rq_evidence_set_events_append_only
BEFORE UPDATE OR DELETE ON research_question_evidence_set_events
FOR EACH ROW EXECUTE FUNCTION prevent_rq_traceability_event_mutation();
--> statement-breakpoint
CREATE TRIGGER rq_synthesis_statement_events_append_only
BEFORE UPDATE OR DELETE ON research_question_synthesis_statement_events
FOR EACH ROW EXECUTE FUNCTION prevent_rq_traceability_event_mutation();
--> statement-breakpoint
CREATE TRIGGER rq_claim_events_append_only
BEFORE UPDATE OR DELETE ON research_question_claim_events
FOR EACH ROW EXECUTE FUNCTION prevent_rq_traceability_event_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_rq_extraction_field_event_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rq_archived_at timestamptz;
  latest_action text;
BEGIN
  IF NEW.note IS NOT NULL THEN
    NEW.note := btrim(NEW.note);
    IF NEW.note = '' THEN
      RAISE EXCEPTION 'Traceability event note cannot be blank when present' USING ERRCODE = '23514';
    END IF;
    IF char_length(NEW.note) > 2000 THEN
      RAISE EXCEPTION 'Traceability event note cannot exceed 2000 characters' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT archived_at INTO rq_archived_at
  FROM research_questions
  WHERE project_id = NEW.project_id AND id = NEW.research_question_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research question does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  IF rq_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived research questions cannot be linked or unlinked' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM extraction_fields
  WHERE project_id = NEW.project_id AND id = NEW.extraction_field_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Extraction field does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  SELECT action INTO latest_action
  FROM research_question_extraction_field_events
  WHERE project_id = NEW.project_id
    AND research_question_id = NEW.research_question_id
    AND extraction_field_id = NEW.extraction_field_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF latest_action IS NULL THEN
    IF NEW.action <> 'linked' THEN
      RAISE EXCEPTION 'First event for a target must be linked' USING ERRCODE = '23514';
    END IF;
  ELSIF latest_action = NEW.action THEN
    IF NEW.action = 'linked' THEN
      RAISE EXCEPTION 'Extraction field is already linked to this research question' USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'Extraction field is already unlinked from this research question' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER rq_extraction_field_events_transition_guard
BEFORE INSERT ON research_question_extraction_field_events
FOR EACH ROW EXECUTE FUNCTION validate_rq_extraction_field_event_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_rq_evidence_set_event_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rq_archived_at timestamptz;
  latest_action text;
BEGIN
  IF NEW.note IS NOT NULL THEN
    NEW.note := btrim(NEW.note);
    IF NEW.note = '' THEN
      RAISE EXCEPTION 'Traceability event note cannot be blank when present' USING ERRCODE = '23514';
    END IF;
    IF char_length(NEW.note) > 2000 THEN
      RAISE EXCEPTION 'Traceability event note cannot exceed 2000 characters' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT archived_at INTO rq_archived_at
  FROM research_questions
  WHERE project_id = NEW.project_id AND id = NEW.research_question_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research question does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  IF rq_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived research questions cannot be linked or unlinked' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM evidence_sets
  WHERE project_id = NEW.project_id AND id = NEW.evidence_set_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence set does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  SELECT action INTO latest_action
  FROM research_question_evidence_set_events
  WHERE project_id = NEW.project_id
    AND research_question_id = NEW.research_question_id
    AND evidence_set_id = NEW.evidence_set_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF latest_action IS NULL THEN
    IF NEW.action <> 'linked' THEN
      RAISE EXCEPTION 'First event for a target must be linked' USING ERRCODE = '23514';
    END IF;
  ELSIF latest_action = NEW.action THEN
    IF NEW.action = 'linked' THEN
      RAISE EXCEPTION 'Evidence set is already linked to this research question' USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'Evidence set is already unlinked from this research question' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER rq_evidence_set_events_transition_guard
BEFORE INSERT ON research_question_evidence_set_events
FOR EACH ROW EXECUTE FUNCTION validate_rq_evidence_set_event_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_rq_synthesis_statement_event_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rq_archived_at timestamptz;
  latest_action text;
BEGIN
  IF NEW.note IS NOT NULL THEN
    NEW.note := btrim(NEW.note);
    IF NEW.note = '' THEN
      RAISE EXCEPTION 'Traceability event note cannot be blank when present' USING ERRCODE = '23514';
    END IF;
    IF char_length(NEW.note) > 2000 THEN
      RAISE EXCEPTION 'Traceability event note cannot exceed 2000 characters' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT archived_at INTO rq_archived_at
  FROM research_questions
  WHERE project_id = NEW.project_id AND id = NEW.research_question_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research question does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  IF rq_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived research questions cannot be linked or unlinked' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM synthesis_statements
  WHERE project_id = NEW.project_id AND id = NEW.synthesis_statement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthesis statement does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  SELECT action INTO latest_action
  FROM research_question_synthesis_statement_events
  WHERE project_id = NEW.project_id
    AND research_question_id = NEW.research_question_id
    AND synthesis_statement_id = NEW.synthesis_statement_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF latest_action IS NULL THEN
    IF NEW.action <> 'linked' THEN
      RAISE EXCEPTION 'First event for a target must be linked' USING ERRCODE = '23514';
    END IF;
  ELSIF latest_action = NEW.action THEN
    IF NEW.action = 'linked' THEN
      RAISE EXCEPTION 'Synthesis statement is already linked to this research question' USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'Synthesis statement is already unlinked from this research question' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER rq_synthesis_statement_events_transition_guard
BEFORE INSERT ON research_question_synthesis_statement_events
FOR EACH ROW EXECUTE FUNCTION validate_rq_synthesis_statement_event_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_rq_claim_event_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rq_archived_at timestamptz;
  latest_action text;
BEGIN
  IF NEW.note IS NOT NULL THEN
    NEW.note := btrim(NEW.note);
    IF NEW.note = '' THEN
      RAISE EXCEPTION 'Traceability event note cannot be blank when present' USING ERRCODE = '23514';
    END IF;
    IF char_length(NEW.note) > 2000 THEN
      RAISE EXCEPTION 'Traceability event note cannot exceed 2000 characters' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT archived_at INTO rq_archived_at
  FROM research_questions
  WHERE project_id = NEW.project_id AND id = NEW.research_question_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research question does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  IF rq_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived research questions cannot be linked or unlinked' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM claims
  WHERE project_id = NEW.project_id AND id = NEW.claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim does not belong to this Project' USING ERRCODE = '23503';
  END IF;

  SELECT action INTO latest_action
  FROM research_question_claim_events
  WHERE project_id = NEW.project_id
    AND research_question_id = NEW.research_question_id
    AND claim_id = NEW.claim_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF latest_action IS NULL THEN
    IF NEW.action <> 'linked' THEN
      RAISE EXCEPTION 'First event for a target must be linked' USING ERRCODE = '23514';
    END IF;
  ELSIF latest_action = NEW.action THEN
    IF NEW.action = 'linked' THEN
      RAISE EXCEPTION 'Claim is already linked to this research question' USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'Claim is already unlinked from this research question' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER rq_claim_events_transition_guard
BEFORE INSERT ON research_question_claim_events
FOR EACH ROW EXECUTE FUNCTION validate_rq_claim_event_transition();