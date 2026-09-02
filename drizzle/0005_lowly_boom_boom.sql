CREATE TABLE "project_media" (
	"media_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"public_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" integer NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_media" ADD CONSTRAINT "project_media_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_media" ADD CONSTRAINT "project_media_uploaded_by_users_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_media_project_id_created_at_idx" ON "project_media" USING btree ("project_id","created_at");