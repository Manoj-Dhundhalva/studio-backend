import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/connection.js";
import { canvasElements, canvases } from "@/db/schema.js";
import { CacheService } from "@/services/cache.service.js";
import type { Canvas, CanvasElement, NewCanvasElement } from "@/services/db.service.js";
import type { TElementCreateInput, TElementOrderEntry, TElementPatch, TSlideOrderEntry } from "@/socket/socket.types.js";
import type { TAspectRatioPreset } from "@/types/canvas.types.js";
import { env } from "@/config/env.js";

/**
 * Live state for one slide (one `canvases` row).
 *
 * `elements` is the authoritative copy while anyone is editing — reads are
 * served from here, and the DB only ever sees the coalesced result of a
 * flush. `null` means the slide's metadata is known (from the project-level
 * hydration) but its elements haven't been loaded yet — deferred until
 * something actually needs them, so joining a project with many slides only
 * pays for the elements of the one slide being viewed.
 */
type TSlideState = {
  canvas: Canvas;
  isCanvasDirty: boolean;
  elements: Map<string, CanvasElement> | null;
  /** Element ids created or modified since the last successful flush. */
  dirty: Set<string>;
  /** Element ids soft-deleted since the last successful flush. */
  deleted: Set<string>;
};

/** Live state for one project: every slide, in order. */
type TProjectState = {
  /** Keyed by canvasId. */
  slides: Map<string, TSlideState>;
  /** canvasId order, mirrors each slide's `orderIndex` ascending. */
  order: string[];
  lastAccessAt: number;
};

/** Rows per INSERT statement during a flush. Keeps bind-parameter counts sane. */
const FLUSH_CHUNK_SIZE = 200;

/** Returned by `applyPatch` when the caller lost a version race. */
export type TPatchOutcome =
  | { status: "applied"; version: number }
  | { status: "stale"; element: CanvasElement }
  | { status: "missing" };

/** Returned by `deleteSlide`. */
export type TDeleteSlideOutcome = { status: "deleted" } | { status: "last-slide" } | { status: "not-found" };

/**
 * Holds every actively-edited project (and its slides) in memory and
 * bulk-writes the dirty rows to Postgres on an interval.
 *
 * The point of the interval is write amplification: dragging a shape emits an
 * update per animation frame, and writing each one would mean ~60 UPDATEs a
 * second per dragging user. Here a mutation is a `Map.set`, and a whole drag
 * collapses into one row write per flush window.
 *
 * Slide-structural changes (create/duplicate/reorder/delete a slide) are the
 * opposite: low-frequency and click-driven, so they write to Postgres
 * synchronously instead of going through this deferred cycle — losing one
 * silently would visibly break a deck, unlike a dropped drag frame.
 */
export class CanvasCacheService {
  private static instance: CanvasCacheService;

  private readonly cache = new CacheService<string, TProjectState>();

  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Guards against a slow flush overlapping the next tick, which would let two
   * transactions race on the same rows.
   */
  private isFlushing = false;

  /** In-flight project hydrations, so two simultaneous joins don't both read the DB. */
  private readonly hydratingProject = new Map<string, Promise<TProjectState>>();

  /** In-flight per-slide element hydrations, keyed by canvasId. */
  private readonly hydratingElements = new Map<string, Promise<Map<string, CanvasElement>>>();

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
   * Loads a project's slides (metadata only, no elements) into memory on
   * first access; every later read is served from the Map. Concurrent
   * callers share one DB round-trip.
   */
  async getOrHydrateProject(projectId: string): Promise<TProjectState> {
    const cached = this.cache.get(projectId);

    if (cached) {
      cached.lastAccessAt = Date.now();
      return cached;
    }

    const inFlight = this.hydratingProject.get(projectId);

    if (inFlight) {
      return inFlight;
    }

    const hydration = this.hydrateProject(projectId).finally(() => {
      this.hydratingProject.delete(projectId);
    });

    this.hydratingProject.set(projectId, hydration);

    return hydration;
  }

  private async hydrateProject(projectId: string): Promise<TProjectState> {
    const rows = await this.findOrCreateSlideRows(projectId);

    const slides = new Map<string, TSlideState>();
    const order: string[] = [];

    for (const canvas of rows) {
      slides.set(canvas.canvasId, {
        canvas,
        isCanvasDirty: false,
        elements: null,
        dirty: new Set(),
        deleted: new Set(),
      });
      order.push(canvas.canvasId);
    }

    const state: TProjectState = { slides, order, lastAccessAt: Date.now() };

    this.cache.set(projectId, state);

    return state;
  }

  /**
   * `createProject` seeds a canvas row, so this only actually inserts for
   * projects that predate that — a safety net, not the general path. Returns
   * every slide ordered. `onConflictDoNothing` + re-select keeps it safe if
   * two sockets join such a project at the same moment; the in-flight
   * `hydratingProject` promise-sharing above already prevents this within one
   * process, so this is defence in depth, not the primary guard.
   */
  private async findOrCreateSlideRows(projectId: string): Promise<Canvas[]> {
    const existing = await db
      .select()
      .from(canvases)
      .where(eq(canvases.projectId, projectId))
      .orderBy(asc(canvases.orderIndex));

    if (existing.length > 0) {
      return existing;
    }

    const [created] = await db.insert(canvases).values({ projectId }).onConflictDoNothing().returning();

    if (created) {
      return [created];
    }

    const raced = await db
      .select()
      .from(canvases)
      .where(eq(canvases.projectId, projectId))
      .orderBy(asc(canvases.orderIndex));

    if (raced.length === 0) {
      throw new Error(`Failed to create canvas for project ${projectId}`);
    }

    return raced;
  }

  /**
   * Resolves one slide with its elements guaranteed hydrated. `null` means
   * `canvasId` doesn't belong to `projectId` (stale/guessed id, or a
   * concurrent delete) — every caller treats that as "nothing to do" rather
   * than throwing, since the socket handlers already check `hasSlide` up
   * front and turn that into a proper `NOT_FOUND` ack.
   */
  private async resolveSlide(
    projectId: string,
    canvasId: string,
  ): Promise<{ project: TProjectState; slide: TSlideState; elements: Map<string, CanvasElement> } | null> {
    const project = await this.getOrHydrateProject(projectId);
    const slide = project.slides.get(canvasId);

    if (!slide) {
      return null;
    }

    if (slide.elements === null) {
      const inFlight = this.hydratingElements.get(canvasId);
      const pending = inFlight ?? this.hydrateSlideElements(canvasId);

      if (!inFlight) {
        this.hydratingElements.set(
          canvasId,
          pending.finally(() => this.hydratingElements.delete(canvasId)),
        );
      }

      slide.elements = await pending;
    }

    project.lastAccessAt = Date.now();

    return { project, slide, elements: slide.elements };
  }

  private async hydrateSlideElements(canvasId: string): Promise<Map<string, CanvasElement>> {
    const rows = await db
      .select()
      .from(canvasElements)
      .where(and(eq(canvasElements.canvasId, canvasId), isNull(canvasElements.deletedAt)));

    return new Map(rows.map((row) => [row.elementId, row]));
  }

  // ------------------------------------------------------------------ slides

  async hasSlide(projectId: string, canvasId: string): Promise<boolean> {
    const project = await this.getOrHydrateProject(projectId);

    return project.slides.has(canvasId);
  }

  /** Lightweight — metadata only, for the strip. No element hydration. */
  async listSlides(projectId: string): Promise<Canvas[]> {
    const project = await this.getOrHydrateProject(projectId);

    return project.order.map((canvasId) => project.slides.get(canvasId)!.canvas);
  }

  /**
   * Inserts a new blank slide at the given position (default: end), copying
   * dimensions/background from `afterCanvasId`'s slide (or the project's
   * first slide) so a new slide isn't a mismatched size. `canvasId` is
   * client-minted — mirrors `TElementCreateInput.elementId` — so the client
   * can render the new thumbnail optimistically, before the ack.
   */
  async createSlide(
    projectId: string,
    canvasId: string,
    afterCanvasId?: string,
  ): Promise<{ canvas: Canvas; order: TSlideOrderEntry[] }> {
    const project = await this.getOrHydrateProject(projectId);

    const afterIndex = afterCanvasId ? project.order.indexOf(afterCanvasId) : project.order.length - 1;
    const insertPosition = afterIndex === -1 ? project.order.length : afterIndex + 1;
    const referenceId = project.order[insertPosition - 1] ?? project.order[0];
    const reference = referenceId ? project.slides.get(referenceId) : undefined;

    const nextOrder = [...project.order];
    nextOrder.splice(insertPosition, 0, canvasId);

    const now = new Date();
    const newCanvas: Canvas = {
      canvasId,
      projectId,
      width: reference?.canvas.width ?? 1080,
      height: reference?.canvas.height ?? 1080,
      aspectRatioPreset: reference?.canvas.aspectRatioPreset ?? null,
      backgroundColor: reference?.canvas.backgroundColor ?? "#ffffff",
      version: 0,
      orderIndex: insertPosition,
      createdAt: now,
      updatedAt: now,
    };

    await db.transaction(async (tx) => {
      await tx.insert(canvases).values(newCanvas);

      for (const [index, id] of nextOrder.entries()) {
        await tx.update(canvases).set({ orderIndex: index }).where(eq(canvases.canvasId, id));
      }
    });

    project.slides.set(canvasId, {
      canvas: newCanvas,
      isCanvasDirty: false,
      elements: new Map(),
      dirty: new Set(),
      deleted: new Set(),
    });
    project.order = nextOrder;
    this.reindexSlides(project, nextOrder);
    project.lastAccessAt = Date.now();

    return {
      canvas: project.slides.get(canvasId)!.canvas,
      order: nextOrder.map((id, index) => ({ canvasId: id, orderIndex: index })),
    };
  }

  /**
   * Deep-copies a slide: new canvas row placed right after the source, plus
   * every live element with fresh server-minted ids. Reads the source from
   * the live cache (hydrating it if needed), not straight from Postgres —
   * the cache is authoritative for anything mid-edit, same reasoning as
   * `getCanvas`'s REST fallback.
   */
  async duplicateSlide(
    projectId: string,
    sourceCanvasId: string,
  ): Promise<{ canvas: Canvas; elements: CanvasElement[]; order: TSlideOrderEntry[] } | null> {
    const resolved = await this.resolveSlide(projectId, sourceCanvasId);

    if (!resolved) {
      return null;
    }

    const { project, slide: sourceSlide, elements: sourceElements } = resolved;

    const newCanvasId = crypto.randomUUID();
    const insertPosition = project.order.indexOf(sourceCanvasId) + 1;
    const nextOrder = [...project.order];
    nextOrder.splice(insertPosition, 0, newCanvasId);

    const now = new Date();
    const newCanvas: Canvas = {
      ...sourceSlide.canvas,
      canvasId: newCanvasId,
      version: 0,
      orderIndex: insertPosition,
      createdAt: now,
      updatedAt: now,
    };

    const copiedElements: CanvasElement[] = [...sourceElements.values()].map((element) => ({
      ...element,
      elementId: crypto.randomUUID(),
      canvasId: newCanvasId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));

    await db.transaction(async (tx) => {
      await tx.insert(canvases).values(newCanvas);

      if (copiedElements.length > 0) {
        await tx.insert(canvasElements).values(copiedElements);
      }

      for (const [index, id] of nextOrder.entries()) {
        await tx.update(canvases).set({ orderIndex: index }).where(eq(canvases.canvasId, id));
      }
    });

    project.slides.set(newCanvasId, {
      canvas: newCanvas,
      isCanvasDirty: false,
      elements: new Map(copiedElements.map((element) => [element.elementId, element])),
      dirty: new Set(),
      deleted: new Set(),
    });
    project.order = nextOrder;
    this.reindexSlides(project, nextOrder);
    project.lastAccessAt = Date.now();

    return {
      canvas: project.slides.get(newCanvasId)!.canvas,
      elements: copiedElements,
      order: nextOrder.map((id, index) => ({ canvasId: id, orderIndex: index })),
    };
  }

  /** Same shape as `reorderElements`: caller sends the full new order, server writes it verbatim. */
  async reorderSlides(projectId: string, order: TSlideOrderEntry[]): Promise<TSlideOrderEntry[]> {
    const project = await this.getOrHydrateProject(projectId);
    const applied = order.filter((entry) => project.slides.has(entry.canvasId));

    if (applied.length === 0) {
      return [];
    }

    await db.transaction(async (tx) => {
      for (const entry of applied) {
        await tx.update(canvases).set({ orderIndex: entry.orderIndex }).where(eq(canvases.canvasId, entry.canvasId));
      }
    });

    for (const entry of applied) {
      const slide = project.slides.get(entry.canvasId);

      if (slide) {
        slide.canvas = { ...slide.canvas, orderIndex: entry.orderIndex };
      }
    }

    project.order = [...project.slides.keys()].sort(
      (a, b) => (project.slides.get(a)?.canvas.orderIndex ?? 0) - (project.slides.get(b)?.canvas.orderIndex ?? 0),
    );
    project.lastAccessAt = Date.now();

    return applied;
  }

  /**
   * Hard-deletes the canvas row (cascades to `canvas_elements` via the
   * existing FK). Rejects if this is the project's only remaining slide — a
   * project must always have at least one, mirroring `createProject` seeding
   * exactly one canvas so a project can never exist without one.
   */
  async deleteSlide(projectId: string, canvasId: string): Promise<TDeleteSlideOutcome> {
    const project = await this.getOrHydrateProject(projectId);

    if (!project.slides.has(canvasId)) {
      return { status: "not-found" };
    }

    if (project.order.length <= 1) {
      return { status: "last-slide" };
    }

    await db.delete(canvases).where(eq(canvases.canvasId, canvasId));

    project.slides.delete(canvasId);
    project.order = project.order.filter((id) => id !== canvasId);
    project.lastAccessAt = Date.now();

    return { status: "deleted" };
  }

  /** Renumbers every slide's in-memory `orderIndex` to match its position in `order`. */
  private reindexSlides(project: TProjectState, order: string[]): void {
    order.forEach((canvasId, index) => {
      const slide = project.slides.get(canvasId);

      if (slide) {
        slide.canvas = { ...slide.canvas, orderIndex: index };
      }
    });
  }

  // ---------------------------------------------------------------- mutations

  async listElements(projectId: string, canvasId: string): Promise<CanvasElement[]> {
    const resolved = await this.resolveSlide(projectId, canvasId);

    if (!resolved) {
      return [];
    }

    return [...resolved.elements.values()].sort((left, right) => left.zIndex - right.zIndex);
  }

  async getCanvas(projectId: string, canvasId: string): Promise<Canvas | null> {
    const project = await this.getOrHydrateProject(projectId);

    return project.slides.get(canvasId)?.canvas ?? null;
  }

  async countElements(projectId: string, canvasId: string): Promise<number> {
    const resolved = await this.resolveSlide(projectId, canvasId);

    return resolved ? resolved.elements.size : 0;
  }

  /**
   * `null` means the client reused an id that already exists on this canvas,
   * or the slide doesn't exist. `createdBy` is nullable so AI-authored
   * elements (no human on the other end of the request) can be recorded
   * honestly instead of attributing them to whichever user sent the prompt.
   */
  async createElement(
    projectId: string,
    canvasId: string,
    input: TElementCreateInput,
    createdBy: string | null,
  ): Promise<CanvasElement | null> {
    const resolved = await this.resolveSlide(projectId, canvasId);

    if (!resolved) {
      return null;
    }

    const { project, slide, elements } = resolved;

    if (elements.has(input.elementId)) {
      return null;
    }

    // New elements go on top. Computed from the live Map, not a DB max(), so a
    // burst of inserts inside one flush window still stacks correctly.
    const topZIndex = [...elements.values()].reduce((max, element) => Math.max(max, element.zIndex), -1);

    const now = new Date();
    const element: CanvasElement = {
      elementId: input.elementId,
      canvasId: slide.canvas.canvasId,
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

    elements.set(element.elementId, element);
    slide.dirty.add(element.elementId);
    project.lastAccessAt = Date.now();

    return element;
  }

  /**
   * Last-write-wins merge. A `baseVersion` below the stored version means the
   * client patched a shape it hadn't seen the latest of, so it is told to
   * resync rather than having its stale values written.
   */
  async applyPatch(
    projectId: string,
    canvasId: string,
    elementId: string,
    baseVersion: number,
    patch: TElementPatch,
  ): Promise<TPatchOutcome> {
    const resolved = await this.resolveSlide(projectId, canvasId);

    if (!resolved) {
      return { status: "missing" };
    }

    const { project, slide, elements } = resolved;
    const existing = elements.get(elementId);

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

    elements.set(elementId, merged);
    slide.dirty.add(elementId);
    project.lastAccessAt = Date.now();

    return { status: "applied", version: merged.version };
  }

  async deleteElements(projectId: string, canvasId: string, elementIds: string[]): Promise<string[]> {
    const resolved = await this.resolveSlide(projectId, canvasId);

    if (!resolved) {
      return [];
    }

    const { project, slide, elements } = resolved;
    const removed: string[] = [];

    for (const elementId of elementIds) {
      if (!elements.delete(elementId)) {
        continue;
      }

      removed.push(elementId);
      // Drop from `dirty` — a row that is about to be marked deleted has no
      // business also being upserted in the same flush.
      slide.dirty.delete(elementId);
      slide.deleted.add(elementId);
    }

    project.lastAccessAt = Date.now();

    return removed;
  }

  async reorderElements(projectId: string, canvasId: string, order: TElementOrderEntry[]): Promise<TElementOrderEntry[]> {
    const resolved = await this.resolveSlide(projectId, canvasId);

    if (!resolved) {
      return [];
    }

    const { project, slide, elements } = resolved;
    const applied: TElementOrderEntry[] = [];

    for (const entry of order) {
      const existing = elements.get(entry.elementId);

      if (!existing) {
        continue;
      }

      elements.set(entry.elementId, {
        ...existing,
        zIndex: entry.zIndex,
        version: existing.version + 1,
        updatedAt: new Date(),
      });
      slide.dirty.add(entry.elementId);
      applied.push(entry);
    }

    project.lastAccessAt = Date.now();

    return applied;
  }

  async resizeCanvas(
    projectId: string,
    canvasId: string,
    width: number,
    height: number,
    aspectRatioPreset: TAspectRatioPreset,
  ): Promise<Canvas> {
    const project = await this.getOrHydrateProject(projectId);
    const slide = project.slides.get(canvasId);

    if (!slide) {
      throw new Error(`Slide ${canvasId} not found in project ${projectId}`);
    }

    slide.canvas = {
      ...slide.canvas,
      width,
      height,
      aspectRatioPreset,
      version: slide.canvas.version + 1,
      updatedAt: new Date(),
    };
    slide.isCanvasDirty = true;
    project.lastAccessAt = Date.now();

    return slide.canvas;
  }

  async setBackgroundColor(projectId: string, canvasId: string, backgroundColor: string): Promise<Canvas> {
    const project = await this.getOrHydrateProject(projectId);
    const slide = project.slides.get(canvasId);

    if (!slide) {
      throw new Error(`Slide ${canvasId} not found in project ${projectId}`);
    }

    slide.canvas = {
      ...slide.canvas,
      backgroundColor,
      version: slide.canvas.version + 1,
      updatedAt: new Date(),
    };
    slide.isCanvasDirty = true;
    project.lastAccessAt = Date.now();

    return slide.canvas;
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

  async flushProject(projectId: string, state?: TProjectState): Promise<void> {
    const target = state ?? this.cache.get(projectId);

    if (!target) {
      return;
    }

    for (const [canvasId, slide] of target.slides) {
      await this.flushSlide(canvasId, slide);
    }
  }

  private async flushSlide(canvasId: string, slide: TSlideState): Promise<void> {
    if (!slide.isCanvasDirty && slide.dirty.size === 0 && slide.deleted.size === 0) {
      return;
    }

    // Snapshot before awaiting. Edits arriving mid-flush land in the live sets
    // and must survive into the next window rather than being cleared as if
    // they had been written.
    const dirtyIds = [...slide.dirty];
    const deletedIds = [...slide.deleted];
    const wasCanvasDirty = slide.isCanvasDirty;
    const canvasSnapshot = slide.canvas;

    const rows: NewCanvasElement[] = [];

    for (const elementId of dirtyIds) {
      const element = slide.elements?.get(elementId);

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
      console.error(`Failed to flush slide ${canvasId}`, error);
      return;
    }

    // Only clear what was actually written.
    for (const elementId of dirtyIds) {
      slide.dirty.delete(elementId);
    }

    for (const elementId of deletedIds) {
      slide.deleted.delete(elementId);
    }

    if (wasCanvasDirty && slide.canvas.version === canvasSnapshot.version) {
      slide.isCanvasDirty = false;
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
      const isClean = [...state.slides.values()].every(
        (slide) => !slide.isCanvasDirty && slide.dirty.size === 0 && slide.deleted.size === 0,
      );
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
