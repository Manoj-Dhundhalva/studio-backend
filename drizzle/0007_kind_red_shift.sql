ALTER TABLE "ai_messages" DROP CONSTRAINT "ai_messages_canvas_id_canvases_canvas_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "canvas_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_canvas_id_canvases_canvas_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("canvas_id") ON DELETE set null ON UPDATE no action;