import { type Request, type Response } from "express";

import { cloudinaryService } from "@/services/cloudinary.service.js";
import { dbService, type ProjectMedia } from "@/services/db.service.js";
import { tryGetIo } from "@/socket/index.js";
import { projectRoom, type TProjectMediaDto } from "@/socket/socket.types.js";

import type { ProjectIdParams } from "@/modules/project/project.validation.js";
import type { MediaIdParams } from "./media.validation.js";

const toProjectMediaDto = (media: ProjectMedia): TProjectMediaDto => {
  const { publicId: _publicId, ...dto } = media;

  return dto;
};

export const listMedia = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const media = await dbService.listProjectMedia(projectId);

  res.status(200).json({ media: media.map(toProjectMediaDto) });
};

export const uploadMedia = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (membership.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot upload to this project" });
    return;
  }

  const file = req.file;

  if (!file) {
    res.status(400).json({ error: "No file was uploaded" });
    return;
  }

  const uploaded = await cloudinaryService.uploadImage(file.buffer, projectId);

  const media = await dbService.createProjectMedia({
    projectId,
    url: uploaded.url,
    publicId: uploaded.publicId,
    fileName: file.originalname,
    mimeType: file.mimetype,
    width: uploaded.width,
    height: uploaded.height,
    bytes: uploaded.bytes,
    uploadedBy: requesterId,
  });

  const dto = toProjectMediaDto(media);

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("media:uploaded", { projectId, socketId: "", media: dto });

  res.status(201).json({ media: dto });
};

export const deleteMedia = async (req: Request<MediaIdParams>, res: Response) => {
  const { projectId, mediaId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (membership.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot delete project media" });
    return;
  }

  const media = await dbService.getProjectMedia(projectId, mediaId);

  if (!media) {
    res.status(404).json({ error: "Media not found" });
    return;
  }

  await dbService.deleteProjectMedia(projectId, mediaId);
  await cloudinaryService.deleteImage(media.publicId);

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("media:deleted", { projectId, socketId: "", mediaId });

  res.status(200).json({ mediaId });
};
