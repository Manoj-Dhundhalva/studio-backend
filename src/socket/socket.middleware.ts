import type { ExtendedError } from "socket.io";

import { dbService } from "@/services/db.service.js";
import type { TAppSocket } from "@/socket/index.js";
import { utils } from "@/utils/index.js";

/**
 * Handshake authentication, mirroring `requireAuth`: verify the JWT, then load
 * the user row so `socket.data.user` is the same shape as `req.user`.
 *
 * The token comes from `handshake.auth` rather than the query string, which
 * would otherwise end up in proxy access logs.
 *
 * The Error *message* is what Socket.IO delivers to the client's
 * `connect_error`, so it stays a stable code rather than a driver message.
 */
export const authenticateSocket = async (
  socket: TAppSocket,
  next: (error?: ExtendedError) => void,
): Promise<void> => {
  const rawToken: unknown = socket.handshake.auth["token"];
  const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : null;

  if (!token) {
    next(new Error("UNAUTHENTICATED"));
    return;
  }

  try {
    // `verifyAccessToken` throws on a bad or expired token — the same contract
    // `authenticate.middleware.ts` relies on.
    const { userId } = utils.jwt.verifyAccessToken(token);
    const user = await dbService.findUserById(userId);

    if (!user) {
      next(new Error("UNAUTHENTICATED"));
      return;
    }

    socket.data.user = user;
    socket.data.roles = new Map();
    socket.data.color = utils.color.presenceColorFor(user.userId);

    next();
  } catch {
    next(new Error("UNAUTHENTICATED"));
  }
};
