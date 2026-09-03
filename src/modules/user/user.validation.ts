import { z } from "zod";

export const createUserSchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  email: z.string().trim().email("Invalid email"),
  avatarUrl: z.string().trim().url("Invalid avatar URL").optional(),
});

export type CreateUserBody = z.infer<typeof createUserSchema>;

export const updateUsernameSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
});

export type UpdateUsernameBody = z.infer<typeof updateUsernameSchema>;

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().min(1, "Search query is required").max(100, "Search query is too long"),
});

export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
