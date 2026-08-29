import type { Request, Response, NextFunction } from "express";
import { ZodType, ZodError } from "zod";

const REQUEST_FIELD = {
  BODY: "body",
  PARAMS: "params",
  QUERY: "query",
} as const;

type RequestField = (typeof REQUEST_FIELD)[keyof typeof REQUEST_FIELD];

const errorMessages: Record<RequestField, string> = {
  [REQUEST_FIELD.BODY]: "Validation failed",
  [REQUEST_FIELD.PARAMS]: "Invalid parameters",
  [REQUEST_FIELD.QUERY]: "Invalid query parameters",
};

const validate = (schema: ZodType, field: RequestField) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req[field] = schema.parse(req[field]);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: errorMessages[field],
          details: error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
};

export const validateBody = (schema: ZodType) => validate(schema, REQUEST_FIELD.BODY);
export const validateParams = (schema: ZodType) => validate(schema, REQUEST_FIELD.PARAMS);
export const validateQuery = (schema: ZodType) => validate(schema, REQUEST_FIELD.QUERY);
