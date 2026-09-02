import { z } from "zod";

export const DEFAULT_PROJECT_NAME = "Untitled";

export const createProjectSchema = z.object({
  projectName: z
    .string()
    .trim()
    .max(100, "Project name must be at most 100 characters")
    .optional()
    .transform((projectName) => (projectName ? projectName : DEFAULT_PROJECT_NAME)),
});

export type CreateProjectBody = z.infer<typeof createProjectSchema>;

export const projectIdParamsSchema = z.object({
  projectId: z.uuid("Invalid project id"),
});

export type ProjectIdParams = z.infer<typeof projectIdParamsSchema>;

export const updateProjectNameSchema = z.object({
  projectName: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(100, "Project name must be at most 100 characters"),
});

export type UpdateProjectNameBody = z.infer<typeof updateProjectNameSchema>;
