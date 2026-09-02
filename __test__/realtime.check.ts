/**
 * End-to-end check for the realtime canvas layer.
 *
 * There is no test runner in this repo yet, so this is a standalone script:
 *   npx tsx __test__/realtime.check.ts
 *
 * It boots the real app on its own port (so it does not collide with a dev
 * server on env.PORT), connects two real Socket.IO clients as an admin and a
 * viewer of the same project, and asserts the collaboration and permission
 * behaviour. It needs two seeded members on one project — pass their ids via
 * ADMIN_USER_ID / VIEWER_USER_ID / TEST_PROJECT_ID, or let it discover them.
 */
import http from "node:http";
import { and, eq } from "drizzle-orm";
import { io as ioClient, type Socket } from "socket.io-client";

import app from "@/server.js";
import { closeDbPool, db } from "@/db/connection.js";
import { canvasElements, canvases, projectMembers } from "@/db/schema.js";
import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { closeSocketServer, initSocketServer } from "@/socket/index.js";
import { utils } from "@/utils/index.js";

const PORT = 3199;
const BASE_URL = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

const check = (label: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }

  failed += 1;
  console.error(`  FAIL  ${label}`, detail === undefined ? "" : detail);
};

const connect = (token: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, { auth: { token }, transports: ["websocket"], reconnection: false });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });

/** Resolves on the next occurrence of `event`, or rejects after `timeoutMs`. */
const waitFor = <T,>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);

    function onEvent(payload: T): void {
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }

    socket.on(event, onEvent);
  });

const emit = <T,>(socket: Socket, event: string, payload: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ack for "${event}"`)), 3000);

    socket.emit(event, payload, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });

type TAck = { ok: boolean; code?: string; data?: Record<string, unknown> };

const main = async (): Promise<void> => {
  // ---------------------------------------------------------------- fixtures
  const [adminRow] = await db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.role, "admin"))
    .limit(1);

  if (!adminRow) {
    throw new Error("No admin project member found — seed a project first.");
  }

  const projectId = process.env["TEST_PROJECT_ID"] ?? adminRow.projectId;
  const adminUserId = process.env["ADMIN_USER_ID"] ?? adminRow.userId;

  const [viewerRow] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "viewer")))
    .limit(1);

  if (!viewerRow) {
    throw new Error(`Project ${projectId} has no viewer member — add one to test the permission boundary.`);
  }

  const adminToken = utils.jwt.generateAccessToken({ userId: adminUserId });
  const viewerToken = utils.jwt.generateAccessToken({ userId: viewerRow.userId });

  // ------------------------------------------------------------------- boot
  const httpServer = http.createServer(app);
  initSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  console.log(`\nTest server on ${BASE_URL}, project ${projectId}\n`);

  let admin: Socket | null = null;
  let viewer: Socket | null = null;

  try {
    // ------------------------------------------------------ 1. handshake auth
    let rejected = false;
    try {
      const bad = await connect("not-a-jwt");
      bad.disconnect();
    } catch {
      rejected = true;
    }
    check("rejects a connection with an invalid JWT", rejected);

    admin = await connect(adminToken);
    viewer = await connect(viewerToken);
    check("accepts connections with valid JWTs", admin.connected && viewer.connected);

    // ------------------------------------------------------------- 2. joining
    const adminJoin = await emit<TAck>(admin, "canvas:join", { projectId });
    check("admin joins and is told its role", adminJoin.ok && adminJoin.data?.["accessibility"] === "admin", adminJoin);

    const joinedByViewer = waitFor(admin, "presence:joined");
    const viewerJoin = await emit<TAck>(viewer, "canvas:join", { projectId });
    check("viewer joins and is told its role", viewerJoin.ok && viewerJoin.data?.["accessibility"] === "viewer", viewerJoin);
    await joinedByViewer;
    check("admin is notified that the viewer joined", true);

    const members = (adminJoin.data?.["members"] ?? []) as unknown[];
    check("join returns the live presence roster", Array.isArray(members));

    // ----------------------------------------- 3. create propagates to peers
    const elementId = crypto.randomUUID();
    const created = waitFor<{ element: { elementId: string } }>(viewer, "element:created");

    const createAck = await emit<TAck>(admin, "element:create", {
      projectId,
      element: {
        elementId,
        type: "rect",
        x: 40,
        y: 60,
        width: 200,
        height: 120,
        fill: "#1677ff",
      },
    });
    check("admin can create an element", createAck.ok, createAck);

    const seen = await created;
    check("viewer receives the created element live", seen.element.elementId === elementId);

    // ----------------------- 4. THE PERMISSION BOUNDARY: viewer cannot mutate
    const viewerCreate = await emit<TAck>(viewer, "element:create", {
      projectId,
      element: { elementId: crypto.randomUUID(), type: "ellipse", x: 0, y: 0, width: 50, height: 50 },
    });
    check("viewer is refused element:create", !viewerCreate.ok && viewerCreate.code === "FORBIDDEN", viewerCreate);

    const viewerUpdate = await emit<TAck>(viewer, "element:update", {
      projectId,
      elementId,
      baseVersion: 1,
      patch: { x: 999 },
    });
    check("viewer is refused element:update", !viewerUpdate.ok && viewerUpdate.code === "FORBIDDEN", viewerUpdate);

    const viewerDelete = await emit<TAck>(viewer, "element:delete", { projectId, elementIds: [elementId] });
    check("viewer is refused element:delete", !viewerDelete.ok && viewerDelete.code === "FORBIDDEN", viewerDelete);

    // ------------------------------------------------- 5. update + LWW resync
    const updated = waitFor<{ version: number }>(viewer, "element:updated");
    const updateAck = await emit<TAck>(admin, "element:update", {
      projectId,
      elementId,
      baseVersion: 1,
      patch: { x: 300, y: 150, fill: "#f5222d" },
    });
    check("admin can update an element", updateAck.ok && updateAck.data?.["version"] === 2, updateAck);
    await updated;
    check("viewer receives the update live", true);

    const syncedPromise = waitFor<{ element: { x: number } }>(admin, "element:synced");
    const staleAck = await emit<TAck>(admin, "element:update", {
      projectId,
      elementId,
      baseVersion: 1, // deliberately stale — version is now 2
      patch: { x: -1 },
    });
    check("a stale update is rejected", !staleAck.ok && staleAck.code === "VERSION_CONFLICT", staleAck);
    const synced = await syncedPromise;
    check("the loser is sent the authoritative element", synced.element.x === 300, synced.element);

    // ------------------------------------------------------------ 6. cursors
    const cursor = waitFor<{ x: number; y: number }>(viewer, "cursor:moved");
    admin.emit("cursor:move", { projectId, x: 12.5, y: 34.5 });
    const cursorSeen = await cursor;
    check("cursor position relays to peers", cursorSeen.x === 12.5 && cursorSeen.y === 34.5, cursorSeen);

    // ------------------------------------------------------- 7. canvas resize
    const resized = waitFor<{ canvas: { width: number } }>(viewer, "canvas:resized");
    const resizeAck = await emit<TAck>(admin, "canvas:resize", {
      projectId,
      width: 1920,
      height: 1080,
      aspectRatioPreset: "16:9",
    });
    check("admin can resize the canvas", resizeAck.ok, resizeAck);
    check("viewer sees the resize live", (await resized).canvas.width === 1920);

    const viewerResize = await emit<TAck>(viewer, "canvas:resize", {
      projectId,
      width: 100,
      height: 100,
      aspectRatioPreset: "1:1",
    });
    check("viewer is refused canvas:resize", !viewerResize.ok && viewerResize.code === "FORBIDDEN", viewerResize);

    // -------------------------------------------------- 8. validation is real
    const badPayload = await emit<TAck>(admin, "element:update", {
      projectId,
      elementId,
      baseVersion: 2,
      patch: { opacity: 42 }, // out of the 0..1 range
    });
    check("out-of-range values are rejected", !badPayload.ok && badPayload.code === "INVALID_PAYLOAD", badPayload);

    // --------------------------------------- 9. the cache actually flushes
    await canvasCacheService.flushAll();

    const [persisted] = await db.select().from(canvasElements).where(eq(canvasElements.elementId, elementId)).limit(1);
    check("the element reached Postgres after a flush", persisted !== undefined);
    check("the flushed row holds the coalesced final position", persisted?.x === 300 && persisted?.y === 150, {
      x: persisted?.x,
      y: persisted?.y,
    });
    check("the flushed row holds the bumped version", persisted?.version === 2, persisted?.version);
    check("props round-trips through jsonb", persisted?.props !== undefined);

    const [persistedCanvas] = await db.select().from(canvases).where(eq(canvases.projectId, projectId)).limit(1);
    check("the canvas resize reached Postgres", persistedCanvas?.width === 1920 && persistedCanvas?.height === 1080, {
      width: persistedCanvas?.width,
    });

    // ------------------------------------------------- 10. presence on leave
    const left = waitFor<{ userId: string }>(admin, "presence:left");
    viewer.disconnect();
    viewer = null;
    const leftPayload = await left;
    check("peers are told when someone leaves", leftPayload.userId === viewerRow.userId, leftPayload);

    // ---------------------------------------------------- 11. soft delete
    const deleteAck = await emit<TAck>(admin, "element:delete", { projectId, elementIds: [elementId] });
    check("admin can delete an element", deleteAck.ok, deleteAck);

    await canvasCacheService.flushAll();
    const [tombstoned] = await db
      .select()
      .from(canvasElements)
      .where(eq(canvasElements.elementId, elementId))
      .limit(1);
    check("delete is a soft delete (deletedAt set)", tombstoned?.deletedAt !== null, tombstoned?.deletedAt);
  } finally {
    admin?.disconnect();
    viewer?.disconnect();
    canvasCacheService.stopFlushLoop();
    await closeSocketServer();
    httpServer.close();
    await closeDbPool();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
};

void main().catch((error: unknown) => {
  console.error("\nCheck run failed:", error);
  process.exit(1);
});
