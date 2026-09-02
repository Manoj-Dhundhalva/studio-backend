import { env } from "@/config/env.js";
import {
  canvasResizePayloadSchema,
  cursorMovePayloadSchema,
  elementCreatePayloadSchema,
  elementDeletePayloadSchema,
  elementReorderPayloadSchema,
  elementUpdatePayloadSchema,
  joinPayloadSchema,
  leavePayloadSchema,
  selectionChangePayloadSchema,
} from "@/modules/canvas/canvas.validation.js";
import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { dbService } from "@/services/db.service.js";
import type { Canvas, CanvasElement } from "@/services/db.service.js";
import { getIo, hasLiveMembers, type TAppSocket } from "@/socket/index.js";
import { guardRead, guardWrite } from "@/socket/socket.guards.js";
import {
  projectRoom,
  SOCKET_ERROR_CODE,
  userRoom,
  type TCanvasDto,
  type TElementDto,
  type TPresenceMember,
} from "@/socket/socket.types.js";

/** Strips the `Date` fields, which would otherwise serialise to strings on the wire. */
export const toElementDto = (element: CanvasElement): TElementDto => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...dto } = element;

  return dto;
};

export const toCanvasDto = (canvas: Canvas): TCanvasDto => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...dto } = canvas;

  return dto;
};

const toPresenceMember = (socket: TAppSocket, projectId: string): TPresenceMember => ({
  socketId: socket.id,
  userId: socket.data.user.userId,
  username: socket.data.user.username,
  avatarUrl: socket.data.user.avatarUrl,
  accessibility: socket.data.roles.get(projectId) ?? "viewer",
  color: socket.data.color,
});

/**
 * Every local socket currently in a project's room.
 *
 * Uses `io.sockets.sockets` rather than `fetchSockets()` deliberately:
 * `fetchSockets()` yields `RemoteSocket` objects whose `data` may be a
 * serialised snapshot, so writing to `remoteSocket.data.roles` is not
 * guaranteed to reach the real socket. Role changes must mutate the live
 * object, so we need real `Socket` instances.
 */
const socketsInRoom = (projectId: string): TAppSocket[] => {
  const io = getIo();
  const room = io.sockets.adapter.rooms.get(projectRoom(projectId));

  if (!room) {
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

export const presenceRoster = (projectId: string): TPresenceMember[] =>
  socketsInRoom(projectId).map((socket) => toPresenceMember(socket, projectId));

export const registerCanvasHandlers = (socket: TAppSocket): void => {
  const io = getIo();

  // Lets a REST role change reach every tab this person has open.
  void socket.join(userRoom(socket.data.user.userId));

  socket.on("canvas:join", (rawPayload: unknown, ack): void => {
    void (async () => {
      try {
        const { projectId } = joinPayloadSchema.parse(rawPayload);

        const membership = await dbService.getProjectForUser(projectId, socket.data.user.userId);

        if (!membership) {
          // Deliberately NOT_FOUND rather than FORBIDDEN, matching `getProject`'s
          // 404 — socket and REST leak the same (zero) information about
          // projects you cannot see.
          ack({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Project not found" });
          return;
        }

        socket.data.roles.set(projectId, membership.member.role);
        await socket.join(projectRoom(projectId));

        const [canvas, elements] = await Promise.all([
          canvasCacheService.getCanvas(projectId),
          canvasCacheService.listElements(projectId),
        ]);

        ack({
          ok: true,
          data: {
            canvas: toCanvasDto(canvas),
            elements: elements.map(toElementDto),
            members: presenceRoster(projectId),
            accessibility: membership.member.role,
            selfSocketId: socket.id,
          },
        });

        socket
          .to(projectRoom(projectId))
          .emit("presence:joined", { projectId, member: toPresenceMember(socket, projectId) });
      } catch (error) {
        console.error("Socket handler \"canvas:join\" failed", error);
        ack({ ok: false, code: SOCKET_ERROR_CODE.INTERNAL, error: "Failed to join project" });
      }
    })();
  });

  socket.on("canvas:leave", (rawPayload: unknown): void => {
    void (async () => {
      try {
        const { projectId } = leavePayloadSchema.parse(rawPayload);
        await leaveProject(socket, projectId);
      } catch (error) {
        console.error("Socket handler \"canvas:leave\" failed", error);
      }
    })();
  });

  // Cursors are relayed and forgotten — never persisted. `volatile` means a
  // client with a backed-up send buffer misses frames instead of accumulating a
  // queue of stale positions it would replay in a burst on recovery.
  socket.on(
    "cursor:move",
    guardRead(socket, "cursor:move", cursorMovePayloadSchema, (context, payload) => {
      socket.volatile.to(projectRoom(context.projectId)).emit("cursor:moved", {
        projectId: context.projectId,
        socketId: socket.id,
        userId: context.userId,
        x: payload.x,
        y: payload.y,
      });
    }),
  );

  socket.on(
    "selection:change",
    guardRead(socket, "selection:change", selectionChangePayloadSchema, (context, payload) => {
      socket.to(projectRoom(context.projectId)).emit("selection:changed", {
        projectId: context.projectId,
        socketId: socket.id,
        elementIds: payload.elementIds,
      });
    }),
  );

  socket.on(
    "element:create",
    guardWrite(socket, "element:create", elementCreatePayloadSchema, async (context, payload, ack) => {
      const count = await canvasCacheService.countElements(context.projectId);

      if (count >= env.MAX_ELEMENTS_PER_CANVAS) {
        ack?.({
          ok: false,
          code: SOCKET_ERROR_CODE.LIMIT_EXCEEDED,
          error: `A canvas can hold at most ${env.MAX_ELEMENTS_PER_CANVAS} elements`,
        } as never);
        return;
      }

      const element = await canvasCacheService.createElement(context.projectId, payload.element, context.userId);

      if (!element) {
        ack?.({
          ok: false,
          code: SOCKET_ERROR_CODE.DUPLICATE_ID,
          error: "An element with that id already exists",
        } as never);
        return;
      }

      const dto = toElementDto(element);

      ack?.({ ok: true, data: { element: dto } } as never);

      socket
        .to(projectRoom(context.projectId))
        .emit("element:created", { projectId: context.projectId, socketId: socket.id, element: dto });
    }),
  );

  socket.on(
    "element:update",
    guardWrite(socket, "element:update", elementUpdatePayloadSchema, async (context, payload, ack) => {
      const outcome = await canvasCacheService.applyPatch(
        context.projectId,
        payload.elementId,
        payload.baseVersion,
        payload.patch,
      );

      if (outcome.status === "missing") {
        ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Element not found" } as never);
        return;
      }

      if (outcome.status === "stale") {
        // The caller lost the race. Send the authoritative element back to just
        // this socket so it resyncs one element rather than the whole canvas.
        ack?.({
          ok: false,
          code: SOCKET_ERROR_CODE.VERSION_CONFLICT,
          error: "Element changed since your last update",
        } as never);
        socket.emit("element:synced", { projectId: context.projectId, element: toElementDto(outcome.element) });
        return;
      }

      ack?.({ ok: true, data: { version: outcome.version } } as never);

      socket.to(projectRoom(context.projectId)).emit("element:updated", {
        projectId: context.projectId,
        socketId: socket.id,
        elementId: payload.elementId,
        version: outcome.version,
        patch: payload.patch,
      });
    }),
  );

  socket.on(
    "element:delete",
    guardWrite(socket, "element:delete", elementDeletePayloadSchema, async (context, payload, ack) => {
      const removed = await canvasCacheService.deleteElements(context.projectId, payload.elementIds);

      ack?.({ ok: true, data: { elementIds: removed } } as never);

      if (removed.length > 0) {
        socket
          .to(projectRoom(context.projectId))
          .emit("element:deleted", { projectId: context.projectId, socketId: socket.id, elementIds: removed });
      }
    }),
  );

  socket.on(
    "element:reorder",
    guardWrite(socket, "element:reorder", elementReorderPayloadSchema, async (context, payload, ack) => {
      const applied = await canvasCacheService.reorderElements(context.projectId, payload.order);

      ack?.({ ok: true, data: { order: applied } } as never);

      if (applied.length > 0) {
        socket
          .to(projectRoom(context.projectId))
          .emit("element:reordered", { projectId: context.projectId, socketId: socket.id, order: applied });
      }
    }),
  );

  socket.on(
    "canvas:resize",
    guardWrite(socket, "canvas:resize", canvasResizePayloadSchema, async (context, payload, ack) => {
      const canvas = await canvasCacheService.resizeCanvas(
        context.projectId,
        payload.width,
        payload.height,
        payload.aspectRatioPreset,
      );

      const dto = toCanvasDto(canvas);

      ack?.({ ok: true, data: { canvas: dto } } as never);

      socket
        .to(projectRoom(context.projectId))
        .emit("canvas:resized", { projectId: context.projectId, socketId: socket.id, canvas: dto });
    }),
  );

  /**
   * `disconnecting`, not `disconnect`: `socket.rooms` is still populated here and
   * is already empty by the time `disconnect` fires. Cleaning up in `disconnect`
   * leaks every presence entry — with no error, just ghost cursors.
   */
  socket.on("disconnecting", () => {
    const projectIds = [...socket.data.roles.keys()];

    for (const projectId of projectIds) {
      io.to(projectRoom(projectId)).emit("presence:left", {
        projectId,
        socketId: socket.id,
        userId: socket.data.user.userId,
      });
    }

    // Deferred so the flush sees the room *after* this socket has actually left.
    setImmediate(() => {
      void (async () => {
        for (const projectId of projectIds) {
          if (!hasLiveMembers(projectId)) {
            await canvasCacheService.flushProject(projectId).catch((error: unknown) => {
              console.error(`Failed to flush project ${projectId} on last disconnect`, error);
            });
          }
        }
      })();
    });
  });
};

const leaveProject = async (socket: TAppSocket, projectId: string): Promise<void> => {
  const io = getIo();

  if (!socket.data.roles.delete(projectId)) {
    return;
  }

  await socket.leave(projectRoom(projectId));

  io.to(projectRoom(projectId)).emit("presence:left", {
    projectId,
    socketId: socket.id,
    userId: socket.data.user.userId,
  });

  // Persist immediately when the last editor goes — the cache is the only copy
  // of anything edited since the previous flush.
  if (!hasLiveMembers(projectId)) {
    await canvasCacheService.flushProject(projectId);
  }
};
