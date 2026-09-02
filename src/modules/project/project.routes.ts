import { Router } from "express";

import { requireAuth } from "@/middlewares/index.js";
import { validateBody, validateParams, validateQuery } from "@/middlewares/validation.middleware.js";

import {
  addProjectMembers,
  createProject,
  getProject,
  getProjectMembers,
  getUserProjects,
  removeProjectMembers,
  updateProjectMembersAccessibility,
  updateProjectName,
} from "./project.controller.js";
import {
  addProjectMembersSchema,
  createProjectSchema,
  getProjectMembersQuerySchema,
  projectIdParamsSchema,
  removeProjectMembersSchema,
  updateProjectMembersAccessibilitySchema,
  updateProjectNameSchema,
} from "./project.validation.js";

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
router.get(
  "/:projectId/members",
  validateParams(projectIdParamsSchema),
  validateQuery(getProjectMembersQuerySchema),
  getProjectMembers,
);
router.post(
  "/:projectId/members",
  validateParams(projectIdParamsSchema),
  validateBody(addProjectMembersSchema),
  addProjectMembers,
);
router.patch(
  "/:projectId/members",
  validateParams(projectIdParamsSchema),
  validateBody(updateProjectMembersAccessibilitySchema),
  updateProjectMembersAccessibility,
);
router.delete(
  "/:projectId/members",
  validateParams(projectIdParamsSchema),
  validateBody(removeProjectMembersSchema),
  removeProjectMembers,
);

export default router;
