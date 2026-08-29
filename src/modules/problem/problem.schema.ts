import { z } from "zod";

export const ProblemSchema = z.object({
  contestId: z.coerce.number().int().min(1),
  problemIndex: z.string().min(1),
});

export const ContestSchema = z.object({
  contestId: z.coerce.number().int().min(1),
});

export const ProblemFilterSchema = z
  .object({
    tags: z.array(z.string()).optional().default([]),
    ratings: z.tuple([z.number().int().min(800), z.number().int().min(800)]).optional(),
    startTime: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().default(10),
    sort: z
      .object({
        field: z.enum(["rating", "startTime"]),
        order: z.enum(["asc", "desc"]),
      })
      .optional()
      .default({
        field: "startTime",
        order: "desc",
      }),
  })
  .transform((data) => {
    const normalizeRange = (range?: [number, number]): [number, number] | undefined => {
      if (!range) return range;
      const [a, b] = range;
      return a > b ? [b, a] : [a, b];
    };

    return {
      ...data,
      tags: [...data.tags].sort(),
      ratings: normalizeRange(data.ratings),
      startTime: normalizeRange(data.startTime),
    };
  });

export type TProblemFilterBody = z.infer<typeof ProblemFilterSchema>;
export type TProblemParams = z.infer<typeof ProblemSchema>;
export type TContestParams = z.infer<typeof ContestSchema>;
