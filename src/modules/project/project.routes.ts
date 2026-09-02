import { Router } from "express";

import { requireAuth } from "@/middlewares/index.js";
import { validateBody, validateParams, validateQuery } from "@/middlewares/validation.middleware.js";

import { getCanvas, updateCanvas } from "@/modules/canvas/canvas.controller.js";
import { updateCanvasSchema } from "@/modules/canvas/canvas.validation.js";

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

// Canvas lives under the project it belongs to, so it inherits `requireAuth` and
// the same `:projectId` validation as every sibling route. Registered flat
// rather than as a sub-router: `validateParams` rewrites `req.params` via
// `Object.defineProperty`, which a mounted child router would only see through
// `mergeParams`.
router.get("/:projectId/canvas", validateParams(projectIdParamsSchema), getCanvas);
router.patch(
  "/:projectId/canvas",
  validateParams(projectIdParamsSchema),
  validateBody(updateCanvasSchema),
  updateCanvas,
);

export default router;
