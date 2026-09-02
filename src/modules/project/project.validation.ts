import { z } from "zod";

import { projectMemberRoleEnum } from "@/db/schema.js";

export const DEFAULT_PROJECT_NAME = "Untitled";

const MAX_MEMBERS_PER_REQUEST = 50;

const hasUniqueUserIds = (items: { userId: string }[]) =>
  new Set(items.map(({ userId }) => userId)).size === items.length;

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

const membersAccessibilityListSchema = z
  .array(
    z.object({
      userId: z.uuid("Invalid user id"),
      accessibility: z.enum(projectMemberRoleEnum.enumValues, "Invalid accessibility"),
    }),
  )
  .min(1, "At least one member is required")
  .max(MAX_MEMBERS_PER_REQUEST, `Cannot include more than ${MAX_MEMBERS_PER_REQUEST} members at once`)
  .refine(hasUniqueUserIds, "Duplicate userId in members list");

export const addProjectMembersSchema = z.object({
  members: membersAccessibilityListSchema,
});

export type AddProjectMembersBody = z.infer<typeof addProjectMembersSchema>;

export const removeProjectMembersSchema = z.object({
  userIds: z
    .array(z.uuid("Invalid user id"))
    .min(1, "At least one userId is required")
    .max(MAX_MEMBERS_PER_REQUEST, `Cannot remove more than ${MAX_MEMBERS_PER_REQUEST} members at once`)
    .refine((userIds) => new Set(userIds).size === userIds.length, "Duplicate userId in userIds list"),
});

export type RemoveProjectMembersBody = z.infer<typeof removeProjectMembersSchema>;

export const updateProjectMembersAccessibilitySchema = z.object({
  members: membersAccessibilityListSchema,
});

export type UpdateProjectMembersAccessibilityBody = z.infer<typeof updateProjectMembersAccessibilitySchema>;

const DEFAULT_MEMBERS_PAGE_LIMIT = 50;
const MAX_MEMBERS_PAGE_LIMIT = 100;

export const getProjectMembersQuerySchema = z.object({
  limit: z.coerce
    .number("Limit must be a number")
    .int("Limit must be an integer")
    .min(1, "Limit must be at least 1")
    .max(MAX_MEMBERS_PAGE_LIMIT, `Limit must be at most ${MAX_MEMBERS_PAGE_LIMIT}`)
    .optional()
    .default(DEFAULT_MEMBERS_PAGE_LIMIT),
  offset: z.coerce
    .number("Offset must be a number")
    .int("Offset must be an integer")
    .min(0, "Offset must be at least 0")
    .optional()
    .default(0),
});

export type GetProjectMembersQuery = z.infer<typeof getProjectMembersQuerySchema>;
