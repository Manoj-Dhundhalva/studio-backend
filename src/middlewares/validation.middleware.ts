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
      // A request sent with no body and no `Content-Type: application/json`
      // leaves `express.json()`'s `req.body` as `undefined`, not `{}` — every
      // body schema in this app is either fully optional or checked field by
      // field, so treating "no body" as "empty object" here can't mask a
      // genuinely missing required field, it just stops a body-less POST
      // (e.g. `createProject`, which sends no payload at all) from failing
      // validation before the schema even runs.
      const value = field === REQUEST_FIELD.BODY && req[field] === undefined ? {} : req[field];
      const parsed = schema.parse(value);
      // Express 5 exposes `req.query` as a getter with no setter, so a plain
      // `req[field] = parsed` throws for query (but not body/params). Defining an
      // own property shadows that getter and works uniformly for all three fields.
      Object.defineProperty(req, field, { value: parsed, writable: true, enumerable: true, configurable: true });
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
