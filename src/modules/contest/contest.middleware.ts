import { dbService } from "@/services/db.service.js";
import { type Request, type Response, type NextFunction } from "express";

export const syncContestsToDb = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    await dbService.insertContestsWithConflictIgnore();
    next();
  } catch (error) {
    next(error);
  }
};

export const syncProblemsToDb = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    await dbService.insertProblemsWithConflictIgnore();
    next();
  } catch (error) {
    next(error);
  }
};
