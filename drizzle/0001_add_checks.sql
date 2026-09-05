ALTER TABLE "claims" ADD CONSTRAINT "claims_text_nonblank" CHECK (btrim("claims"."claim_text") <> '');--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_text_nonblank" CHECK (btrim("evidence"."source_text") <> '');--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_page_positive" CHECK ("evidence"."page_number" > 0);--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_title_nonblank" CHECK (btrim("papers"."title") <> '');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_title_nonblank" CHECK (btrim("projects"."title") <> '');