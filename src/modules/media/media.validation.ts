import { z } from "zod";

export const mediaIdParamsSchema = z.object({
  projectId: z.uuid("Invalid project id"),
  mediaId: z.uuid("Invalid media id"),
});

export type MediaIdParams = z.infer<typeof mediaIdParamsSchema>;
