import { type Request, type Response } from "express";

import { dbService } from "@/services/db.service.js";

import type {
  CreateProjectBody,
  ProjectIdParams,
  UpdateProjectNameBody,
} from "./project.validation.js";

export const createProject = async (
  req: Request<unknown, unknown, CreateProjectBody>,
  res: Response,
) => {
  const { projectName } = req.body;

  const { project, member } = await dbService.createProject(req.user!.userId, projectName);

  res.status(201).json({
    projectId: project.projectId,
    projectName: project.projectName,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    accessibility: member.role,
  });
};

export const getUserProjects = async (req: Request, res: Response) => {
  const userProjects = await dbService.getUserProjects(req.user!.userId);

  res.status(200).json({ projects: userProjects });
};

export const getProject = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;

  const result = await dbService.getProjectForUser(projectId, req.user!.userId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { project, member } = result;

  res.status(200).json({
    projectId: project.projectId,
    projectName: project.projectName,
    accessibility: member.role,
  });
};

export const updateProjectName = async (
  req: Request<ProjectIdParams, unknown, UpdateProjectNameBody>,
  res: Response,
) => {
  const { projectId } = req.params;
  const { projectName } = req.body;
  const userId = req.user!.userId;

  const project = await dbService.updateProjectName(projectId, userId, projectName);

  if (!project) {
    // The update didn't touch a row — figure out why (not a member vs. member
    // but not admin) only on this cold path, so the common success case stays
    // a single query.
    const result = await dbService.getProjectForUser(projectId, userId);

    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.status(403).json({ error: "Only a project admin can rename this project" });
    return;
  }

  res.status(200).json({
    projectId: project.projectId,
    projectName: project.projectName,
  });
};
