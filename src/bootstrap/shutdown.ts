import type { Server as HttpServer } from "node:http";

import { env } from "@/config/env.js";
import { closeDbPool } from "@/db/connection.js";
import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { closeSocketServer } from "@/socket/index.js";

/**
 * Graceful shutdown.
 *
 * The in-memory canvas cache is the source of truth for anything edited since
 * the last flush, so exiting without flushing loses real work. The *ordering*
 * below is the whole point: sockets are closed before the final flush, which
 * guarantees the snapshot being written is final. Flushing first would drop
 * every edit that landed during the flush.
 */
export const registerShutdownHooks = (httpServer: HttpServer): void => {
  let isShuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`Shutting down: ${reason}`);

    // Hard deadline — a hung pool or a stuck socket must not block a deploy.
    const watchdog = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT);
    watchdog.unref();

    try {
      // 1. Stop the periodic loop so it cannot race the final flush.
      canvasCacheService.stopFlushLoop();

      // 2. Stop accepting mutations.
      await closeSocketServer();
      httpServer.close();

      // 3. Only now is the in-memory state final.
      await canvasCacheService.flushAll();

      // 4. Drain the pool last.
      await closeDbPool();

      clearTimeout(watchdog);
      process.exit(0);
    } catch (error) {
      console.error("Shutdown failed", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A handler that somehow escapes `guardWrite` would otherwise kill the process
  // with unflushed edits still in memory. Try to save them, then exit non-zero.
  process.on("unhandledRejection", (error) => {
    console.error("Unhandled rejection", error);
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception", error);
    void shutdown("uncaughtException");
  });
};
