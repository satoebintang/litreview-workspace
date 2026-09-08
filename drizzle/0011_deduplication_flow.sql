-- Slice 10: append-only record-pair adjudication and derived review-flow state.
-- RetrievedRecords already carry the published denormalized SearchSource FK;
-- candidate discovery uses that released ownership model.
CREATE TABLE "retrieved_record_deduplication_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "left_retrieved_record_id" uuid NOT NULL,
  "right_retrieved_record_id" uuid NOT NULL,
  "decision" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "retrieved_record_deduplication_decisions_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "retrieved_record_deduplication_decisions_decision_valid" CHECK ("decision" IN ('same_work', 'different_work')),
  CONSTRAINT "retrieved_record_deduplication_decisions_ordered_distinct_pair" CHECK ("left_retrieved_record_id" < "right_retrieved_record_id"),
  CONSTRAINT "retrieved_record_deduplication_decisions_note_nonblank" CHECK ("note" IS NULL OR btrim("note") <> '')
);
--> statement-breakpoint
ALTER TABLE "retrieved_record_deduplication_decisions" ADD CONSTRAINT "retrieved_record_deduplication_decisions_project_left_record_fk" FOREIGN KEY ("project_id", "left_retrieved_record_id") REFERENCES "public"."retrieved_records"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "retrieved_record_deduplication_decisions" ADD CONSTRAINT "retrieved_record_deduplication_decisions_project_right_record_fk" FOREIGN KEY ("project_id", "right_retrieved_record_id") REFERENCES "public"."retrieved_records"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "retrieved_record_deduplication_decisions_project_pair_sequence_idx" ON "retrieved_record_deduplication_decisions" USING btree ("project_id", "left_retrieved_record_id", "right_retrieved_record_id", "sequence");
--> statement-breakpoint
CREATE INDEX "retrieved_record_deduplication_decisions_project_right_record_sequence_idx" ON "retrieved_record_deduplication_decisions" USING btree ("project_id", "right_retrieved_record_id", "sequence");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_retrieved_record_deduplication_decision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'RetrievedRecordDeduplicationDecisions are append-only';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER retrieved_record_deduplication_decisions_append_only
BEFORE UPDATE OR DELETE ON "retrieved_record_deduplication_decisions"
FOR EACH ROW EXECUTE FUNCTION prevent_retrieved_record_deduplication_decision_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION assert_retrieved_record_deduplication_pair_consistent(
  target_project_id uuid,
  target_left_record_id uuid,
  target_right_record_id uuid
) RETURNS void
LANGUAGE plpgsql AS $function$
DECLARE
  latest_decision text;
  left_paper_id uuid;
  right_paper_id uuid;
BEGIN
  SELECT d.decision INTO latest_decision
  FROM retrieved_record_deduplication_decisions d
  WHERE d.project_id = target_project_id
    AND d.left_retrieved_record_id = target_left_record_id
    AND d.right_retrieved_record_id = target_right_record_id
  ORDER BY d.sequence DESC LIMIT 1;
  IF latest_decision IS NULL THEN RETURN; END IF;

  SELECT CASE WHEN m.action = 'linked' THEN m.paper_id ELSE NULL END INTO left_paper_id
  FROM retrieved_record_matches m
  WHERE m.project_id = target_project_id AND m.retrieved_record_id = target_left_record_id
  ORDER BY m.sequence DESC LIMIT 1;
  SELECT CASE WHEN m.action = 'linked' THEN m.paper_id ELSE NULL END INTO right_paper_id
  FROM retrieved_record_matches m
  WHERE m.project_id = target_project_id AND m.retrieved_record_id = target_right_record_id
  ORDER BY m.sequence DESC LIMIT 1;

  IF latest_decision = 'same_work' AND left_paper_id IS NOT NULL AND right_paper_id IS NOT NULL AND left_paper_id IS DISTINCT FROM right_paper_id THEN
    RAISE EXCEPTION 'same_work_conflicts_with_distinct_canonical_papers';
  ELSIF latest_decision = 'different_work' AND left_paper_id IS NOT NULL AND left_paper_id IS NOT DISTINCT FROM right_paper_id THEN
    RAISE EXCEPTION 'different_work_conflicts_with_shared_canonical_paper';
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_retrieved_record_deduplication_decision() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  pair record;
BEGIN
  IF TG_TABLE_NAME = 'retrieved_record_deduplication_decisions' THEN
    PERFORM assert_retrieved_record_deduplication_pair_consistent(NEW.project_id, NEW.left_retrieved_record_id, NEW.right_retrieved_record_id);
  ELSE
    FOR pair IN
      SELECT DISTINCT d.left_retrieved_record_id, d.right_retrieved_record_id
      FROM retrieved_record_deduplication_decisions d
      WHERE d.project_id = NEW.project_id
        AND (d.left_retrieved_record_id = NEW.retrieved_record_id OR d.right_retrieved_record_id = NEW.retrieved_record_id)
    LOOP
      PERFORM assert_retrieved_record_deduplication_pair_consistent(NEW.project_id, pair.left_retrieved_record_id, pair.right_retrieved_record_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER retrieved_record_deduplication_decision_consistency
AFTER INSERT ON "retrieved_record_deduplication_decisions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_retrieved_record_deduplication_decision();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER retrieved_record_match_deduplication_consistency
AFTER INSERT ON "retrieved_record_matches"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_retrieved_record_deduplication_decision();
