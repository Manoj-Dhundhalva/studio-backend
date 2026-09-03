import { z } from "zod";

export const sendAiMessageRestSchema = z.object({
  canvasId: z.uuid("Invalid canvas id"),
  content: z.string().trim().min(1),
});

export type SendAiMessageBody = z.infer<typeof sendAiMessageRestSchema>;
