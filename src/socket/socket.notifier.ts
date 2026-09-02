import type { ProjectMemberRole } from "@/services/db.service.js";
import { presenceRoster } from "@/socket/canvas.handlers.js";
import { tryGetIo, type TAppSocket } from "@/socket/index.js";
import { projectRoom, userRoom } from "@/socket/socket.types.js";

/**
 * Pushes permission changes from the REST layer into live sockets.
 *
 * Both functions are synchronous and never throw. That matters: they are called
 * from controllers that have no try/catch, *after* a successful DB write. If one
 * threw, Express 5 would forward it to `errorHandler` and return a 500 for a
 * request that actually succeeded.
 */

/** Every live socket belonging to a user, across all their open tabs. */
const socketsOfUser = (userId: string): TAppSocket[] => {
  const io = tryGetIo();
  const room = io?.sockets.adapter.rooms.get(userRoom(userId));

  if (!io || !room) {
    return [];
  }

  const sockets: TAppSocket[] = [];

  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);

    if (socket) {
      sockets.push(socket);
    }
  }

  return sockets;
};

/**
 * Rewrites the server-side role cache on every affected socket, then tells those
 * clients. The cache rewrite is the important half: because `guardWrite` reads
 * `socket.data.roles` on every event, a demoted viewer's next mutation attempt
 * fails immediately — no reconnect, no polling, and no reliance on the client
 * having processed the notification.
 *
 * Iterating *all* of a user's sockets is essential. Demoting only one tab would
 * leave the others holding a stale elevated role, which is a real authorization
 * bypass.
 */
export const notifyAccessChanged = (
  projectId: string,
  members: { userId: string; accessibility: ProjectMemberRole }[],
): void => {
  const io = tryGetIo();

  if (!io) {
    return;
  }

  try {
    for (const { userId, accessibility } of members) {
      for (const socket of socketsOfUser(userId)) {
        if (!socket.data.roles.has(projectId)) {
          continue;
        }

        socket.data.roles.set(projectId, accessibility);
        socket.emit("access:changed", { projectId, accessibility });
      }
    }

    // The roster carries each member's role, so everyone's presence UI updates.
    io.to(projectRoom(projectId)).emit("presence:sync", { projectId, members: presenceRoster(projectId) });
  } catch (error) {
    console.error("notifyAccessChanged failed", error);
  }
};

/**
 * Force-removes users from a project. Leaving the room is what actually stops
 * further canvas broadcasts reaching them; clearing the role only stops them
 * writing.
 */
export const notifyAccessRevoked = (projectId: string, userIds: string[]): void => {
  const io = tryGetIo();

  if (!io) {
    return;
  }

  try {
    const room = projectRoom(projectId);

    for (const userId of userIds) {
      for (const socket of socketsOfUser(userId)) {
        if (!socket.data.roles.delete(projectId)) {
          continue;
        }

        socket.emit("access:revoked", { projectId });
        void socket.leave(room);

        io.to(room).emit("presence:left", { projectId, socketId: socket.id, userId });
      }
    }
  } catch (error) {
    console.error("notifyAccessRevoked failed", error);
  }
};
