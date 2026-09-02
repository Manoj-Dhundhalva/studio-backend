CREATE TYPE "public"."canvas_element_type" AS ENUM('rect', 'ellipse', 'triangle', 'line', 'arrow', 'star', 'polygon', 'text', 'image', 'icon');--> statement-breakpoint
CREATE TABLE "canvas_elements" (
	"element_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canvas_id" uuid NOT NULL,
	"type" "canvas_element_type" NOT NULL,
	"x" double precision DEFAULT 0 NOT NULL,
	"y" double precision DEFAULT 0 NOT NULL,
	"width" double precision DEFAULT 100 NOT NULL,
	"height" double precision DEFAULT 100 NOT NULL,
	"rotation" double precision DEFAULT 0 NOT NULL,
	"opacity" double precision DEFAULT 1 NOT NULL,
	"fill" text,
	"stroke" text,
	"stroke_width" double precision DEFAULT 0 NOT NULL,
	"corner_radius" double precision DEFAULT 0 NOT NULL,
	"z_index" integer DEFAULT 0 NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"canvas_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"width" integer DEFAULT 1080 NOT NULL,
	"height" integer DEFAULT 1080 NOT NULL,
	"aspect_ratio_preset" text,
	"background_color" text DEFAULT '#ffffff' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "canvases_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "canvas_elements" ADD CONSTRAINT "canvas_elements_canvas_id_canvases_canvas_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("canvas_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_elements" ADD CONSTRAINT "canvas_elements_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_elements_canvas_id_z_index_idx" ON "canvas_elements" USING btree ("canvas_id","z_index");--> statement-breakpoint
-- Backfill: projects that predate the canvases table. drizzle-kit only emits
-- DDL, so this is hand-added. `getOrHydrate` also creates a canvas lazily, but
-- backfilling means that path is never exercised for existing data.
INSERT INTO "canvases" ("project_id") SELECT "project_id" FROM "projects" ON CONFLICT DO NOTHING;
