import env from "@/config/env.js";
import { users } from "@/db/schema.js";
import jwt, { type SignOptions } from "jsonwebtoken";

export type TAccessTokenPayload = Pick<typeof users.$inferSelect, "userId">;

export class JwtUtils {
  private static instance: JwtUtils;

  private constructor() {}

  static getInstance(): JwtUtils {
    if (!JwtUtils.instance) {
      JwtUtils.instance = new JwtUtils();
    }
    return JwtUtils.instance;
  }

  generateAccessToken = (payload: TAccessTokenPayload): string => {
    return jwt.sign(payload, env.ACCESS_TOKEN_SECRET, {
      expiresIn: env.ACCESS_TOKEN_EXPIRE,
    } as SignOptions);
  };
}
