import { Router } from "express";

import { requireAuth } from "@/middlewares/index.js";
import { validateBody, validateQuery } from "@/middlewares/validation.middleware.js";

import { createUser, getProfile, searchUsers, updateUsername } from "./user.controller.js";
import { createUserSchema, searchUsersQuerySchema, updateUsernameSchema } from "./user.validation.js";

const router = Router();

router.post("/", validateBody(createUserSchema), createUser);

router.use(requireAuth);

router.get("/me", getProfile);
router.patch("/me/username", validateBody(updateUsernameSchema), updateUsername);
router.get("/search", validateQuery(searchUsersQuerySchema), searchUsers);

export default router;
