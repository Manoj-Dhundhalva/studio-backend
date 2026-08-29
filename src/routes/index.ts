import { Router } from "express";

import contestRoutes from "../modules/contest/contest.routes.js";
import problemRoutes from "../modules/problem/problem.routes.js";

const router = Router();

router.use("/contest", contestRoutes);
router.use("/problem", problemRoutes);

export default router;
