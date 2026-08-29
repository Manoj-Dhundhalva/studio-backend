import type { Request, Response } from "express";

export async function syncCompletionController(_req: Request, res: Response) {
  res.status(200).json({ message: "Contests and problems synced successfully" });
}
