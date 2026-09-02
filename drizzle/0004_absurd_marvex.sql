ALTER TABLE "canvases" DROP CONSTRAINT "canvases_project_id_unique";--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "order_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "canvases_project_id_order_index_idx" ON "canvases" USING btree ("project_id","order_index");