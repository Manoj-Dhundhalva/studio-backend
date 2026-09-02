import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";

import { env } from "@/config/env.js";
import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { registerCanvasHandlers } from "@/socket/canvas.handlers.js";
import { authenticateSocket } from "@/socket/socket.middleware.js";
import { projectRoom, type ClientToServerEvents, type ServerToClientEvents, type TSocketData } from "@/socket/socket.types.js";

export type TIoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, TSocketData>;

export type TAppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, TSocketData>;

let io: TIoServer | null = null;

/**
 * Attaches Socket.IO to the raw HTTP server.
 *
 * Note on the global rate limiter: Socket.IO's `attach` inserts its own request
 * listener ahead of Express's and short-circuits anything under `/socket.io`,
 * so handshake traffic never reaches `limiter`. No path exclusion is needed.
 */
export const initSocketServer = (httpServer: HttpServer): TIoServer => {
  if (io) {
    return io;
  }

  io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, TSocketData>(httpServer, {
    // Socket.IO does not inherit Express middleware, so it needs its own CORS.
    cors: {
      origin: env.CLIENT_URL,
      credentials: true,
    },
    // A canvas event is a few hundred bytes. Capping the buffer makes it
    // structurally impossible to smuggle image bytes through a socket frame,
    // which would block the event loop on parse and then be persisted verbatim
    // into the `props` jsonb and rewritten on every later flush of that element.
    maxHttpBufferSize: 64 * 1024,
    // A WebSocket upgrade is not subject to the browser's same-origin policy, so
    // the `cors` option above does not gate it. This does. A missing Origin is
    // allowed so non-browser clients still work; the handshake JWT check remains
    // the real authentication boundary.
    allowRequest: (request, callback) => {
      const { origin } = request.headers;

      callback(null, origin === undefined || origin === env.CLIENT_URL);
    },
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    registerCanvasHandlers(socket);
  });

  canvasCacheService.startFlushLoop();

  return io;
};

export const getIo = (): TIoServer => {
  if (!io) {
    throw new Error("Socket server accessed before initSocketServer() was called");
  }

  return io;
};

/** Safe variant for code paths that may run before the socket server is up (e.g. tests, scripts). */
export const tryGetIo = (): TIoServer | null => io;

/**
 * Whether anyone is still editing a project. Used by the cache's eviction pass,
 * which must not drop a project that still has live members.
 */
export const hasLiveMembers = (projectId: string): boolean => {
  const room = io?.sockets.adapter.rooms.get(projectRoom(projectId));

  return (room?.size ?? 0) > 0;
};

export const closeSocketServer = async (): Promise<void> => {
  if (!io) {
    return;
  }

  await io.close();
  io = null;
};
