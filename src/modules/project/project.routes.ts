import { Router } from "express";

import { requireAuth } from "@/middlewares/index.js";
import { validateBody, validateParams } from "@/middlewares/validation.middleware.js";

import { createProject, getProject, getUserProjects, updateProjectName } from "./project.controller.js";
import { createProjectSchema, projectIdParamsSchema, updateProjectNameSchema } from "./project.validation.js";

const router = Router();

router.use(requireAuth);

router.post("/", validateBody(createProjectSchema), createProject);
router.get("/", getUserProjects);
router.get("/:projectId", validateParams(projectIdParamsSchema), getProject);
router.patch(
  "/:projectId/name",
  validateParams(projectIdParamsSchema),
  validateBody(updateProjectNameSchema),
  updateProjectName,
);

export default router;
