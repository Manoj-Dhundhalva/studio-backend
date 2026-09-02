import { type Request, type Response } from "express";

import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { dbService } from "@/services/db.service.js";
import { toCanvasDto, toElementDto } from "@/socket/canvas.handlers.js";
import { tryGetIo } from "@/socket/index.js";
import { projectRoom } from "@/socket/socket.types.js";

import type { ProjectIdParams } from "@/modules/project/project.validation.js";

import type { CanvasIdParams, CreateSlideBody, ReorderSlidesBody, UpdateCanvasBody } from "./canvas.validation.js";

/** Lists every slide's metadata, plus the first slide's elements. REST always picks the first slide by order — there's no "last viewed" concept over HTTP. */
export const getSlides = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const slides = await canvasCacheService.listSlides(projectId);
  const firstSlide = slides[0];

  if (!firstSlide) {
    res.status(500).json({ error: "Project has no slides" });
    return;
  }

  const elements = await canvasCacheService.listElements(projectId, firstSlide.canvasId);

  res.status(200).json({
    slides: slides.map(toCanvasDto),
    activeCanvasId: firstSlide.canvasId,
    elements: elements.map(toElementDto),
    accessibility: result.member.role,
  });
};

export const createSlide = async (req: Request<ProjectIdParams, unknown, CreateSlideBody>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot edit this project" });
    return;
  }

  const { afterCanvasId } = req.body;
  const canvasId = crypto.randomUUID();

  const { canvas, order } = await canvasCacheService.createSlide(projectId, canvasId, afterCanvasId);
  const dto = toCanvasDto(canvas);

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("slide:created", { projectId, socketId: "", slide: dto, order });

  res.status(201).json({ slide: dto, order });
};

export const reorderSlides = async (req: Request<ProjectIdParams, unknown, ReorderSlidesBody>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot edit this project" });
    return;
  }

  const applied = await canvasCacheService.reorderSlides(projectId, req.body.order);

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("slide:reordered", { projectId, socketId: "", order: applied });

  res.status(200).json({ order: applied });
};

/**
 * Initial editor load for one slide, and the fallback for a client whose
 * WebSocket is blocked.
 */
export const getSlide = async (req: Request<CanvasIdParams>, res: Response) => {
  const { projectId, canvasId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Reads THROUGH the cache, never straight from Postgres. For a project someone
  // is editing right now the cache is the source of truth and the DB trails it by
  // up to CANVAS_FLUSH_INTERVAL — querying the DB here would serve an element at
  // the position it held two seconds ago. Hydrates on a miss.
  const canvas = await canvasCacheService.getCanvas(projectId, canvasId);

  if (!canvas) {
    res.status(404).json({ error: "Slide not found" });
    return;
  }

  const elements = await canvasCacheService.listElements(projectId, canvasId);

  res.status(200).json({
    canvas: toCanvasDto(canvas),
    elements: elements.map(toElementDto),
    accessibility: result.member.role,
  });
};

/**
 * Non-socket path for changing one slide's size or background. Writes through
 * the cache — never directly to the DB, which would leave the cache stale, the
 * one invariant this design cannot violate — then broadcasts so live editors see
 * the change.
 */
export const updateSlide = async (req: Request<CanvasIdParams, unknown, UpdateCanvasBody>, res: Response) => {
  const { projectId, canvasId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot edit this canvas" });
    return;
  }

  const { width, height, aspectRatioPreset, backgroundColor } = req.body;

  let canvas = await canvasCacheService.getCanvas(projectId, canvasId);

  if (!canvas) {
    res.status(404).json({ error: "Slide not found" });
    return;
  }

  if (width !== undefined || height !== undefined || aspectRatioPreset !== undefined) {
    canvas = await canvasCacheService.resizeCanvas(
      projectId,
      canvasId,
      width ?? canvas.width,
      height ?? canvas.height,
      aspectRatioPreset ?? canvas.aspectRatioPreset ?? "custom",
    );
  }

  if (backgroundColor !== undefined) {
    canvas = await canvasCacheService.setBackgroundColor(projectId, canvasId, backgroundColor);
  }

  const dto = toCanvasDto(canvas);

  // `socketId` is empty because this change came over HTTP, so no connected
  // socket should treat it as its own echo.
  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("canvas:resized", { projectId, canvasId, socketId: "", canvas: dto });

  res.status(200).json({ canvas: dto });
};

export const duplicateSlide = async (req: Request<CanvasIdParams>, res: Response) => {
  const { projectId, canvasId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot edit this project" });
    return;
  }

  const duplicated = await canvasCacheService.duplicateSlide(projectId, canvasId);

  if (!duplicated) {
    res.status(404).json({ error: "Slide not found" });
    return;
  }

  const slideDto = toCanvasDto(duplicated.canvas);
  const elementDtos = duplicated.elements.map(toElementDto);

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("slide:duplicated", {
      projectId,
      socketId: "",
      slide: slideDto,
      elements: elementDtos,
      order: duplicated.order,
    });

  res.status(201).json({ slide: slideDto, elements: elementDtos, order: duplicated.order });
};

export const deleteSlide = async (req: Request<CanvasIdParams>, res: Response) => {
  const { projectId, canvasId } = req.params;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot edit this project" });
    return;
  }

  const outcome = await canvasCacheService.deleteSlide(projectId, canvasId);

  if (outcome.status === "not-found") {
    res.status(404).json({ error: "Slide not found" });
    return;
  }

  if (outcome.status === "last-slide") {
    res.status(422).json({ error: "A project must have at least one slide" });
    return;
  }

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("slide:deleted", { projectId, socketId: "", canvasId });

  res.status(200).json({ canvasId });
};
