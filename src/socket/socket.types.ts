import type { Canvas, CanvasElement, ProjectMemberRole, User } from "@/services/db.service.js";
import type { TAspectRatioPreset, TCanvasElementType, TElementProps } from "@/types/canvas.types.js";

/**
 * The realtime contract. `canva-frontend/src/services/socket/socket.types.ts`
 * mirrors this file — change both together.
 */

/** Everyone in a project room receives element traffic for it. */
export const projectRoom = (projectId: string): string => `project:${projectId}`;

/**
 * Every socket also joins a room keyed on its own user id, so a role change
 * made over REST can reach all of that person's open tabs at once.
 */
export const userRoom = (userId: string): string => `user:${userId}`;

export const SOCKET_ERROR_CODE = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  NOT_IN_ROOM: "NOT_IN_ROOM",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  DUPLICATE_ID: "DUPLICATE_ID",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  INVALID_OPERATION: "INVALID_OPERATION",
  INTERNAL: "INTERNAL",
} as const;

export type TSocketErrorCode = (typeof SOCKET_ERROR_CODE)[keyof typeof SOCKET_ERROR_CODE];

/** Acks are a discriminated union on `ok`, so handlers can never read a payload off a failure. */
export type TAck<T> = { ok: true; data: T } | { ok: false; code: TSocketErrorCode; error: string };

/** A live participant. One entry per socket, so two tabs show as two cursors but one avatar. */
export type TPresenceMember = {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  accessibility: ProjectMemberRole;
  /** Stable per-user colour for the cursor and avatar ring. */
  color: string;
  /** The slide this socket currently has open — lets peers scope cursors to a shared slide. */
  activeCanvasId: string;
};

/** Wire form of an element. Dates are serialised, so they are dropped rather than sent as strings. */
export type TElementDto = Omit<CanvasElement, "createdAt" | "updatedAt" | "deletedAt">;

export type TCanvasDto = Omit<Canvas, "createdAt" | "updatedAt">;

export type TElementCreateInput = {
  /**
   * Minted by the client, not the server. This lets the client place the element
   * on the Konva stage and immediately start streaming transform frames for it
   * under its final id — with a server-assigned id it would have to render under
   * a temporary id and then re-key selection and transformer state on the ack.
   *
   * Cross-project hijack of a guessed id is blocked by the `canvas_id` clause in
   * the flush's `setWhere`; in-canvas duplicates are rejected on create.
   */
  elementId: string;
  type: TCanvasElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  // Explicit `| undefined` on every optional key throughout this file: under
  // `exactOptionalPropertyTypes` a bare `?` means "absent", so a zod
  // `.optional()` output (`{ rotation?: number | undefined }`) is NOT assignable
  // to it. These types must mirror what zod actually infers.
  rotation?: number | undefined;
  opacity?: number | undefined;
  fill?: string | null | undefined;
  stroke?: string | null | undefined;
  strokeWidth?: number | undefined;
  cornerRadius?: number | undefined;
  props?: TElementProps | undefined;
};

/**
 * A partial element update. `props` is replaced wholesale rather than
 * deep-merged — the client always holds the full element, so it sends the
 * complete new blob and there is no ambiguity about how to merge nested keys.
 *
 * Spelled out rather than `Partial<Omit<TElementCreateInput, "type">>`, because
 * `Partial<T>` under `exactOptionalPropertyTypes` produces keys that reject an
 * explicit `undefined` — which is exactly what the zod schema hands us.
 */
export type TElementPatch = {
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  rotation?: number | undefined;
  opacity?: number | undefined;
  fill?: string | null | undefined;
  stroke?: string | null | undefined;
  strokeWidth?: number | undefined;
  cornerRadius?: number | undefined;
  props?: TElementProps | undefined;
};

export type TElementOrderEntry = { elementId: string; zIndex: number };

export type TSlideOrderEntry = { canvasId: string; orderIndex: number };

export type TJoinResult = {
  /** Every slide's metadata, ordered. */
  slides: TCanvasDto[];
  activeCanvasId: string;
  /** Only the active slide's elements — everything else is fetched lazily via `slide:activate`. */
  elements: TElementDto[];
  members: TPresenceMember[];
  accessibility: ProjectMemberRole;
  selfSocketId: string;
};

export type ClientToServerEvents = {
  "canvas:join": (
    payload: { projectId: string; activeCanvasId?: string },
    ack: (result: TAck<TJoinResult>) => void,
  ) => void;
  "canvas:leave": (payload: { projectId: string }) => void;

  /**
   * Canvas-space coordinates, throttled client-side to one frame. Never
   * persisted — presence is ephemeral by definition.
   */
  "cursor:move": (payload: { projectId: string; x: number; y: number }) => void;

  "selection:change": (payload: { projectId: string; elementIds: string[] }) => void;

  /** Fire-and-forget: broadcasts which slide this socket now has open, for cursor/presence scoping. */
  "presence:activeSlide": (payload: { projectId: string; canvasId: string }) => void;

  /** Lazily fetches one slide's elements — the first time it's needed after a join that didn't include it. */
  "slide:activate": (
    payload: { projectId: string; canvasId: string },
    ack: (result: TAck<{ elements: TElementDto[] }>) => void,
  ) => void;

  "slide:create": (
    payload: { projectId: string; canvasId: string; afterCanvasId?: string },
    ack: (result: TAck<{ slide: TCanvasDto; order: TSlideOrderEntry[] }>) => void,
  ) => void;

  /** `canvasId` here is the slide being copied, not the new one — the server mints that id. */
  "slide:duplicate": (
    payload: { projectId: string; canvasId: string },
    ack: (result: TAck<{ slide: TCanvasDto; elements: TElementDto[]; order: TSlideOrderEntry[] }>) => void,
  ) => void;

  "slide:reorder": (
    payload: { projectId: string; order: TSlideOrderEntry[] },
    ack: (result: TAck<{ order: TSlideOrderEntry[] }>) => void,
  ) => void;

  "slide:delete": (
    payload: { projectId: string; canvasId: string },
    ack: (result: TAck<{ canvasId: string }>) => void,
  ) => void;

  "element:create": (
    payload: { projectId: string; canvasId: string; element: TElementCreateInput },
    ack: (result: TAck<{ element: TElementDto }>) => void,
  ) => void;

  "element:update": (
    payload: { projectId: string; canvasId: string; elementId: string; baseVersion: number; patch: TElementPatch },
    ack: (result: TAck<{ version: number }>) => void,
  ) => void;

  "element:delete": (
    payload: { projectId: string; canvasId: string; elementIds: string[] },
    ack: (result: TAck<{ elementIds: string[] }>) => void,
  ) => void;

  "element:reorder": (
    payload: { projectId: string; canvasId: string; order: TElementOrderEntry[] },
    ack: (result: TAck<{ order: TElementOrderEntry[] }>) => void,
  ) => void;

  "canvas:resize": (
    payload: {
      projectId: string;
      canvasId: string;
      width: number;
      height: number;
      aspectRatioPreset: TAspectRatioPreset;
    },
    ack: (result: TAck<{ canvas: TCanvasDto }>) => void,
  ) => void;
};

export type ServerToClientEvents = {
  "presence:sync": (payload: { projectId: string; members: TPresenceMember[] }) => void;
  "presence:joined": (payload: { projectId: string; member: TPresenceMember }) => void;
  "presence:left": (payload: { projectId: string; socketId: string; userId: string }) => void;

  "cursor:moved": (payload: { projectId: string; socketId: string; userId: string; x: number; y: number }) => void;
  "selection:changed": (payload: { projectId: string; socketId: string; elementIds: string[] }) => void;
  "presence:activeSlideChanged": (payload: { projectId: string; socketId: string; canvasId: string }) => void;

  "slide:created": (payload: {
    projectId: string;
    socketId: string;
    slide: TCanvasDto;
    order: TSlideOrderEntry[];
  }) => void;
  "slide:duplicated": (payload: {
    projectId: string;
    socketId: string;
    slide: TCanvasDto;
    elements: TElementDto[];
    order: TSlideOrderEntry[];
  }) => void;
  "slide:reordered": (payload: { projectId: string; socketId: string; order: TSlideOrderEntry[] }) => void;
  "slide:deleted": (payload: { projectId: string; socketId: string; canvasId: string }) => void;

  // Every broadcast carries its originating `socketId` so the sender can
  // discard its own echo instead of re-applying what it already applied
  // optimistically.
  "element:created": (payload: { projectId: string; canvasId: string; socketId: string; element: TElementDto }) => void;
  "element:updated": (payload: {
    projectId: string;
    canvasId: string;
    socketId: string;
    elementId: string;
    version: number;
    patch: TElementPatch;
  }) => void;
  "element:deleted": (payload: {
    projectId: string;
    canvasId: string;
    socketId: string;
    elementIds: string[];
  }) => void;
  "element:reordered": (payload: {
    projectId: string;
    canvasId: string;
    socketId: string;
    order: TElementOrderEntry[];
  }) => void;

  /**
   * The authoritative element, sent only to a client whose patch lost a version
   * race. Overwrite local state unconditionally on receipt.
   */
  "element:synced": (payload: { projectId: string; canvasId: string; element: TElementDto }) => void;

  "canvas:resized": (payload: { projectId: string; canvasId: string; socketId: string; canvas: TCanvasDto }) => void;

  "access:changed": (payload: { projectId: string; accessibility: ProjectMemberRole }) => void;
  "access:revoked": (payload: { projectId: string }) => void;

  "socket:error": (payload: { code: TSocketErrorCode; error: string }) => void;
};

export type TSocketData = {
  user: User;
  /** Per-project role, refreshed on join and rewritten in place when an admin changes it. */
  roles: Map<string, ProjectMemberRole>;
  color: string;
  /** Per-project active slide, mirroring `roles` — set on join, updated by `presence:activeSlide`. */
  activeCanvasIds: Map<string, string>;
};
