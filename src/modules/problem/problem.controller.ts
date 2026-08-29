import type { Request, Response, NextFunction } from "express";
import { ContestSchema, ProblemSchema, type TProblemFilterBody } from "./problem.schema.js";
import { dbService } from "@/services/db.service.js";
import { problemService } from "./problem.service.js";

export async function getProblem(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await dbService.getProblem(ProblemSchema.parse(req.params));
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}

export async function getContestProblems(req: Request, res: Response, next: NextFunction) {
  try {
    const { contestId } = ContestSchema.parse(req.params);
    const data = await dbService.getContestProblems(contestId);
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}

export async function getFilteredProblems(
  req: Request<object, unknown, TProblemFilterBody>,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await dbService.getProblemsByFilter(req.body);
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}

export async function getProblems(_req: Request, res: Response, next: NextFunction) {
  try {
    void problemService.scrapeProblemsInBatches();
    res.status(200).json({ message: "Problem scraping has been started." });
  } catch (error) {
    next(error);
  }
}

export async function getSolutions(_req: Request, res: Response, next: NextFunction) {
  try {
    void problemService.scrapeSolutionsInBatches();
    res.status(200).json({ message: "Solution scraping has been started." });
  } catch (error) {
    next(error);
  }
}
