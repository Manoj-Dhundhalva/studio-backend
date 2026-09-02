import { type Request, type Response } from "express";

import env from "@/config/env.js";
import { utils } from "@/utils/index.js";

export const callback = async (req: Request, res: Response) => {
  if (!req.user) {
    return res.redirect(`${env.CLIENT_URL}/login#error=authentication_failed`);
  }

  const accessToken = utils.jwt.generateAccessToken({ userId: req.user.userId });

  // The fragment is not sent to the server, so the token stays out of access logs
  // and Referer headers. The client reads it from location.hash and clears it.
  res.redirect(`${env.CLIENT_URL}/auth/callback#access_token=${encodeURIComponent(accessToken)}`);
};
