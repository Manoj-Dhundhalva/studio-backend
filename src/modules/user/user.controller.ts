import { type Request, type Response } from "express";

import { dbService } from "@/services/db.service.js";

import type { SearchUsersQuery, UpdateUsernameBody } from "./user.validation.js";

export const getProfile = (req: Request, res: Response) => {
  const { userId, email, username, avatarUrl } = req.user!;

  res.status(200).json({ userId, email, username, avatarUrl });
};

export const updateUsername = async (req: Request<unknown, unknown, UpdateUsernameBody>, res: Response) => {
  const { username } = req.body;

  const updatedUser = await dbService.updateUsername(req.user!.userId, username);

  if (!updatedUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const { userId, email, username: updatedUsername, avatarUrl } = updatedUser;

  res.status(200).json({ userId, email, username: updatedUsername, avatarUrl });
};

export const searchUsers = async (req: Request<unknown, unknown, unknown, SearchUsersQuery>, res: Response) => {
  const { q } = req.query;

  const results = await dbService.searchUsers(q);

  res.status(200).json({
    users: results.map(({ userId, avatarUrl, username, email }) => ({ userId, avatar: avatarUrl, username, email })),
  });
};
