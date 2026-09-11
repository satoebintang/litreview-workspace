CREATE TABLE "evidence_set_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_set_annotations_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_set_annotations_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_set_annotations_body_shape" CHECK (btrim("evidence_set_annotations"."body") <> '' and char_length("evidence_set_annotations"."body") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "evidence_set_composition_members" (
	"project_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"composition_revision_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "evidence_set_composition_members_project_id_composition_revision_id_membership_id_pk" PRIMARY KEY("project_id","composition_revision_id","membership_id"),
	CONSTRAINT "evidence_set_composition_members_project_revision_sort_unique" UNIQUE("project_id","composition_revision_id","sort_order"),
	CONSTRAINT "evidence_set_composition_members_sort_order_positive" CHECK ("evidence_set_composition_members"."sort_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "evidence_set_composition_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_set_composition_revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_set_composition_revisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_set_composition_revisions_project_set_id_id_unique" UNIQUE("project_id","evidence_set_id","id"),
	CONSTRAINT "evidence_set_composition_revisions_operation_kind_valid" CHECK ("evidence_set_composition_revisions"."operation_kind" in ('created', 'added', 'readded', 'removed', 'reordered'))
);
--> statement-breakpoint
CREATE TABLE "evidence_set_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_set_memberships_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_set_memberships_project_set_id_id_unique" UNIQUE("project_id","evidence_set_id","id"),
	CONSTRAINT "evidence_set_memberships_project_set_evidence_unique" UNIQUE("project_id","evidence_set_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "evidence_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "evidence_sets_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "evidence_sets_name_shape" CHECK (btrim("evidence_sets"."name") <> '' and char_length("evidence_sets"."name") <= 100),
	CONSTRAINT "evidence_sets_description_shape" CHECK ("evidence_sets"."description" is null or char_length("evidence_sets"."description") <= 500)
);
--> statement-breakpoint
ALTER TABLE "evidence_set_annotations" ADD CONSTRAINT "evidence_set_annotations_project_set_fk" FOREIGN KEY ("project_id","evidence_set_id") REFERENCES "public"."evidence_sets"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_set_composition_members" ADD CONSTRAINT "evidence_set_composition_members_project_set_revision_fk" FOREIGN KEY ("project_id","evidence_set_id","composition_revision_id") REFERENCES "public"."evidence_set_composition_revisions"("project_id","evidence_set_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_set_composition_members" ADD CONSTRAINT "evidence_set_composition_members_project_set_membership_fk" FOREIGN KEY ("project_id","evidence_set_id","membership_id") REFERENCES "public"."evidence_set_memberships"("project_id","evidence_set_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_set_composition_revisions" ADD CONSTRAINT "evidence_set_composition_revisions_project_set_fk" FOREIGN KEY ("project_id","evidence_set_id") REFERENCES "public"."evidence_sets"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_set_memberships" ADD CONSTRAINT "evidence_set_memberships_project_set_fk" FOREIGN KEY ("project_id","evidence_set_id") REFERENCES "public"."evidence_sets"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_set_memberships" ADD CONSTRAINT "evidence_set_memberships_project_evidence_fk" FOREIGN KEY ("project_id","evidence_id") REFERENCES "public"."evidence"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_sets" ADD CONSTRAINT "evidence_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_set_annotations_project_set_sequence_idx" ON "evidence_set_annotations" USING btree ("project_id","evidence_set_id","sequence");--> statement-breakpoint
CREATE INDEX "evidence_set_composition_members_project_revision_idx" ON "evidence_set_composition_members" USING btree ("project_id","composition_revision_id","sort_order");--> statement-breakpoint
CREATE INDEX "evidence_set_composition_members_project_membership_idx" ON "evidence_set_composition_members" USING btree ("project_id","membership_id");--> statement-breakpoint
CREATE INDEX "evidence_set_composition_revisions_project_set_sequence_idx" ON "evidence_set_composition_revisions" USING btree ("project_id","evidence_set_id","sequence");--> statement-breakpoint
CREATE INDEX "evidence_set_memberships_project_set_idx" ON "evidence_set_memberships" USING btree ("project_id","evidence_set_id");--> statement-breakpoint
CREATE INDEX "evidence_set_memberships_project_evidence_idx" ON "evidence_set_memberships" USING btree ("project_id","evidence_id");--> statement-breakpoint
CREATE INDEX "evidence_sets_project_created_at_idx" ON "evidence_sets" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_sets_active_name_unique" ON "evidence_sets" USING btree ("project_id",lower(btrim("name"))) WHERE "evidence_sets"."archived_at" is null;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_evidence_set_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Evidence Set history is append-only';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_set_memberships_append_only
BEFORE UPDATE OR DELETE ON evidence_set_memberships
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_history_mutation();--> statement-breakpoint
CREATE TRIGGER evidence_set_composition_revisions_append_only
BEFORE UPDATE OR DELETE ON evidence_set_composition_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_history_mutation();--> statement-breakpoint
CREATE TRIGGER evidence_set_composition_members_append_only
BEFORE UPDATE OR DELETE ON evidence_set_composition_members
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_history_mutation();--> statement-breakpoint
CREATE TRIGGER evidence_set_annotations_append_only
BEFORE UPDATE OR DELETE ON evidence_set_annotations
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_history_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_evidence_set_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence Sets are archive-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Evidence Set identity is immutable';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived Evidence Sets cannot be changed';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
    AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'Archiving an Evidence Set cannot change its metadata';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NULL THEN
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_sets_archive_only
BEFORE UPDATE OR DELETE ON evidence_sets
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION require_evidence_set_initial_snapshot() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  created_revision_id uuid;
BEGIN
  SELECT r.id INTO created_revision_id
  FROM evidence_set_composition_revisions r
  WHERE r.project_id = NEW.project_id
    AND r.evidence_set_id = NEW.id
    AND r.operation_kind = 'created'
  ORDER BY r.sequence
  LIMIT 1;
  IF created_revision_id IS NULL
    OR EXISTS (SELECT 1 FROM evidence_set_composition_members m WHERE m.project_id = NEW.project_id AND m.evidence_set_id = NEW.id AND m.composition_revision_id = created_revision_id) THEN
    RAISE EXCEPTION 'Every Evidence Set requires one initial empty composition snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER evidence_sets_initial_snapshot_required
AFTER INSERT ON evidence_sets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_evidence_set_initial_snapshot();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_evidence_set_composition_revision() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_id uuid;
  project_id_value uuid;
  evidence_set_id_value uuid;
  operation_kind_value text;
  current_sequence bigint;
  previous_sequence bigint;
  current_count integer;
  previous_count integer;
  newly_active_count integer;
  disappeared_count integer;
  new_membership_id uuid;
  current_ids uuid[];
  previous_ids uuid[];
  current_existing_ids uuid[];
  previous_survivor_ids uuid[];
  new_sort_order integer;
  has_prior_activation boolean;
  set_archived_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'evidence_set_composition_revisions' THEN
    revision_id := NEW.id;
    project_id_value := NEW.project_id;
    evidence_set_id_value := NEW.evidence_set_id;
  ELSE
    revision_id := NEW.composition_revision_id;
    project_id_value := NEW.project_id;
    evidence_set_id_value := NEW.evidence_set_id;
  END IF;

  SELECT r.operation_kind, r.sequence INTO operation_kind_value, current_sequence
  FROM evidence_set_composition_revisions r
  WHERE r.project_id = project_id_value AND r.evidence_set_id = evidence_set_id_value AND r.id = revision_id;
  IF operation_kind_value IS NULL THEN
    RAISE EXCEPTION 'Evidence Set composition revision ownership is invalid' USING ERRCODE = '23503';
  END IF;

  SELECT archived_at INTO set_archived_at
  FROM evidence_sets
  WHERE project_id = project_id_value AND id = evidence_set_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence Set does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF set_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived Evidence Sets cannot receive composition history' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer, coalesce(array_agg(m.membership_id ORDER BY m.sort_order), ARRAY[]::uuid[])
    INTO current_count, current_ids
  FROM evidence_set_composition_members m
  WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value AND m.composition_revision_id = revision_id;
  IF current_count > 0 AND EXISTS (
    SELECT 1 FROM generate_series(1, current_count) expected(position)
    WHERE NOT EXISTS (
      SELECT 1 FROM evidence_set_composition_members m
      WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value
        AND m.composition_revision_id = revision_id AND m.sort_order = expected.position
    )
  ) THEN
    RAISE EXCEPTION 'Evidence Set composition order must be contiguous from 1 to N' USING ERRCODE = '23514';
  END IF;

  SELECT r.sequence INTO previous_sequence
  FROM evidence_set_composition_revisions r
  WHERE r.project_id = project_id_value AND r.evidence_set_id = evidence_set_id_value AND r.sequence < current_sequence
  ORDER BY r.sequence DESC
  LIMIT 1;

  IF operation_kind_value = 'created' THEN
    IF previous_sequence IS NOT NULL OR current_count <> 0
      OR EXISTS (SELECT 1 FROM evidence_set_composition_revisions r WHERE r.project_id = project_id_value AND r.evidence_set_id = evidence_set_id_value AND r.operation_kind = 'created' AND r.sequence <> current_sequence) THEN
      RAISE EXCEPTION 'created Evidence Set composition must be the sole initial empty snapshot' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF previous_sequence IS NULL THEN
    RAISE EXCEPTION 'Non-created Evidence Set composition requires a predecessor' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(array_agg(m.membership_id ORDER BY m.sort_order), ARRAY[]::uuid[]), count(*)::integer
    INTO previous_ids, previous_count
  FROM evidence_set_composition_members m
  WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value
    AND m.composition_revision_id = (SELECT r.id FROM evidence_set_composition_revisions r WHERE r.project_id = project_id_value AND r.evidence_set_id = evidence_set_id_value AND r.sequence = previous_sequence);

  SELECT count(*)::integer INTO newly_active_count
  FROM unnest(current_ids) current_membership(id)
  WHERE NOT (current_membership.id = ANY(previous_ids));
  SELECT count(*)::integer INTO disappeared_count
  FROM unnest(previous_ids) previous_membership(id)
  WHERE NOT (previous_membership.id = ANY(current_ids));

  IF newly_active_count = 1 THEN
    SELECT current_membership.id INTO new_membership_id
    FROM unnest(current_ids) current_membership(id)
    WHERE NOT (current_membership.id = ANY(previous_ids));
    SELECT m.sort_order INTO new_sort_order
    FROM evidence_set_composition_members m
    WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value
      AND m.composition_revision_id = revision_id AND m.membership_id = new_membership_id;
  END IF;
  SELECT coalesce(array_agg(m.membership_id ORDER BY m.sort_order), ARRAY[]::uuid[])
    INTO current_existing_ids
  FROM evidence_set_composition_members m
  WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value
    AND m.composition_revision_id = revision_id AND m.membership_id = ANY(previous_ids);
  SELECT coalesce(array_agg(m.membership_id ORDER BY m.sort_order), ARRAY[]::uuid[])
    INTO previous_survivor_ids
  FROM evidence_set_composition_members m
  WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value
    AND m.composition_revision_id = (SELECT r.id FROM evidence_set_composition_revisions r WHERE r.project_id = project_id_value AND r.evidence_set_id = evidence_set_id_value AND r.sequence = previous_sequence)
    AND m.membership_id = ANY(current_ids);

  IF operation_kind_value IN ('added', 'readded') THEN
    IF current_count <> previous_count + 1 OR newly_active_count <> 1 OR disappeared_count <> 0
      OR new_sort_order <> current_count OR current_existing_ids <> previous_ids THEN
      RAISE EXCEPTION '% composition does not match its predecessor transition', operation_kind_value USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM evidence_set_composition_members m
      JOIN evidence_set_composition_revisions r ON r.project_id = m.project_id AND r.evidence_set_id = m.evidence_set_id AND r.id = m.composition_revision_id
      WHERE m.project_id = project_id_value AND m.evidence_set_id = evidence_set_id_value AND m.membership_id = new_membership_id AND r.sequence < current_sequence
    ) INTO has_prior_activation;
    IF operation_kind_value = 'added' AND has_prior_activation THEN
      RAISE EXCEPTION 'added composition must activate a never-before-active membership' USING ERRCODE = '23514';
    END IF;
    IF operation_kind_value = 'readded' AND NOT has_prior_activation THEN
      RAISE EXCEPTION 'readded composition must activate a historically active membership' USING ERRCODE = '23514';
    END IF;
  ELSIF operation_kind_value = 'removed' THEN
    IF current_count <> previous_count - 1 OR newly_active_count <> 0 OR disappeared_count <> 1 OR current_existing_ids <> previous_survivor_ids THEN
      RAISE EXCEPTION 'removed composition does not match its predecessor transition' USING ERRCODE = '23514';
    END IF;
  ELSIF operation_kind_value = 'reordered' THEN
    IF current_count <> previous_count OR newly_active_count <> 0 OR disappeared_count <> 0 OR current_ids = previous_ids THEN
      RAISE EXCEPTION 'reordered composition must preserve the active set and change at least one position' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported Evidence Set composition operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER evidence_set_composition_revision_transition_validation
AFTER INSERT ON evidence_set_composition_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_evidence_set_composition_revision();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER evidence_set_composition_member_transition_validation
AFTER INSERT ON evidence_set_composition_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_evidence_set_composition_revision();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_evidence_set_history_insert() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  archived_at_value timestamptz;
BEGIN
  SELECT archived_at INTO archived_at_value
  FROM evidence_sets
  WHERE project_id = NEW.project_id AND id = NEW.evidence_set_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence Set does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF archived_at_value IS NOT NULL THEN
    RAISE EXCEPTION 'Archived Evidence Sets are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_set_composition_revisions_active_guard
BEFORE INSERT ON evidence_set_composition_revisions
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_history_insert();--> statement-breakpoint
CREATE TRIGGER evidence_set_memberships_active_guard
BEFORE INSERT ON evidence_set_memberships
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_history_insert();--> statement-breakpoint
CREATE TRIGGER evidence_set_annotations_active_guard
BEFORE INSERT ON evidence_set_annotations
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_history_insert();
