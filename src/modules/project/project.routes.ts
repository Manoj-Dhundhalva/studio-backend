import { Router } from "express";

import { requireAuth } from "@/middlewares/index.js";
import { validateBody, validateParams, validateQuery } from "@/middlewares/validation.middleware.js";

import {
  createSlide,
  deleteSlide,
  duplicateSlide,
  getSlide,
  getSlides,
  reorderSlides,
  updateSlide,
} from "@/modules/canvas/canvas.controller.js";
import { canvasIdParamsSchema, createSlideRestSchema, reorderSlidesRestSchema, updateCanvasSchema } from "@/modules/canvas/canvas.validation.js";

import { deleteMedia, listMedia, uploadMedia } from "@/modules/media/media.controller.js";
import { mediaIdParamsSchema } from "@/modules/media/media.validation.js";
import { mediaUpload } from "@/modules/media/media.upload.js";

import { listAiMessages, sendAiMessage } from "@/modules/ai/ai.controller.js";
import { sendAiMessageRestSchema } from "@/modules/ai/ai.validation.js";

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

// Slides live under the project they belong to, so they inherit `requireAuth`
// and the same `:projectId` validation as every sibling route. Registered flat
// rather than as a sub-router: `validateParams` rewrites `req.params` via
// `Object.defineProperty`, which a mounted child router would only see through
// `mergeParams`.
router.get("/:projectId/slides", validateParams(projectIdParamsSchema), getSlides);
router.post(
  "/:projectId/slides",
  validateParams(projectIdParamsSchema),
  validateBody(createSlideRestSchema),
  createSlide,
);
// Must be registered before "/:projectId/slides/:canvasId" — Express matches
// route patterns in registration order, and ":canvasId" would otherwise
// swallow the literal segment "reorder" as if it were a canvasId value.
router.patch(
  "/:projectId/slides/reorder",
  validateParams(projectIdParamsSchema),
  validateBody(reorderSlidesRestSchema),
  reorderSlides,
);
router.get("/:projectId/slides/:canvasId", validateParams(canvasIdParamsSchema), getSlide);
router.patch(
  "/:projectId/slides/:canvasId",
  validateParams(canvasIdParamsSchema),
  validateBody(updateCanvasSchema),
  updateSlide,
);
router.post("/:projectId/slides/:canvasId/duplicate", validateParams(canvasIdParamsSchema), duplicateSlide);
router.delete("/:projectId/slides/:canvasId", validateParams(canvasIdParamsSchema), deleteSlide);

// Uploads panel media — same flat-mount reasoning as slides above.
router.get("/:projectId/media", validateParams(projectIdParamsSchema), listMedia);
router.post(
  "/:projectId/media",
  validateParams(projectIdParamsSchema),
  mediaUpload.single("file"),
  uploadMedia,
);
router.delete("/:projectId/media/:mediaId", validateParams(mediaIdParamsSchema), deleteMedia);

// AI design-assistant chat — same flat-mount reasoning as slides/media above.
router.get("/:projectId/ai/messages", validateParams(projectIdParamsSchema), listAiMessages);
router.post(
  "/:projectId/ai/messages",
  validateParams(projectIdParamsSchema),
  validateBody(sendAiMessageRestSchema),
  sendAiMessage,
);

export default router;
