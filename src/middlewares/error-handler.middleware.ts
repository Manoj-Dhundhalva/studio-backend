import { type Request, type Response, type NextFunction } from "express";

import { isProdEnv } from "@/config/env.js";

export const errorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  console.error(err.stack);

  // In prod, err.message can carry internals (query text, driver/constraint
  // details) that shouldn't reach a client — log them, but don't echo them back.
  res.status(500).json({
    error: "Internal server error",
    message: isProdEnv() ? "Something went wrong" : err.message,
  });
};
