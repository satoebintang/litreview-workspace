CREATE TABLE "appraisal_framework_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"guidance" text,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisal_framework_items_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_framework_items_project_version_id_id_unique" UNIQUE("project_id","framework_version_id","id"),
	CONSTRAINT "appraisal_framework_items_project_section_order_unique" UNIQUE("project_id","section_id","sort_order") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "appraisal_framework_items_prompt_shape" CHECK (btrim("appraisal_framework_items"."prompt") <> '' and char_length("appraisal_framework_items"."prompt") <= 2000),
	CONSTRAINT "appraisal_framework_items_guidance_shape" CHECK ("appraisal_framework_items"."guidance" is null or char_length("appraisal_framework_items"."guidance") <= 10000),
	CONSTRAINT "appraisal_framework_items_sort_order_positive" CHECK ("appraisal_framework_items"."sort_order" >= 1 and "appraisal_framework_items"."sort_order" <= 200)
);
--> statement-breakpoint
CREATE TABLE "appraisal_framework_overall_judgement_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"option_key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisal_framework_overall_judgement_options_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_framework_overall_judgement_options_project_version_id_id_unique" UNIQUE("project_id","framework_version_id","id"),
	CONSTRAINT "appraisal_framework_overall_judgement_options_project_version_order_unique" UNIQUE("project_id","framework_version_id","sort_order") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "appraisal_framework_overall_judgement_options_key_shape" CHECK (btrim("appraisal_framework_overall_judgement_options"."option_key") <> '' and char_length("appraisal_framework_overall_judgement_options"."option_key") <= 100),
	CONSTRAINT "appraisal_framework_overall_judgement_options_label_shape" CHECK (btrim("appraisal_framework_overall_judgement_options"."label") <> '' and char_length("appraisal_framework_overall_judgement_options"."label") <= 500),
	CONSTRAINT "appraisal_framework_overall_judgement_options_sort_order_positive" CHECK ("appraisal_framework_overall_judgement_options"."sort_order" >= 1 and "appraisal_framework_overall_judgement_options"."sort_order" <= 20)
);
--> statement-breakpoint
CREATE TABLE "appraisal_framework_response_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"option_key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisal_framework_response_options_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_framework_response_options_project_item_id_id_unique" UNIQUE("project_id","framework_version_id","item_id","id"),
	CONSTRAINT "appraisal_framework_response_options_project_item_order_unique" UNIQUE("project_id","framework_version_id","item_id","sort_order") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "appraisal_framework_response_options_key_shape" CHECK (btrim("appraisal_framework_response_options"."option_key") <> '' and char_length("appraisal_framework_response_options"."option_key") <= 100),
	CONSTRAINT "appraisal_framework_response_options_label_shape" CHECK (btrim("appraisal_framework_response_options"."label") <> '' and char_length("appraisal_framework_response_options"."label") <= 500),
	CONSTRAINT "appraisal_framework_response_options_sort_order_positive" CHECK ("appraisal_framework_response_options"."sort_order" >= 1 and "appraisal_framework_response_options"."sort_order" <= 20)
);
--> statement-breakpoint
CREATE TABLE "appraisal_framework_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisal_framework_sections_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_framework_sections_project_version_id_id_unique" UNIQUE("project_id","framework_version_id","id"),
	CONSTRAINT "appraisal_framework_sections_project_version_order_unique" UNIQUE("project_id","framework_version_id","sort_order") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "appraisal_framework_sections_label_shape" CHECK (btrim("appraisal_framework_sections"."label") <> '' and char_length("appraisal_framework_sections"."label") <= 200),
	CONSTRAINT "appraisal_framework_sections_description_shape" CHECK ("appraisal_framework_sections"."description" is null or char_length("appraisal_framework_sections"."description") <= 5000),
	CONSTRAINT "appraisal_framework_sections_sort_order_positive" CHECK ("appraisal_framework_sections"."sort_order" >= 1 and "appraisal_framework_sections"."sort_order" <= 50)
);
--> statement-breakpoint
CREATE TABLE "appraisal_framework_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"version_label" text NOT NULL,
	"description" text,
	"citation" text,
	"external_reference_url" text,
	"rights_note" text,
	"instructions" text,
	"intended_study_design" text,
	"applicability_note" text,
	"overall_judgement_required" boolean DEFAULT false NOT NULL,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "appraisal_framework_versions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_framework_versions_framework_version_number_unique" UNIQUE("project_id","framework_id","version_number"),
	CONSTRAINT "appraisal_framework_versions_project_id_id_framework_unique" UNIQUE("project_id","id","framework_id"),
	CONSTRAINT "appraisal_framework_versions_version_number_positive" CHECK ("appraisal_framework_versions"."version_number" >= 1),
	CONSTRAINT "appraisal_framework_versions_version_label_shape" CHECK (btrim("appraisal_framework_versions"."version_label") <> '' and char_length("appraisal_framework_versions"."version_label") <= 100),
	CONSTRAINT "appraisal_framework_versions_description_shape" CHECK ("appraisal_framework_versions"."description" is null or char_length("appraisal_framework_versions"."description") <= 10000),
	CONSTRAINT "appraisal_framework_versions_citation_shape" CHECK ("appraisal_framework_versions"."citation" is null or char_length("appraisal_framework_versions"."citation") <= 10000),
	CONSTRAINT "appraisal_framework_versions_external_reference_shape" CHECK ("appraisal_framework_versions"."external_reference_url" is null or (char_length("appraisal_framework_versions"."external_reference_url") <= 2048 and "appraisal_framework_versions"."external_reference_url" ~ '^https?://')),
	CONSTRAINT "appraisal_framework_versions_rights_note_shape" CHECK ("appraisal_framework_versions"."rights_note" is null or char_length("appraisal_framework_versions"."rights_note") <= 10000),
	CONSTRAINT "appraisal_framework_versions_instructions_shape" CHECK ("appraisal_framework_versions"."instructions" is null or char_length("appraisal_framework_versions"."instructions") <= 20000),
	CONSTRAINT "appraisal_framework_versions_intended_design_shape" CHECK ("appraisal_framework_versions"."intended_study_design" is null or char_length("appraisal_framework_versions"."intended_study_design") <= 1000),
	CONSTRAINT "appraisal_framework_versions_applicability_shape" CHECK ("appraisal_framework_versions"."applicability_note" is null or char_length("appraisal_framework_versions"."applicability_note") <= 10000),
	CONSTRAINT "appraisal_framework_versions_draft_revision_nonnegative" CHECK ("appraisal_framework_versions"."draft_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "appraisal_frameworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "appraisal_frameworks_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_frameworks_name_shape" CHECK (btrim("appraisal_frameworks"."name") <> '' and char_length("appraisal_frameworks"."name") <= 200)
);
--> statement-breakpoint
CREATE TABLE "appraisal_revision_response_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"appraisal_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"framework_item_id" uuid NOT NULL,
	"response_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"evidence_review_decision_id_at_save" uuid,
	"evidence_review_state_at_save" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisal_revision_response_evidence_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_revision_response_evidence_response_evidence_unique" UNIQUE("project_id","response_id","evidence_id"),
	CONSTRAINT "appraisal_revision_response_evidence_review_state_valid" CHECK ("appraisal_revision_response_evidence"."evidence_review_state_at_save" in ('unreviewed', 'needs_review', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "appraisal_revision_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"framework_item_id" uuid NOT NULL,
	"selected_option_id" uuid,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisal_revision_responses_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_revision_responses_project_revision_item_unique" UNIQUE("project_id","revision_id","framework_item_id"),
	CONSTRAINT "appraisal_revision_responses_project_identity_unique" UNIQUE("project_id","revision_id","id","framework_version_id","framework_item_id"),
	CONSTRAINT "appraisal_revision_responses_rationale_shape" CHECK ("appraisal_revision_responses"."rationale" is null or char_length("appraisal_revision_responses"."rationale") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "appraisal_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "appraisal_revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"revision_number" integer NOT NULL,
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"appraisal_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"title_abstract_decision_id" uuid NOT NULL,
	"full_text_decision_id" uuid NOT NULL,
	"overall_judgement_option_id" uuid,
	"overall_rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "appraisal_revisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisal_revisions_project_appraisal_revision_number_unique" UNIQUE("project_id","appraisal_id","revision_number"),
	CONSTRAINT "appraisal_revisions_project_identity_unique" UNIQUE("project_id","id","paper_id","framework_id","appraisal_id","framework_version_id"),
	CONSTRAINT "appraisal_revisions_revision_number_positive" CHECK ("appraisal_revisions"."revision_number" >= 1),
	CONSTRAINT "appraisal_revisions_overall_rationale_shape" CHECK ("appraisal_revisions"."overall_rationale" is null or char_length("appraisal_revisions"."overall_rationale") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "appraisals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appraisals_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "appraisals_project_paper_framework_unique" UNIQUE("project_id","paper_id","framework_id"),
	CONSTRAINT "appraisals_project_id_paper_framework_unique" UNIQUE("project_id","id","paper_id","framework_id")
);
--> statement-breakpoint
ALTER TABLE "evidence_review_decisions" ADD CONSTRAINT "evidence_review_decisions_project_evidence_id_id_unique" UNIQUE("project_id","evidence_id","id");--> statement-breakpoint
ALTER TABLE "full_text_screening_decisions" ADD CONSTRAINT "full_text_screening_decisions_project_paper_id_id_unique" UNIQUE("project_id","paper_id","id");--> statement-breakpoint
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_project_paper_id_id_unique" UNIQUE("project_id","paper_id","id");--> statement-breakpoint
ALTER TABLE "appraisal_framework_items" ADD CONSTRAINT "appraisal_framework_items_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_items" ADD CONSTRAINT "appraisal_framework_items_version_fk" FOREIGN KEY ("project_id","framework_version_id") REFERENCES "public"."appraisal_framework_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_items" ADD CONSTRAINT "appraisal_framework_items_section_fk" FOREIGN KEY ("project_id","framework_version_id","section_id") REFERENCES "public"."appraisal_framework_sections"("project_id","framework_version_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_overall_judgement_options" ADD CONSTRAINT "appraisal_framework_overall_judgement_options_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_overall_judgement_options" ADD CONSTRAINT "appraisal_framework_overall_judgement_options_version_fk" FOREIGN KEY ("project_id","framework_version_id") REFERENCES "public"."appraisal_framework_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_response_options" ADD CONSTRAINT "appraisal_framework_response_options_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_response_options" ADD CONSTRAINT "appraisal_framework_response_options_item_fk" FOREIGN KEY ("project_id","framework_version_id","item_id") REFERENCES "public"."appraisal_framework_items"("project_id","framework_version_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_sections" ADD CONSTRAINT "appraisal_framework_sections_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_sections" ADD CONSTRAINT "appraisal_framework_sections_version_fk" FOREIGN KEY ("project_id","framework_version_id") REFERENCES "public"."appraisal_framework_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_versions" ADD CONSTRAINT "appraisal_framework_versions_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_framework_versions" ADD CONSTRAINT "appraisal_framework_versions_framework_fk" FOREIGN KEY ("project_id","framework_id") REFERENCES "public"."appraisal_frameworks"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_frameworks" ADD CONSTRAINT "appraisal_frameworks_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_framework_fk" FOREIGN KEY ("project_id","framework_id") REFERENCES "public"."appraisal_frameworks"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_appraisal_fk" FOREIGN KEY ("project_id","appraisal_id","paper_id","framework_id") REFERENCES "public"."appraisals"("project_id","id","paper_id","framework_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_revision_fk" FOREIGN KEY ("project_id","revision_id","paper_id","framework_id","appraisal_id","framework_version_id") REFERENCES "public"."appraisal_revisions"("project_id","id","paper_id","framework_id","appraisal_id","framework_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_response_fk" FOREIGN KEY ("project_id","revision_id","response_id","framework_version_id","framework_item_id") REFERENCES "public"."appraisal_revision_responses"("project_id","revision_id","id","framework_version_id","framework_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_item_fk" FOREIGN KEY ("project_id","framework_version_id","framework_item_id") REFERENCES "public"."appraisal_framework_items"("project_id","framework_version_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_evidence_fk" FOREIGN KEY ("project_id","paper_id","evidence_id") REFERENCES "public"."evidence"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_response_evidence" ADD CONSTRAINT "appraisal_revision_response_evidence_review_decision_fk" FOREIGN KEY ("project_id","evidence_id","evidence_review_decision_id_at_save") REFERENCES "public"."evidence_review_decisions"("project_id","evidence_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_responses" ADD CONSTRAINT "appraisal_revision_responses_revision_fk" FOREIGN KEY ("project_id","revision_id") REFERENCES "public"."appraisal_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_responses" ADD CONSTRAINT "appraisal_revision_responses_item_fk" FOREIGN KEY ("project_id","framework_version_id","framework_item_id") REFERENCES "public"."appraisal_framework_items"("project_id","framework_version_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revision_responses" ADD CONSTRAINT "appraisal_revision_responses_option_fk" FOREIGN KEY ("project_id","framework_version_id","framework_item_id","selected_option_id") REFERENCES "public"."appraisal_framework_response_options"("project_id","framework_version_id","item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_framework_fk" FOREIGN KEY ("project_id","framework_id") REFERENCES "public"."appraisal_frameworks"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_appraisal_fk" FOREIGN KEY ("project_id","appraisal_id","paper_id","framework_id") REFERENCES "public"."appraisals"("project_id","id","paper_id","framework_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_framework_version_fk" FOREIGN KEY ("project_id","framework_version_id","framework_id") REFERENCES "public"."appraisal_framework_versions"("project_id","id","framework_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_title_abstract_decision_fk" FOREIGN KEY ("project_id","paper_id","title_abstract_decision_id") REFERENCES "public"."screening_decisions"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_full_text_decision_fk" FOREIGN KEY ("project_id","paper_id","full_text_decision_id") REFERENCES "public"."full_text_screening_decisions"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_revisions" ADD CONSTRAINT "appraisal_revisions_overall_option_fk" FOREIGN KEY ("project_id","framework_version_id","overall_judgement_option_id") REFERENCES "public"."appraisal_framework_overall_judgement_options"("project_id","framework_version_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_framework_fk" FOREIGN KEY ("project_id","framework_id") REFERENCES "public"."appraisal_frameworks"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appraisal_framework_items_project_version_idx" ON "appraisal_framework_items" USING btree ("project_id","framework_version_id","sort_order","id");--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_framework_overall_judgement_options_project_version_key_unique" ON "appraisal_framework_overall_judgement_options" USING btree ("project_id","framework_version_id",lower(btrim("option_key")));--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_framework_overall_judgement_options_project_version_label_unique" ON "appraisal_framework_overall_judgement_options" USING btree ("project_id","framework_version_id",lower(btrim("label")));--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_framework_response_options_project_item_key_unique" ON "appraisal_framework_response_options" USING btree ("project_id","framework_version_id","item_id",lower(btrim("option_key")));--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_framework_response_options_project_item_label_unique" ON "appraisal_framework_response_options" USING btree ("project_id","framework_version_id","item_id",lower(btrim("label")));--> statement-breakpoint
CREATE INDEX "appraisal_framework_sections_project_version_idx" ON "appraisal_framework_sections" USING btree ("project_id","framework_version_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_framework_versions_framework_version_label_unique" ON "appraisal_framework_versions" USING btree ("project_id","framework_id",lower(btrim("version_label")));--> statement-breakpoint
CREATE INDEX "appraisal_framework_versions_project_framework_idx" ON "appraisal_framework_versions" USING btree ("project_id","framework_id","version_number");--> statement-breakpoint
CREATE INDEX "appraisal_frameworks_project_created_at_idx" ON "appraisal_frameworks" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_frameworks_project_name_unique" ON "appraisal_frameworks" USING btree ("project_id",lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "appraisal_revisions_project_appraisal_sequence_idx" ON "appraisal_revisions" USING btree ("project_id","appraisal_id","sequence");--> statement-breakpoint
CREATE OR REPLACE FUNCTION appraisal_framework_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  finalized_version_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appraisal frameworks cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'Appraisal framework archival is one-way' USING ERRCODE = '23514';
    END IF;
    IF OLD.archived_at IS NOT NULL AND (
      NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
      NEW.name IS DISTINCT FROM OLD.name OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Archived appraisal frameworks are immutable' USING ERRCODE = '23514';
    END IF;
    SELECT exists(
      SELECT 1 FROM appraisal_framework_versions v
      WHERE v.project_id = OLD.project_id AND v.framework_id = OLD.id AND v.finalized_at IS NOT NULL
    ) INTO finalized_version_exists;
    IF finalized_version_exists AND NEW.name IS DISTINCT FROM OLD.name THEN
      RAISE EXCEPTION 'A framework name is immutable after its first finalized version' USING ERRCODE = '23514';
    END IF;
    IF OLD.archived_at IS NULL AND NEW.archived_at IS NULL AND NEW.name IS DISTINCT FROM OLD.name AND finalized_version_exists THEN
      RAISE EXCEPTION 'A framework name is immutable after its first finalized version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;--> statement-breakpoint

CREATE TRIGGER appraisal_framework_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_frameworks
FOR EACH ROW EXECUTE FUNCTION appraisal_framework_mutation_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION appraisal_framework_version_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  framework_archived_at timestamptz;
  draft_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appraisal framework versions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  SELECT archived_at INTO framework_archived_at
  FROM appraisal_frameworks
  WHERE project_id = COALESCE(NEW.project_id, OLD.project_id)
    AND id = COALESCE(NEW.framework_id, OLD.framework_id);
  IF framework_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived appraisal frameworks cannot be edited or finalized' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT exists(
      SELECT 1 FROM appraisal_framework_versions v
      WHERE v.project_id = NEW.project_id AND v.framework_id = NEW.framework_id
        AND v.finalized_at IS NULL AND v.id IS DISTINCT FROM NEW.id
    ) INTO draft_exists;
    IF draft_exists THEN
      RAISE EXCEPTION 'Only one draft framework version may exist per framework' USING ERRCODE = '23505';
    END IF;
  ELSE
    IF OLD.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Finalized framework versions are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.framework_id IS DISTINCT FROM OLD.framework_id OR NEW.version_number IS DISTINCT FROM OLD.version_number
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Framework version identity is immutable' USING ERRCODE = '23514';
    END IF;
    SELECT exists(
      SELECT 1 FROM appraisal_framework_versions v
      WHERE v.project_id = NEW.project_id AND v.framework_id = NEW.framework_id
        AND v.finalized_at IS NULL AND v.id IS DISTINCT FROM NEW.id
    ) INTO draft_exists;
    IF draft_exists THEN
      RAISE EXCEPTION 'Only one draft framework version may exist per framework' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;--> statement-breakpoint

CREATE TRIGGER appraisal_framework_version_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_framework_versions
FOR EACH ROW EXECUTE FUNCTION appraisal_framework_version_mutation_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION appraisal_framework_child_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  version_finalized_at timestamptz;
  framework_archived_at timestamptz;
BEGIN
  SELECT v.finalized_at, f.archived_at
    INTO version_finalized_at, framework_archived_at
  FROM appraisal_framework_versions v
  JOIN appraisal_frameworks f ON f.project_id = v.project_id AND f.id = v.framework_id
  WHERE v.project_id = COALESCE(NEW.project_id, OLD.project_id)
    AND v.id = COALESCE(NEW.framework_version_id, OLD.framework_version_id);
  IF version_finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finalized framework definitions are immutable' USING ERRCODE = '23514';
  END IF;
  IF framework_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived appraisal frameworks cannot be edited' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.framework_version_id IS DISTINCT FROM OLD.framework_version_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Framework definition identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;--> statement-breakpoint

CREATE TRIGGER appraisal_framework_sections_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_framework_sections
FOR EACH ROW EXECUTE FUNCTION appraisal_framework_child_mutation_guard();--> statement-breakpoint
CREATE TRIGGER appraisal_framework_items_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_framework_items
FOR EACH ROW EXECUTE FUNCTION appraisal_framework_child_mutation_guard();--> statement-breakpoint
CREATE TRIGGER appraisal_framework_response_options_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_framework_response_options
FOR EACH ROW EXECUTE FUNCTION appraisal_framework_child_mutation_guard();--> statement-breakpoint
CREATE TRIGGER appraisal_framework_overall_options_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_framework_overall_judgement_options
FOR EACH ROW EXECUTE FUNCTION appraisal_framework_child_mutation_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_finalized_appraisal_framework_version() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  version_finalized_at timestamptz;
  section_count integer;
  item_count integer;
  overall_count integer;
BEGIN
  SELECT finalized_at INTO version_finalized_at
  FROM appraisal_framework_versions
  WHERE project_id = NEW.project_id AND id = NEW.id;
  IF version_finalized_at IS NULL THEN RETURN NEW; END IF;
  SELECT count(*)::integer INTO section_count
  FROM appraisal_framework_sections
  WHERE project_id = NEW.project_id AND framework_version_id = NEW.id;
  IF section_count < 1 OR EXISTS (
    SELECT 1 FROM generate_series(1, section_count) n
    WHERE NOT EXISTS (SELECT 1 FROM appraisal_framework_sections s WHERE s.project_id = NEW.project_id AND s.framework_version_id = NEW.id AND s.sort_order = n)
  ) THEN
    RAISE EXCEPTION 'Finalized framework versions require contiguous sections' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO item_count
  FROM appraisal_framework_items
  WHERE project_id = NEW.project_id AND framework_version_id = NEW.id;
  IF item_count < 1 THEN
    RAISE EXCEPTION 'Finalized framework versions require at least one item' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM appraisal_framework_items i
    WHERE i.project_id = NEW.project_id AND i.framework_version_id = NEW.id
      AND NOT EXISTS (SELECT 1 FROM appraisal_framework_sections s WHERE s.project_id = i.project_id AND s.framework_version_id = i.framework_version_id AND s.id = i.section_id)
  ) THEN
    RAISE EXCEPTION 'Finalized framework items must belong to the exact version section' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM appraisal_framework_sections s
    WHERE s.project_id = NEW.project_id AND s.framework_version_id = NEW.id
      AND EXISTS (
        SELECT 1 FROM generate_series(1, (SELECT count(*)::integer FROM appraisal_framework_items i WHERE i.project_id = s.project_id AND i.framework_version_id = s.framework_version_id AND i.section_id = s.id)) n
        WHERE NOT EXISTS (SELECT 1 FROM appraisal_framework_items i WHERE i.project_id = s.project_id AND i.framework_version_id = s.framework_version_id AND i.section_id = s.id AND i.sort_order = n)
      )
  ) THEN
    RAISE EXCEPTION 'Finalized framework items require contiguous section ordering' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM appraisal_framework_items i
    WHERE i.project_id = NEW.project_id AND i.framework_version_id = NEW.id
      AND NOT EXISTS (SELECT 1 FROM appraisal_framework_response_options o WHERE o.project_id = i.project_id AND o.framework_version_id = i.framework_version_id AND o.item_id = i.id)
  ) THEN
    RAISE EXCEPTION 'Every finalized framework item requires at least one response option' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM appraisal_framework_items i
    WHERE i.project_id = NEW.project_id AND i.framework_version_id = NEW.id
      AND EXISTS (
        SELECT 1 FROM generate_series(1, (SELECT count(*)::integer FROM appraisal_framework_response_options o WHERE o.project_id = i.project_id AND o.framework_version_id = i.framework_version_id AND o.item_id = i.id)) n
        WHERE NOT EXISTS (SELECT 1 FROM appraisal_framework_response_options o WHERE o.project_id = i.project_id AND o.framework_version_id = i.framework_version_id AND o.item_id = i.id AND o.sort_order = n)
      )
  ) THEN
    RAISE EXCEPTION 'Finalized response options require contiguous item ordering' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO overall_count
  FROM appraisal_framework_overall_judgement_options
  WHERE project_id = NEW.project_id AND framework_version_id = NEW.id;
  IF NEW.overall_judgement_required AND overall_count < 1 THEN
    RAISE EXCEPTION 'Required overall judgement needs an overall vocabulary' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM generate_series(1, overall_count) n
    WHERE NOT EXISTS (SELECT 1 FROM appraisal_framework_overall_judgement_options o WHERE o.project_id = NEW.project_id AND o.framework_version_id = NEW.id AND o.sort_order = n)
  ) THEN
    RAISE EXCEPTION 'Overall judgement options require contiguous ordering' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER appraisal_framework_versions_completeness
AFTER INSERT OR UPDATE ON appraisal_framework_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_finalized_appraisal_framework_version();--> statement-breakpoint

CREATE OR REPLACE FUNCTION appraisal_identity_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Appraisal identities are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER appraisals_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisals
FOR EACH ROW EXECUTE FUNCTION appraisal_identity_mutation_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION appraisal_revision_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appraisal revisions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finalized appraisal revisions are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.paper_id IS DISTINCT FROM OLD.paper_id OR NEW.framework_id IS DISTINCT FROM OLD.framework_id
    OR NEW.appraisal_id IS DISTINCT FROM OLD.appraisal_id OR NEW.framework_version_id IS DISTINCT FROM OLD.framework_version_id
    OR NEW.title_abstract_decision_id IS DISTINCT FROM OLD.title_abstract_decision_id
    OR NEW.full_text_decision_id IS DISTINCT FROM OLD.full_text_decision_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Appraisal revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;--> statement-breakpoint
CREATE TRIGGER appraisal_revisions_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_revisions
FOR EACH ROW EXECUTE FUNCTION appraisal_revision_mutation_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION appraisal_revision_child_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_finalized_at timestamptz;
BEGIN
  SELECT finalized_at INTO revision_finalized_at
  FROM appraisal_revisions
  WHERE project_id = COALESCE(NEW.project_id, OLD.project_id)
    AND id = COALESCE(NEW.revision_id, OLD.revision_id);
  IF revision_finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finalized appraisal revision children are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appraisal revision children cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER appraisal_revision_responses_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_revision_responses
FOR EACH ROW EXECUTE FUNCTION appraisal_revision_child_mutation_guard();--> statement-breakpoint
CREATE TRIGGER appraisal_revision_response_evidence_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON appraisal_revision_response_evidence
FOR EACH ROW EXECUTE FUNCTION appraisal_revision_child_mutation_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_appraisal_revision_commit() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_revision appraisal_revisions;
  previous_revision appraisal_revisions;
  latest_version appraisal_framework_versions;
  current_ta record;
  current_ft record;
  item_count integer;
  response_count integer;
BEGIN
  SELECT * INTO current_revision FROM appraisal_revisions WHERE project_id = NEW.project_id AND id = NEW.id;
  IF current_revision.id IS NULL THEN RETURN NEW; END IF;
  IF current_revision.finalized_at IS NULL THEN
    RAISE EXCEPTION 'Unfinalized appraisal revisions cannot be committed' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO current_ta
  FROM screening_decisions
  WHERE project_id = current_revision.project_id AND paper_id = current_revision.paper_id AND stage = 'title_abstract'
  ORDER BY sequence DESC LIMIT 1;
  SELECT * INTO current_ft
  FROM full_text_screening_decisions
  WHERE project_id = current_revision.project_id AND paper_id = current_revision.paper_id
  ORDER BY sequence DESC LIMIT 1;
  IF current_ta.id IS NULL OR current_ta.id IS DISTINCT FROM current_revision.title_abstract_decision_id OR current_ta.decision IS DISTINCT FROM 'include' THEN
    RAISE EXCEPTION 'Appraisal revision must pin the latest included title/abstract decision' USING ERRCODE = '23514';
  END IF;
  IF current_ft.id IS NULL OR current_ft.id IS DISTINCT FROM current_revision.full_text_decision_id OR current_ft.decision IS DISTINCT FROM 'include' THEN
    RAISE EXCEPTION 'Appraisal revision must pin the latest included full-text decision' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO latest_version
  FROM appraisal_framework_versions
  WHERE project_id = current_revision.project_id AND framework_id = current_revision.framework_id AND finalized_at IS NOT NULL
  ORDER BY version_number DESC LIMIT 1;
  IF latest_version.id IS NULL THEN
    RAISE EXCEPTION 'Appraisal revisions require a finalized framework version' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous_revision
  FROM appraisal_revisions
  WHERE project_id = current_revision.project_id AND appraisal_id = current_revision.appraisal_id
    AND finalized_at IS NOT NULL AND revision_number < current_revision.revision_number
  ORDER BY revision_number DESC LIMIT 1;
  IF previous_revision.id IS NULL THEN
    IF current_revision.framework_version_id IS DISTINCT FROM latest_version.id THEN
      RAISE EXCEPTION 'The first appraisal revision must use the latest finalized framework version' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF current_revision.framework_version_id IS DISTINCT FROM previous_revision.framework_version_id
      AND (SELECT version_number FROM appraisal_framework_versions WHERE project_id = current_revision.project_id AND id = current_revision.framework_version_id)
          <= (SELECT version_number FROM appraisal_framework_versions WHERE project_id = current_revision.project_id AND id = previous_revision.framework_version_id) THEN
      RAISE EXCEPTION 'Appraisal framework versions may only move forward' USING ERRCODE = '23514';
    END IF;
    IF current_revision.framework_version_id IS DISTINCT FROM previous_revision.framework_version_id
      AND current_revision.framework_version_id IS DISTINCT FROM latest_version.id THEN
      RAISE EXCEPTION 'A reassessment must use the latest finalized framework version' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT count(*)::integer INTO item_count
  FROM appraisal_framework_items
  WHERE project_id = current_revision.project_id AND framework_version_id = current_revision.framework_version_id;
  SELECT count(*)::integer INTO response_count
  FROM appraisal_revision_responses
  WHERE project_id = current_revision.project_id AND revision_id = current_revision.id;
  IF item_count <> response_count THEN
    RAISE EXCEPTION 'Finalized appraisal revisions require exactly one response per framework item' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM appraisal_framework_items i
    WHERE i.project_id = current_revision.project_id AND i.framework_version_id = current_revision.framework_version_id
      AND NOT EXISTS (SELECT 1 FROM appraisal_revision_responses r WHERE r.project_id = current_revision.project_id AND r.revision_id = current_revision.id AND r.framework_item_id = i.id)
  ) OR EXISTS (
    SELECT 1 FROM appraisal_revision_responses r
    WHERE r.project_id = current_revision.project_id AND r.revision_id = current_revision.id
      AND NOT EXISTS (SELECT 1 FROM appraisal_framework_items i WHERE i.project_id = r.project_id AND i.framework_version_id = current_revision.framework_version_id AND i.id = r.framework_item_id)
  ) THEN
    RAISE EXCEPTION 'Finalized appraisal responses must match the exact framework version items' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER appraisal_revisions_commit_guard
AFTER INSERT OR UPDATE ON appraisal_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_appraisal_revision_commit();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_appraisal_evidence_snapshot() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_row appraisal_revisions;
  latest_decision record;
  current_state text;
  previous_revision_id uuid;
  pair_exists boolean;
BEGIN
  SELECT * INTO revision_row
  FROM appraisal_revisions
  WHERE project_id = NEW.project_id AND id = NEW.revision_id;
  IF revision_row.id IS NULL THEN
    RAISE EXCEPTION 'Appraisal evidence link references an unknown revision' USING ERRCODE = '23503';
  END IF;
  IF NEW.paper_id IS DISTINCT FROM revision_row.paper_id OR NEW.framework_id IS DISTINCT FROM revision_row.framework_id
    OR NEW.appraisal_id IS DISTINCT FROM revision_row.appraisal_id OR NEW.framework_version_id IS DISTINCT FROM revision_row.framework_version_id THEN
    RAISE EXCEPTION 'Appraisal Evidence provenance does not match the exact revision' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM evidence WHERE project_id = NEW.project_id AND paper_id = NEW.paper_id AND id = NEW.evidence_id FOR UPDATE;
  SELECT id, decision INTO latest_decision
  FROM evidence_review_decisions
  WHERE project_id = NEW.project_id AND evidence_id = NEW.evidence_id
  ORDER BY sequence DESC LIMIT 1;
  current_state := CASE WHEN latest_decision.id IS NULL THEN 'unreviewed' ELSE latest_decision.decision END;
  IF NEW.evidence_review_decision_id_at_save IS DISTINCT FROM latest_decision.id
    OR NEW.evidence_review_state_at_save IS DISTINCT FROM current_state THEN
    RAISE EXCEPTION 'Appraisal Evidence review snapshot must match the latest decision at save' USING ERRCODE = '23514';
  END IF;
  IF current_state = 'rejected' THEN
    SELECT r.id INTO previous_revision_id
    FROM appraisal_revisions r
    WHERE r.project_id = revision_row.project_id AND r.appraisal_id = revision_row.appraisal_id
      AND r.revision_number < revision_row.revision_number AND r.finalized_at IS NOT NULL
    ORDER BY r.revision_number DESC LIMIT 1;
    SELECT EXISTS(
      SELECT 1
      FROM appraisal_revision_response_evidence previous_link
      WHERE previous_link.project_id = NEW.project_id AND previous_link.revision_id = previous_revision_id
        AND previous_link.framework_version_id = NEW.framework_version_id
        AND previous_link.framework_item_id = NEW.framework_item_id
        AND previous_link.evidence_id = NEW.evidence_id
    ) INTO pair_exists;
    IF NOT pair_exists THEN
      RAISE EXCEPTION 'Rejected Evidence may only carry forward from the immediately preceding same-version item pair' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

CREATE TRIGGER appraisal_revision_evidence_snapshot_guard
BEFORE INSERT OR UPDATE ON appraisal_revision_response_evidence
FOR EACH ROW EXECUTE FUNCTION validate_appraisal_evidence_snapshot();--> statement-breakpoint
