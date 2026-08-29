import z from "zod";

export const ContestIdSchema = z.number().int().min(1);
