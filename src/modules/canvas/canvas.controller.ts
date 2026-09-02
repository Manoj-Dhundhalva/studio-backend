import { type Request, type Response } from "express";

import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { dbService } from "@/services/db.service.js";
import { toCanvasDto, toElementDto } from "@/socket/canvas.handlers.js";
import { tryGetIo } from "@/socket/index.js";
import { projectRoom } from "@/socket/socket.types.js";

import type { ProjectIdParams } from "@/modules/project/project.validation.js";

import type { UpdateCanvasBody } from "./canvas.validation.js";

/**
 * Initial editor load, and the fallback for a client whose WebSocket is blocked.
 */
export const getCanvas = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
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
  const [canvas, elements] = await Promise.all([
    canvasCacheService.getCanvas(projectId),
    canvasCacheService.listElements(projectId),
  ]);

  res.status(200).json({
    canvas: toCanvasDto(canvas),
    elements: elements.map(toElementDto),
    accessibility: result.member.role,
  });
};

/**
 * Non-socket path for changing the workspace size or background. Writes through
 * the cache — never directly to the DB, which would leave the cache stale, the
 * one invariant this design cannot violate — then broadcasts so live editors see
 * the change.
 */
export const updateCanvas = async (
  req: Request<ProjectIdParams, unknown, UpdateCanvasBody>,
  res: Response,
) => {
  const { projectId } = req.params;
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

  let canvas = await canvasCacheService.getCanvas(projectId);

  if (width !== undefined || height !== undefined || aspectRatioPreset !== undefined) {
    canvas = await canvasCacheService.resizeCanvas(
      projectId,
      width ?? canvas.width,
      height ?? canvas.height,
      aspectRatioPreset ?? canvas.aspectRatioPreset ?? "custom",
    );
  }

  if (backgroundColor !== undefined) {
    canvas = await canvasCacheService.setBackgroundColor(projectId, backgroundColor);
  }

  const dto = toCanvasDto(canvas);

  // `socketId` is empty because this change came over HTTP, so no connected
  // socket should treat it as its own echo.
  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("canvas:resized", { projectId, socketId: "", canvas: dto });

  res.status(200).json({ canvas: dto });
};
