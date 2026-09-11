CREATE TABLE "evidence_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_annotations_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_annotations_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_annotations_body_shape" CHECK (btrim("evidence_annotations"."body") <> '' and char_length("evidence_annotations"."body") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "evidence_label_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_label_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_label_events_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_label_events_event_valid" CHECK ("evidence_label_events"."event" in ('assigned', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "evidence_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "evidence_labels_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_labels_name_shape" CHECK (btrim("evidence_labels"."name") <> '' and char_length("evidence_labels"."name") <= 100),
	CONSTRAINT "evidence_labels_description_shape" CHECK ("evidence_labels"."description" is null or char_length("evidence_labels"."description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "evidence_review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_review_decisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_review_decisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_review_decisions_decision_valid" CHECK ("evidence_review_decisions"."decision" in ('needs_review', 'accepted', 'rejected')),
	CONSTRAINT "evidence_review_decisions_note_shape" CHECK ("evidence_review_decisions"."note" is null or (btrim("evidence_review_decisions"."note") <> '' and char_length("evidence_review_decisions"."note") <= 2000))
);
--> statement-breakpoint
ALTER TABLE "evidence_annotations" ADD CONSTRAINT "evidence_annotations_project_evidence_fk" FOREIGN KEY ("project_id","evidence_id") REFERENCES "public"."evidence"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_label_events" ADD CONSTRAINT "evidence_label_events_project_evidence_fk" FOREIGN KEY ("project_id","evidence_id") REFERENCES "public"."evidence"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_label_events" ADD CONSTRAINT "evidence_label_events_project_label_fk" FOREIGN KEY ("project_id","label_id") REFERENCES "public"."evidence_labels"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_labels" ADD CONSTRAINT "evidence_labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_review_decisions" ADD CONSTRAINT "evidence_review_decisions_project_evidence_fk" FOREIGN KEY ("project_id","evidence_id") REFERENCES "public"."evidence"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_annotations_project_evidence_sequence_idx" ON "evidence_annotations" USING btree ("project_id","evidence_id","sequence");--> statement-breakpoint
CREATE INDEX "evidence_label_events_project_pair_sequence_idx" ON "evidence_label_events" USING btree ("project_id","evidence_id","label_id","sequence");--> statement-breakpoint
CREATE INDEX "evidence_label_events_project_evidence_idx" ON "evidence_label_events" USING btree ("project_id","evidence_id");--> statement-breakpoint
CREATE INDEX "evidence_label_events_project_label_idx" ON "evidence_label_events" USING btree ("project_id","label_id");--> statement-breakpoint
CREATE INDEX "evidence_labels_project_created_at_idx" ON "evidence_labels" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_labels_active_name_unique" ON "evidence_labels" USING btree ("project_id",lower(btrim("name"))) WHERE "evidence_labels"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "evidence_review_decisions_project_evidence_sequence_idx" ON "evidence_review_decisions" USING btree ("project_id","evidence_id","sequence");--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Evidence provenance is immutable';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_immutable_update
BEFORE UPDATE ON evidence
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_evidence_curation_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Evidence curation history is append-only';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_review_decisions_append_only
BEFORE UPDATE OR DELETE ON evidence_review_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_curation_history_mutation();--> statement-breakpoint
CREATE TRIGGER evidence_annotations_append_only
BEFORE UPDATE OR DELETE ON evidence_annotations
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_curation_history_mutation();--> statement-breakpoint
CREATE TRIGGER evidence_label_events_append_only
BEFORE UPDATE OR DELETE ON evidence_label_events
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_curation_history_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_evidence_label_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence labels are archive-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Evidence label identity is immutable';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'Archived Evidence labels cannot be restored';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'Archived Evidence labels cannot be changed';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'Evidence labels can only be archived';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_labels_archive_only
BEFORE UPDATE OR DELETE ON evidence_labels
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_label_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION append_evidence_review_decision_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  locked_id uuid;
BEGIN
  NEW.note := nullif(regexp_replace(NEW.note, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  SELECT id INTO locked_id
  FROM evidence
  WHERE project_id = NEW.project_id AND id = NEW.evidence_id
  FOR UPDATE;
  IF locked_id IS NULL THEN
    RAISE EXCEPTION 'Evidence does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_review_decisions_evidence_lock
BEFORE INSERT ON evidence_review_decisions
FOR EACH ROW EXECUTE FUNCTION append_evidence_review_decision_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION normalize_evidence_annotation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.body := regexp_replace(NEW.body, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_annotations_normalize
BEFORE INSERT ON evidence_annotations
FOR EACH ROW EXECUTE FUNCTION normalize_evidence_annotation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION assert_evidence_usable_for_direct_support() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  locked_id uuid;
  current_decision text;
BEGIN
  SELECT id INTO locked_id
  FROM evidence
  WHERE project_id = NEW.project_id AND id = NEW.evidence_id
  FOR UPDATE;
  IF locked_id IS NULL THEN
    RAISE EXCEPTION 'Evidence does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  SELECT decision INTO current_decision
  FROM evidence_review_decisions
  WHERE project_id = NEW.project_id AND evidence_id = NEW.evidence_id
  ORDER BY sequence DESC
  LIMIT 1;
  IF current_decision = 'rejected' THEN
    RAISE EXCEPTION 'Rejected Evidence cannot be used as new direct support' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER claim_revision_evidence_rejection_guard
BEFORE INSERT ON claim_revision_evidence_supports
FOR EACH ROW EXECUTE FUNCTION assert_evidence_usable_for_direct_support();--> statement-breakpoint
CREATE TRIGGER extraction_revision_evidence_rejection_guard
BEFORE INSERT ON extraction_revision_evidence
FOR EACH ROW EXECUTE FUNCTION assert_evidence_usable_for_direct_support();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_evidence_label_event_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  locked_evidence uuid;
  label_archived_at timestamptz;
  latest_event text;
BEGIN
  SELECT id INTO locked_evidence
  FROM evidence
  WHERE project_id = NEW.project_id AND id = NEW.evidence_id
  FOR UPDATE;
  IF locked_evidence IS NULL THEN
    RAISE EXCEPTION 'Evidence does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  SELECT archived_at INTO label_archived_at
  FROM evidence_labels
  WHERE project_id = NEW.project_id AND id = NEW.label_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence label does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  SELECT event INTO latest_event
  FROM evidence_label_events
  WHERE project_id = NEW.project_id AND evidence_id = NEW.evidence_id AND label_id = NEW.label_id
  ORDER BY sequence DESC
  LIMIT 1;
  IF NEW.event = 'assigned' THEN
    IF label_archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Archived Evidence labels cannot be assigned' USING ERRCODE = '23514';
    END IF;
    IF latest_event = 'assigned' THEN
      RAISE EXCEPTION 'Evidence label is already assigned' USING ERRCODE = '23505';
    END IF;
  ELSIF latest_event IS DISTINCT FROM 'assigned' THEN
    RAISE EXCEPTION 'Evidence label is not currently assigned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_label_events_transition_guard
BEFORE INSERT ON evidence_label_events
FOR EACH ROW EXECUTE FUNCTION validate_evidence_label_event_transition();
