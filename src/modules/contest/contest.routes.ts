import { Router } from "express";
import { syncContestsToDb, syncProblemsToDb } from "./contest.middleware.js";
import { syncCompletionController } from "./contest.controller.js";

const router = Router();

router.get("/sync", syncContestsToDb, syncProblemsToDb, syncCompletionController);

export default router;
