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
  presenceActiveSlidePayloadSchema,
  selectionChangePayloadSchema,
  slideActivatePayloadSchema,
  slideCreatePayloadSchema,
  slideDeletePayloadSchema,
  slideDuplicatePayloadSchema,
  slideReorderPayloadSchema,
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
  activeCanvasId: socket.data.activeCanvasIds.get(projectId) ?? "",
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
        const { projectId, activeCanvasId } = joinPayloadSchema.parse(rawPayload);

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

        const slides = await canvasCacheService.listSlides(projectId);
        const firstSlide = slides[0];

        if (!firstSlide) {
          ack({ ok: false, code: SOCKET_ERROR_CODE.INTERNAL, error: "Project has no slides" });
          return;
        }

        // Only trust the client's requested slide if it actually belongs to
        // this project — otherwise fall back to the first slide by order.
        const resolvedActiveCanvasId =
          activeCanvasId && slides.some((slide) => slide.canvasId === activeCanvasId)
            ? activeCanvasId
            : firstSlide.canvasId;

        const elements = await canvasCacheService.listElements(projectId, resolvedActiveCanvasId);

        socket.data.activeCanvasIds.set(projectId, resolvedActiveCanvasId);

        ack({
          ok: true,
          data: {
            slides: slides.map(toCanvasDto),
            activeCanvasId: resolvedActiveCanvasId,
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

  socket.on(
    "presence:activeSlide",
    guardRead(socket, "presence:activeSlide", presenceActiveSlidePayloadSchema, (context, payload) => {
      socket.data.activeCanvasIds.set(context.projectId, payload.canvasId);

      socket.to(projectRoom(context.projectId)).emit("presence:activeSlideChanged", {
        projectId: context.projectId,
        socketId: socket.id,
        canvasId: payload.canvasId,
      });
    }),
  );

  socket.on(
    "slide:activate",
    guardRead(socket, "slide:activate", slideActivatePayloadSchema, async (context, payload, ack) => {
      const hasSlide = await canvasCacheService.hasSlide(context.projectId, payload.canvasId);

      if (!hasSlide) {
        ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Slide not found" } as never);
        return;
      }

      const elements = await canvasCacheService.listElements(context.projectId, payload.canvasId);

      ack?.({ ok: true, data: { elements: elements.map(toElementDto) } } as never);
    }),
  );

  socket.on(
    "slide:create",
    guardWrite(socket, "slide:create", slideCreatePayloadSchema, async (context, payload, ack) => {
      if (payload.afterCanvasId) {
        const hasAfter = await canvasCacheService.hasSlide(context.projectId, payload.afterCanvasId);

        if (!hasAfter) {
          ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Reference slide not found" } as never);
          return;
        }
      }

      const { canvas, order } = await canvasCacheService.createSlide(
        context.projectId,
        payload.canvasId,
        payload.afterCanvasId,
      );
      const dto = toCanvasDto(canvas);

      ack?.({ ok: true, data: { slide: dto, order } } as never);

      socket.to(projectRoom(context.projectId)).emit("slide:created", {
        projectId: context.projectId,
        socketId: socket.id,
        slide: dto,
        order,
      });
    }),
  );

  socket.on(
    "slide:duplicate",
    guardWrite(socket, "slide:duplicate", slideDuplicatePayloadSchema, async (context, payload, ack) => {
      const result = await canvasCacheService.duplicateSlide(context.projectId, payload.canvasId);

      if (!result) {
        ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Slide not found" } as never);
        return;
      }

      const slideDto = toCanvasDto(result.canvas);
      const elementDtos = result.elements.map(toElementDto);

      ack?.({ ok: true, data: { slide: slideDto, elements: elementDtos, order: result.order } } as never);

      socket.to(projectRoom(context.projectId)).emit("slide:duplicated", {
        projectId: context.projectId,
        socketId: socket.id,
        slide: slideDto,
        elements: elementDtos,
        order: result.order,
      });
    }),
  );

  socket.on(
    "slide:reorder",
    guardWrite(socket, "slide:reorder", slideReorderPayloadSchema, async (context, payload, ack) => {
      const applied = await canvasCacheService.reorderSlides(context.projectId, payload.order);

      ack?.({ ok: true, data: { order: applied } } as never);

      if (applied.length > 0) {
        socket
          .to(projectRoom(context.projectId))
          .emit("slide:reordered", { projectId: context.projectId, socketId: socket.id, order: applied });
      }
    }),
  );

  socket.on(
    "slide:delete",
    guardWrite(socket, "slide:delete", slideDeletePayloadSchema, async (context, payload, ack) => {
      const outcome = await canvasCacheService.deleteSlide(context.projectId, payload.canvasId);

      if (outcome.status === "not-found") {
        ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Slide not found" } as never);
        return;
      }

      if (outcome.status === "last-slide") {
        ack?.({
          ok: false,
          code: SOCKET_ERROR_CODE.INVALID_OPERATION,
          error: "A project must have at least one slide",
        } as never);
        return;
      }

      ack?.({ ok: true, data: { canvasId: payload.canvasId } } as never);

      socket
        .to(projectRoom(context.projectId))
        .emit("slide:deleted", { projectId: context.projectId, socketId: socket.id, canvasId: payload.canvasId });
    }),
  );

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
      const hasSlide = await canvasCacheService.hasSlide(context.projectId, payload.canvasId);

      if (!hasSlide) {
        ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Slide not found" } as never);
        return;
      }

      const count = await canvasCacheService.countElements(context.projectId, payload.canvasId);

      if (count >= env.MAX_ELEMENTS_PER_CANVAS) {
        ack?.({
          ok: false,
          code: SOCKET_ERROR_CODE.LIMIT_EXCEEDED,
          error: `A canvas can hold at most ${env.MAX_ELEMENTS_PER_CANVAS} elements`,
        } as never);
        return;
      }

      const element = await canvasCacheService.createElement(
        context.projectId,
        payload.canvasId,
        payload.element,
        context.userId,
      );

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

      socket.to(projectRoom(context.projectId)).emit("element:created", {
        projectId: context.projectId,
        canvasId: payload.canvasId,
        socketId: socket.id,
        element: dto,
      });
    }),
  );

  socket.on(
    "element:update",
    guardWrite(socket, "element:update", elementUpdatePayloadSchema, async (context, payload, ack) => {
      const outcome = await canvasCacheService.applyPatch(
        context.projectId,
        payload.canvasId,
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
        socket.emit("element:synced", {
          projectId: context.projectId,
          canvasId: payload.canvasId,
          element: toElementDto(outcome.element),
        });
        return;
      }

      ack?.({ ok: true, data: { version: outcome.version } } as never);

      socket.to(projectRoom(context.projectId)).emit("element:updated", {
        projectId: context.projectId,
        canvasId: payload.canvasId,
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
      const removed = await canvasCacheService.deleteElements(context.projectId, payload.canvasId, payload.elementIds);

      ack?.({ ok: true, data: { elementIds: removed } } as never);

      if (removed.length > 0) {
        socket.to(projectRoom(context.projectId)).emit("element:deleted", {
          projectId: context.projectId,
          canvasId: payload.canvasId,
          socketId: socket.id,
          elementIds: removed,
        });
      }
    }),
  );

  socket.on(
    "element:reorder",
    guardWrite(socket, "element:reorder", elementReorderPayloadSchema, async (context, payload, ack) => {
      const applied = await canvasCacheService.reorderElements(context.projectId, payload.canvasId, payload.order);

      ack?.({ ok: true, data: { order: applied } } as never);

      if (applied.length > 0) {
        socket.to(projectRoom(context.projectId)).emit("element:reordered", {
          projectId: context.projectId,
          canvasId: payload.canvasId,
          socketId: socket.id,
          order: applied,
        });
      }
    }),
  );

  socket.on(
    "canvas:resize",
    guardWrite(socket, "canvas:resize", canvasResizePayloadSchema, async (context, payload, ack) => {
      const hasSlide = await canvasCacheService.hasSlide(context.projectId, payload.canvasId);

      if (!hasSlide) {
        ack?.({ ok: false, code: SOCKET_ERROR_CODE.NOT_FOUND, error: "Slide not found" } as never);
        return;
      }

      const canvas = await canvasCacheService.resizeCanvas(
        context.projectId,
        payload.canvasId,
        payload.width,
        payload.height,
        payload.aspectRatioPreset,
      );

      const dto = toCanvasDto(canvas);

      ack?.({ ok: true, data: { canvas: dto } } as never);

      socket.to(projectRoom(context.projectId)).emit("canvas:resized", {
        projectId: context.projectId,
        canvasId: payload.canvasId,
        socketId: socket.id,
        canvas: dto,
      });
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
