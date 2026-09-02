import { Router } from "express";

import { google, googleCallback } from "./auth.middleware.js";
import { callback } from "./auth.controller.js";

const router = Router();

router.get("/google", google);
router.get("/google/callback", googleCallback, callback);

export default router;
