import type { Request, Response, NextFunction } from "express";

import { dbService } from "@/services/db.service.js";
import { utils } from "@/utils/index.js";

/** Verifies the `Authorization: Bearer <token>` header and attaches the user to `req.user`. */
export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Missing or malformed authorization header" });
    return;
  }

  try {
    const { userId } = utils.jwt.verifyAccessToken(token);
    const user = await dbService.findUserById(userId);

    if (!user) {
      res.status(401).json({ error: "Invalid access token" });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
  }
};
