import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/connection.js";
import { canvasElements, canvases } from "@/db/schema.js";
import { CacheService } from "@/services/cache.service.js";
import type { Canvas, CanvasElement, NewCanvasElement } from "@/services/db.service.js";
import type { TElementCreateInput, TElementOrderEntry, TElementPatch } from "@/socket/socket.types.js";
import type { TAspectRatioPreset } from "@/types/canvas.types.js";
import { env } from "@/config/env.js";

/**
 * Live state for one project's canvas.
 *
 * `elements` is the authoritative copy while anyone is editing — reads are
 * served from here, and the DB only ever sees the coalesced result of a flush.
 */
type TProjectCanvasState = {
  canvas: Canvas;
  isCanvasDirty: boolean;
  elements: Map<string, CanvasElement>;
  /** Element ids created or modified since the last successful flush. */
  dirty: Set<string>;
  /** Element ids soft-deleted since the last successful flush. */
  deleted: Set<string>;
  lastAccessAt: number;
};

/** Rows per INSERT statement during a flush. Keeps bind-parameter counts sane. */
const FLUSH_CHUNK_SIZE = 200;

/** Returned by `applyPatch` when the caller lost a version race. */
export type TPatchOutcome =
  | { status: "applied"; version: number }
  | { status: "stale"; element: CanvasElement }
  | { status: "missing" };

/**
 * Holds every actively-edited canvas in memory and bulk-writes the dirty rows
 * to Postgres on an interval.
 *
 * The point of the interval is write amplification: dragging a shape emits an
 * update per animation frame, and writing each one would mean ~60 UPDATEs a
 * second per dragging user. Here a mutation is a `Map.set`, and a whole drag
 * collapses into one row write per flush window.
 */
export class CanvasCacheService {
  private static instance: CanvasCacheService;

  private readonly cache = new CacheService<string, TProjectCanvasState>();

  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Guards against a slow flush overlapping the next tick, which would let two
   * transactions race on the same rows.
   */
  private isFlushing = false;

  /** In-flight hydrations, so two simultaneous joins don't both read the DB. */
  private readonly hydrating = new Map<string, Promise<TProjectCanvasState>>();

  private constructor() {}

  static getInstance(): CanvasCacheService {
    if (!CanvasCacheService.instance) {
      CanvasCacheService.instance = new CanvasCacheService();
    }
    return CanvasCacheService.instance;
  }

  // ---------------------------------------------------------------- lifecycle

  startFlushLoop(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      void this.flushAll().catch((error: unknown) => {
        console.error("Canvas flush loop failed", error);
      });
    }, env.CANVAS_FLUSH_INTERVAL);

    // Don't let the timer alone hold the event loop open.
    this.flushTimer.unref();
  }

  stopFlushLoop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ---------------------------------------------------------------- hydration

  /**
   * Loads a project's canvas into memory on first access; every later read is
   * served from the Map. Concurrent callers share one DB round-trip.
   */
  async getOrHydrate(projectId: string): Promise<TProjectCanvasState> {
    const cached = this.cache.get(projectId);

    if (cached) {
      cached.lastAccessAt = Date.now();
      return cached;
    }

    const inFlight = this.hydrating.get(projectId);

    if (inFlight) {
      return inFlight;
    }

    const hydration = this.hydrate(projectId).finally(() => {
      this.hydrating.delete(projectId);
    });

    this.hydrating.set(projectId, hydration);

    return hydration;
  }

  private async hydrate(projectId: string): Promise<TProjectCanvasState> {
    const canvas = await this.findOrCreateCanvas(projectId);

    const rows = await db
      .select()
      .from(canvasElements)
      .where(and(eq(canvasElements.canvasId, canvas.canvasId), isNull(canvasElements.deletedAt)));

    const state: TProjectCanvasState = {
      canvas,
      isCanvasDirty: false,
      elements: new Map(rows.map((row) => [row.elementId, row])),
      dirty: new Set(),
      deleted: new Set(),
      lastAccessAt: Date.now(),
    };

    this.cache.set(projectId, state);

    return state;
  }

  /**
   * `createProject` seeds a canvas row, so this only actually inserts for
   * projects that predate that. `onConflictDoNothing` + re-select keeps it safe
   * if two sockets join such a project at the same moment.
   */
  private async findOrCreateCanvas(projectId: string): Promise<Canvas> {
    const [existing] = await db.select().from(canvases).where(eq(canvases.projectId, projectId)).limit(1);

    if (existing) {
      return existing;
    }

    const [created] = await db.insert(canvases).values({ projectId }).onConflictDoNothing().returning();

    if (created) {
      return created;
    }

    const [raced] = await db.select().from(canvases).where(eq(canvases.projectId, projectId)).limit(1);

    if (!raced) {
      throw new Error(`Failed to create canvas for project ${projectId}`);
    }

    return raced;
  }

  // ---------------------------------------------------------------- mutations

  async listElements(projectId: string): Promise<CanvasElement[]> {
    const state = await this.getOrHydrate(projectId);

    return [...state.elements.values()].sort((left, right) => left.zIndex - right.zIndex);
  }

  async getCanvas(projectId: string): Promise<Canvas> {
    const state = await this.getOrHydrate(projectId);

    return state.canvas;
  }

  async countElements(projectId: string): Promise<number> {
    const state = await this.getOrHydrate(projectId);

    return state.elements.size;
  }

  /** `null` means the client reused an id that already exists on this canvas. */
  async createElement(
    projectId: string,
    input: TElementCreateInput,
    createdBy: string,
  ): Promise<CanvasElement | null> {
    const state = await this.getOrHydrate(projectId);

    if (state.elements.has(input.elementId)) {
      return null;
    }

    // New elements go on top. Computed from the live Map, not a DB max(), so a
    // burst of inserts inside one flush window still stacks correctly.
    const topZIndex = [...state.elements.values()].reduce((max, element) => Math.max(max, element.zIndex), -1);

    const now = new Date();
    const element: CanvasElement = {
      elementId: input.elementId,
      canvasId: state.canvas.canvasId,
      type: input.type,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: input.rotation ?? 0,
      opacity: input.opacity ?? 1,
      fill: input.fill ?? null,
      stroke: input.stroke ?? null,
      strokeWidth: input.strokeWidth ?? 0,
      cornerRadius: input.cornerRadius ?? 0,
      zIndex: topZIndex + 1,
      props: input.props ?? {},
      version: 1,
      createdBy,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    state.elements.set(element.elementId, element);
    state.dirty.add(element.elementId);
    state.lastAccessAt = Date.now();

    return element;
  }

  /**
   * Last-write-wins merge. A `baseVersion` below the stored version means the
   * client patched a shape it hadn't seen the latest of, so it is told to
   * resync rather than having its stale values written.
   */
  async applyPatch(
    projectId: string,
    elementId: string,
    baseVersion: number,
    patch: TElementPatch,
  ): Promise<TPatchOutcome> {
    const state = await this.getOrHydrate(projectId);
    const existing = state.elements.get(elementId);

    if (!existing) {
      return { status: "missing" };
    }

    if (baseVersion < existing.version) {
      return { status: "stale", element: existing };
    }

    const merged: CanvasElement = {
      ...existing,
      // Spread conditionally throughout: `exactOptionalPropertyTypes` means an
      // explicit `undefined` is not the same as an absent key, and a partial
      // patch must not blank fields it simply didn't mention.
      ...(patch.x !== undefined ? { x: patch.x } : {}),
      ...(patch.y !== undefined ? { y: patch.y } : {}),
      ...(patch.width !== undefined ? { width: patch.width } : {}),
      ...(patch.height !== undefined ? { height: patch.height } : {}),
      ...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
      ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
      ...(patch.fill !== undefined ? { fill: patch.fill } : {}),
      ...(patch.stroke !== undefined ? { stroke: patch.stroke } : {}),
      ...(patch.strokeWidth !== undefined ? { strokeWidth: patch.strokeWidth } : {}),
      ...(patch.cornerRadius !== undefined ? { cornerRadius: patch.cornerRadius } : {}),
      ...(patch.props !== undefined ? { props: patch.props } : {}),
      version: existing.version + 1,
      updatedAt: new Date(),
    };

    state.elements.set(elementId, merged);
    state.dirty.add(elementId);
    state.lastAccessAt = Date.now();

    return { status: "applied", version: merged.version };
  }

  async deleteElements(projectId: string, elementIds: string[]): Promise<string[]> {
    const state = await this.getOrHydrate(projectId);
    const removed: string[] = [];

    for (const elementId of elementIds) {
      if (!state.elements.delete(elementId)) {
        continue;
      }

      removed.push(elementId);
      // Drop from `dirty` — a row that is about to be marked deleted has no
      // business also being upserted in the same flush.
      state.dirty.delete(elementId);
      state.deleted.add(elementId);
    }

    state.lastAccessAt = Date.now();

    return removed;
  }

  async reorderElements(projectId: string, order: TElementOrderEntry[]): Promise<TElementOrderEntry[]> {
    const state = await this.getOrHydrate(projectId);
    const applied: TElementOrderEntry[] = [];

    for (const entry of order) {
      const existing = state.elements.get(entry.elementId);

      if (!existing) {
        continue;
      }

      state.elements.set(entry.elementId, {
        ...existing,
        zIndex: entry.zIndex,
        version: existing.version + 1,
        updatedAt: new Date(),
      });
      state.dirty.add(entry.elementId);
      applied.push(entry);
    }

    state.lastAccessAt = Date.now();

    return applied;
  }

  async resizeCanvas(
    projectId: string,
    width: number,
    height: number,
    aspectRatioPreset: TAspectRatioPreset,
  ): Promise<Canvas> {
    const state = await this.getOrHydrate(projectId);

    state.canvas = {
      ...state.canvas,
      width,
      height,
      aspectRatioPreset,
      version: state.canvas.version + 1,
      updatedAt: new Date(),
    };
    state.isCanvasDirty = true;
    state.lastAccessAt = Date.now();

    return state.canvas;
  }

  async setBackgroundColor(projectId: string, backgroundColor: string): Promise<Canvas> {
    const state = await this.getOrHydrate(projectId);

    state.canvas = {
      ...state.canvas,
      backgroundColor,
      version: state.canvas.version + 1,
      updatedAt: new Date(),
    };
    state.isCanvasDirty = true;
    state.lastAccessAt = Date.now();

    return state.canvas;
  }

  // ------------------------------------------------------------------- flush

  async flushAll(): Promise<void> {
    if (this.isFlushing) {
      return;
    }

    this.isFlushing = true;

    try {
      for (const [projectId, state] of [...this.cache.entries()]) {
        await this.flushProject(projectId, state);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async flushProject(projectId: string, state?: TProjectCanvasState): Promise<void> {
    const target = state ?? this.cache.get(projectId);

    if (!target) {
      return;
    }

    if (!target.isCanvasDirty && target.dirty.size === 0 && target.deleted.size === 0) {
      return;
    }

    // Snapshot before awaiting. Edits arriving mid-flush land in the live sets
    // and must survive into the next window rather than being cleared as if
    // they had been written.
    const dirtyIds = [...target.dirty];
    const deletedIds = [...target.deleted];
    const wasCanvasDirty = target.isCanvasDirty;
    const canvasSnapshot = target.canvas;

    const rows: NewCanvasElement[] = [];

    for (const elementId of dirtyIds) {
      const element = target.elements.get(elementId);

      if (element) {
        rows.push(element);
      }
    }

    try {
      await db.transaction(async (tx) => {
        // Chunked so a huge reorder (which dirties every element) doesn't build
        // one enormous statement with tens of thousands of bind parameters.
        for (let offset = 0; offset < rows.length; offset += FLUSH_CHUNK_SIZE) {
          const chunk = rows.slice(offset, offset + FLUSH_CHUNK_SIZE);

          if (chunk.length === 0) {
            continue;
          }

          await tx
            .insert(canvasElements)
            .values(chunk)
            .onConflictDoUpdate({
              target: canvasElements.elementId,
              set: {
                // `excluded.*` is raw SQL, so these must be the snake_case DB
                // column names — Drizzle does not map camelCase keys inside a
                // `sql` fragment, and `excluded.strokeWidth` would fail at
                // runtime with `column "strokewidth" does not exist`.
                x: sql`excluded.x`,
                y: sql`excluded.y`,
                width: sql`excluded.width`,
                height: sql`excluded.height`,
                rotation: sql`excluded.rotation`,
                opacity: sql`excluded.opacity`,
                fill: sql`excluded.fill`,
                stroke: sql`excluded.stroke`,
                strokeWidth: sql`excluded.stroke_width`,
                cornerRadius: sql`excluded.corner_radius`,
                zIndex: sql`excluded.z_index`,
                props: sql`excluded.props`,
                version: sql`excluded.version`,
                // `$onUpdate` only fires for `.update()`, never on the conflict
                // path, so this must be set explicitly or `updated_at` stays
                // frozen at insert time forever.
                updatedAt: sql`now()`,
              },
              // Two guards in one template. `and(...)` would return
              // `SQL | undefined`, which `exactOptionalPropertyTypes` refuses to
              // assign to `setWhere?: SQL`.
              //   1. canvas_id equality — element ids are client-minted, so this
              //      makes it impossible to re-parent an element into another
              //      canvas by guessing its id.
              //   2. the same last-write-wins rule as the in-memory check, so a
              //      late retry of a failed flush can never move an element
              //      backwards past a newer write.
              setWhere: sql`${canvasElements.canvasId} = excluded.canvas_id and excluded.version >= ${canvasElements.version}`,
            });
        }

        if (deletedIds.length > 0) {
          await tx
            .update(canvasElements)
            .set({ deletedAt: new Date() })
            .where(inArray(canvasElements.elementId, deletedIds));
        }

        if (wasCanvasDirty) {
          await tx
            .update(canvases)
            .set({
              width: canvasSnapshot.width,
              height: canvasSnapshot.height,
              aspectRatioPreset: canvasSnapshot.aspectRatioPreset,
              backgroundColor: canvasSnapshot.backgroundColor,
              version: canvasSnapshot.version,
            })
            .where(eq(canvases.canvasId, canvasSnapshot.canvasId));
        }
      });
    } catch (error) {
      // Leave the dirty sets intact so the next tick retries. Losing a flush is
      // recoverable; clearing the flags on a failed write would lose the edits.
      console.error(`Failed to flush canvas for project ${projectId}`, error);
      return;
    }

    // Only clear what was actually written.
    for (const elementId of dirtyIds) {
      target.dirty.delete(elementId);
    }

    for (const elementId of deletedIds) {
      target.deleted.delete(elementId);
    }

    if (wasCanvasDirty && target.canvas.version === canvasSnapshot.version) {
      target.isCanvasDirty = false;
    }
  }

  // ---------------------------------------------------------------- eviction

  /**
   * Drops idle, fully-flushed projects. `hasLiveMembers` is supplied by the
   * socket layer so this service needs no knowledge of rooms.
   */
  evictIdle(hasLiveMembers: (projectId: string) => boolean): void {
    const now = Date.now();

    for (const [projectId, state] of [...this.cache.entries()]) {
      const isClean = !state.isCanvasDirty && state.dirty.size === 0 && state.deleted.size === 0;
      const isIdle = now - state.lastAccessAt > env.CANVAS_CACHE_TTL;

      if (isClean && isIdle && !hasLiveMembers(projectId)) {
        this.cache.delete(projectId);
      }
    }
  }

  /** Flushes then drops a single project — used when its last member disconnects. */
  async flushAndRelease(projectId: string): Promise<void> {
    await this.flushProject(projectId);
    this.cache.delete(projectId);
  }
}

export const canvasCacheService = CanvasCacheService.getInstance();
