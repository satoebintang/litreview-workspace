ALTER TABLE "manuscripts" ADD COLUMN "citation_style" text DEFAULT 'numeric' NOT NULL;--> statement-breakpoint
ALTER TABLE "manuscripts" ADD CONSTRAINT "manuscripts_citation_style_valid" CHECK ("manuscripts"."citation_style" in ('numeric', 'author_year'));
