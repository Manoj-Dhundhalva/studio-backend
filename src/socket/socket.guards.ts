import { ZodError, type ZodType } from "zod";

import type { ProjectMemberRole } from "@/services/db.service.js";
import type { TAppSocket } from "@/socket/index.js";
import { SOCKET_ERROR_CODE, type TAck } from "@/socket/socket.types.js";

/** Roles permitted to mutate a canvas. `viewer` is deliberately absent. */
const WRITE_ROLES: ReadonlySet<ProjectMemberRole> = new Set<ProjectMemberRole>(["admin", "editor"]);

export type TGuardContext = {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
};

type TAnyAck = (result: TAck<never>) => void;

/**
 * Wraps a mutating socket handler so that it validates, authorizes, and — most
 * importantly — cannot crash the process.
 *
 * This is a deliberate departure from the repo's no-try/catch controller
 * convention. That convention works for Express 5, which forwards async
 * rejections to `errorHandler`. Socket.IO forwards nothing: a rejected async
 * listener becomes an unhandled rejection, and Node exits on those by default —
 * taking every unflushed canvas edit in memory with it. So this wrapper is the
 * socket layer's `errorHandler`, and centralising it here keeps the handlers
 * themselves free of try/catch, preserving the spirit of the convention.
 *
 * The authorization check reads `socket.data.roles`, a server-owned Map on the
 * live socket that an admin's role change rewrites in place. No client payload
 * can influence it, which is what makes this — not the frontend's `canEdit`
 * flag — the actual permission boundary.
 */
export const guardWrite = <TPayload extends { projectId: string }>(
  socket: TAppSocket,
  event: string,
  schema: ZodType<TPayload>,
  handler: (context: TGuardContext, payload: TPayload, ack?: TAnyAck) => Promise<void> | void,
) => {
  return async (rawPayload: unknown, ack?: TAnyAck): Promise<void> => {
    const fail = (code: (typeof SOCKET_ERROR_CODE)[keyof typeof SOCKET_ERROR_CODE], error: string): void => {
      if (ack) {
        ack({ ok: false, code, error } as never);
        return;
      }

      // Ackless events (cursor, selection) still need a channel for failures.
      socket.emit("socket:error", { code, error });
    };

    try {
      const payload = schema.parse(rawPayload);
      const role = socket.data.roles.get(payload.projectId);

      if (!role) {
        fail(SOCKET_ERROR_CODE.NOT_IN_ROOM, "Join the project before editing it");
        return;
      }

      if (!WRITE_ROLES.has(role)) {
        // Tell the client its real role in the same breath, so a UI still
        // showing edit tools after a demotion corrects itself on the first
        // rejected mutation. This is a courtesy, not the security mechanism.
        socket.emit("access:changed", { projectId: payload.projectId, accessibility: role });
        fail(SOCKET_ERROR_CODE.FORBIDDEN, "Viewers cannot edit this canvas");
        return;
      }

      await handler({ projectId: payload.projectId, userId: socket.data.user.userId, role }, payload, ack);
    } catch (error) {
      if (error instanceof ZodError) {
        fail(SOCKET_ERROR_CODE.INVALID_PAYLOAD, "Invalid payload");
        return;
      }

      console.error(`Socket handler "${event}" failed`, error);
      fail(SOCKET_ERROR_CODE.INTERNAL, "Something went wrong");
    }
  };
};

/**
 * Same validation and error containment as `guardWrite`, but any role may
 * proceed — for reads and for presence traffic, which viewers take part in.
 */
export const guardRead = <TPayload extends { projectId: string }>(
  socket: TAppSocket,
  event: string,
  schema: ZodType<TPayload>,
  handler: (context: TGuardContext, payload: TPayload, ack?: TAnyAck) => Promise<void> | void,
) => {
  return async (rawPayload: unknown, ack?: TAnyAck): Promise<void> => {
    try {
      const payload = schema.parse(rawPayload);
      const role = socket.data.roles.get(payload.projectId);

      if (!role) {
        if (ack) {
          ack({ ok: false, code: SOCKET_ERROR_CODE.NOT_IN_ROOM, error: "Join the project first" } as never);
        }
        return;
      }

      await handler({ projectId: payload.projectId, userId: socket.data.user.userId, role }, payload, ack);
    } catch (error) {
      if (error instanceof ZodError) {
        if (ack) {
          ack({ ok: false, code: SOCKET_ERROR_CODE.INVALID_PAYLOAD, error: "Invalid payload" } as never);
        }
        return;
      }

      console.error(`Socket handler "${event}" failed`, error);

      if (ack) {
        ack({ ok: false, code: SOCKET_ERROR_CODE.INTERNAL, error: "Something went wrong" } as never);
      }
    }
  };
};
