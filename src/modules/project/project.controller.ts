import { type Request, type Response } from "express";

import { dbService } from "@/services/db.service.js";

import type {
  AddProjectMembersBody,
  CreateProjectBody,
  GetProjectMembersQuery,
  ProjectIdParams,
  RemoveProjectMembersBody,
  UpdateProjectMembersAccessibilityBody,
  UpdateProjectNameBody,
} from "./project.validation.js";

export const createProject = async (req: Request<unknown, unknown, CreateProjectBody>, res: Response) => {
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

export const getProjectMembers = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  // `validateQuery` has already parsed `req.query` into a `GetProjectMembersQuery` at
  // runtime; Express's own query type (string-only) doesn't reflect that, hence the cast.
  const { limit, offset } = req.query as unknown as GetProjectMembersQuery;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { members, total } = await dbService.getProjectMembers(projectId, { limit, offset });

  res.status(200).json({
    members: members.map(({ userId, avatarUrl, username, email, accessibility }) => ({
      userId,
      avatar: avatarUrl,
      username,
      email,
      accessibility,
    })),
    total,
    limit,
    offset,
  });
};

export const addProjectMembers = async (
  req: Request<ProjectIdParams, unknown, AddProjectMembersBody>,
  res: Response,
) => {
  const { projectId } = req.params;
  const { members } = req.body;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role !== "admin") {
    res.status(403).json({ error: "Only a project admin can add members" });
    return;
  }

  const existingUsers = await dbService.findUsersByIds(members.map(({ userId }) => userId));

  if (existingUsers.length !== members.length) {
    res.status(400).json({ error: "One or more userIds do not exist" });
    return;
  }

  await dbService.addProjectMembers(projectId, members);

  res.status(204).send();
};

export const updateProjectMembersAccessibility = async (
  req: Request<ProjectIdParams, unknown, UpdateProjectMembersAccessibilityBody>,
  res: Response,
) => {
  const { projectId } = req.params;
  const { members } = req.body;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role !== "admin") {
    res.status(403).json({ error: "Only a project admin can update member accessibility" });
    return;
  }

  const updated = await dbService.updateProjectMembersRoles(projectId, members);

  if (updated === "last-admin") {
    res.status(409).json({ error: "This change would leave the project without an admin" });
    return;
  }

  if (!updated) {
    res.status(404).json({ error: "One or more userIds are not members of this project" });
    return;
  }

  res.status(200).json({
    members: updated.map(({ userId, role }) => ({ userId, accessibility: role })),
  });
};

export const removeProjectMembers = async (
  req: Request<ProjectIdParams, unknown, RemoveProjectMembersBody>,
  res: Response,
) => {
  const { projectId } = req.params;
  const { userIds } = req.body;
  const requesterId = req.user!.userId;

  const result = await dbService.getProjectForUser(projectId, requesterId);

  if (!result) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (result.member.role !== "admin") {
    res.status(403).json({ error: "Only a project admin can remove members" });
    return;
  }

  await dbService.removeProjectMembers(projectId, userIds);

  res.status(204).send();
};
