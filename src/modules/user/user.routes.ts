import { Router } from "express";

import { requireAuth } from "@/middlewares/index.js";
import { validateBody } from "@/middlewares/validation.middleware.js";

import { getProfile, updateUsername } from "./user.controller.js";
import { updateUsernameSchema } from "./user.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/me", getProfile);
router.patch("/me/username", validateBody(updateUsernameSchema), updateUsername);

export default router;
