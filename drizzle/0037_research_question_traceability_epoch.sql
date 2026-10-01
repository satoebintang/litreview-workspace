ALTER TABLE "research_questions" ADD COLUMN "traceability_epoch" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION increment_research_question_traceability_epoch() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE research_questions
  SET traceability_epoch = traceability_epoch + 1
  WHERE project_id = NEW.project_id
    AND id = NEW.research_question_id;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER rq_extraction_field_events_epoch_after_insert
AFTER INSERT ON research_question_extraction_field_events
FOR EACH ROW EXECUTE FUNCTION increment_research_question_traceability_epoch();
--> statement-breakpoint
CREATE TRIGGER rq_evidence_set_events_epoch_after_insert
AFTER INSERT ON research_question_evidence_set_events
FOR EACH ROW EXECUTE FUNCTION increment_research_question_traceability_epoch();
--> statement-breakpoint
CREATE TRIGGER rq_synthesis_statement_events_epoch_after_insert
AFTER INSERT ON research_question_synthesis_statement_events
FOR EACH ROW EXECUTE FUNCTION increment_research_question_traceability_epoch();
--> statement-breakpoint
CREATE TRIGGER rq_claim_events_epoch_after_insert
AFTER INSERT ON research_question_claim_events
FOR EACH ROW EXECUTE FUNCTION increment_research_question_traceability_epoch();
