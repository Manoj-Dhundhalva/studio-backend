import { type Request, type Response } from "express";

import { env } from "@/config/env.js";
import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { dbService, type AiMessage } from "@/services/db.service.js";
import { openAiService, type TAiOperation, type TAiSlideContext } from "@/services/openai.service.js";
import { toCanvasDto, toElementDto } from "@/socket/canvas.handlers.js";
import { tryGetIo } from "@/socket/index.js";
import { projectRoom, type TAiMessageDto } from "@/socket/socket.types.js";
import { ASPECT_RATIO_SIZES } from "@/types/canvas.types.js";

import type { ProjectIdParams } from "@/modules/project/project.validation.js";

import type { SendAiMessageBody } from "./ai.validation.js";

/** How many prior turns are sent back to the model as conversational context. */
const AI_HISTORY_LIMIT = 20;

/**
 * Ceiling on slides one request may create. There is no max-slides limit in
 * the schema or cache layer, so without this a runaway model could append
 * hundreds of rows off a single prompt.
 */
const MAX_AI_SLIDES_PER_REQUEST = 20;

/**
 * Ceiling on slide deletions per request. Deletion is irreversible (there's no
 * undo in the editor), so a misread prompt shouldn't be able to take a large
 * deck apart in one shot. `deleteSlide` separately refuses the project's last
 * remaining slide, and `wouldEmptyDeck` below stops a batch that would remove
 * every slide.
 */
const MAX_AI_SLIDE_DELETES_PER_REQUEST = 10;

/**
 * How many slides get their full element list in the prompt. Beyond this the
 * deck sends geometry and counts only — a 40-slide deck's complete element
 * dump would crowd out the response budget.
 */
const AI_FULL_DETAIL_SLIDE_LIMIT = 15;

const FALLBACK_REPLY = "Sorry, I couldn't process that request. Please try again in a moment.";

const toAiMessageDto = (message: AiMessage): TAiMessageDto => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
});

const broadcastAiMessage = (projectId: string, message: TAiMessageDto): void => {
  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("ai:messageCreated", { projectId, socketId: "", message });
};

export const listAiMessages = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const messages = await dbService.listAiMessages(projectId);

  res.status(200).json({ messages: messages.map(toAiMessageDto) });
};

/**
 * Clamps an AI-proposed element so it can't hang off its slide.
 *
 * A human dragging a shape past the edge is a deliberate, reversible choice
 * (and the canvas clips the overhang), but the AI places elements blind from
 * arithmetic and a single slip — `width` set to the full slide width at a
 * non-zero `x` is the common one — silently pushes content out of frame.
 * Shrinking first, then nudging, keeps the element whole rather than cropping.
 */
const fitWithinCanvas = (
  element: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } => {
  const width = Math.min(element.width, canvasWidth);
  const height = Math.min(element.height, canvasHeight);

  return {
    width,
    height,
    x: Math.min(Math.max(element.x, 0), canvasWidth - width),
    y: Math.min(Math.max(element.y, 0), canvasHeight - height),
  };
};

/**
 * Broadcasts the deck's current order to the room.
 *
 * Always sends the FULL order, never the subset a caller asked to move: the
 * client's `slidesReordered` reducer only rewrites the `orderIndex` of slides
 * present in the payload and leaves the rest untouched, so a partial order
 * would strand the unmentioned slides at stale indices.
 */
const broadcastDeckOrder = async (projectId: string): Promise<void> => {
  const slides = await canvasCacheService.listSlides(projectId);

  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("slide:reordered", {
      projectId,
      socketId: "",
      order: slides.map((slide, index) => ({ canvasId: slide.canvasId, orderIndex: index })),
    });
};

type TOpCounts = {
  slidesCreated: number;
  slidesDeleted: number;
  slidesDuplicated: number;
  slidesReordered: boolean;
  created: number;
  updated: number;
  deleted: number;
  /** Ops dropped because the element/slide was gone or had moved on. */
  skipped: number;
  /** Ops naming a slide/element that doesn't exist — usually a misread reference. */
  badReferences: number;
  /** Ops dropped because a cap (slides-per-request, elements-per-canvas) was hit. */
  limited: number;
  /** Delete ops refused because the project must keep at least one slide. */
  lastSlideRefusals: number;
  /** Operations the schema couldn't parse at all. */
  rejected: number;
};

type TApplyResult = TOpCounts & {
  /** Slides this request created, in creation order. */
  createdCanvasIds: string[];
  /** Slides this request deleted. */
  deletedCanvasIds: string[];
};

/**
 * Applies the AI's proposed operations through the canvas cache — the same
 * path a human edit takes — so version bookkeeping and the eventual DB flush
 * stay consistent.
 *
 * Both slide and element ids the AI invents are re-keyed to real UUIDs as
 * they're created, so a later op in the same batch referring to an id the AI
 * just made up still resolves. Element ops with no `slideId` fall back to the
 * active slide, which is what keeps single-slide requests behaving exactly as
 * they did before slides were addressable.
 *
 * Broadcasts are deliberately split: edits to slides that already existed go
 * out as granular `element:*` events (every client already has those canvases
 * hydrated), while a slide this request created is announced once, at the end,
 * as a single `slide:generated` carrying the canvas AND its elements. Emitting
 * `slide:created` plus a stream of `element:created` instead would leave every
 * client with an element-bearing canvas entity whose `canvas` is null — which
 * renders as a thumbnail skeleton that never resolves, because the client's
 * hydration backfill early-returns once an entity exists.
 */
const applyOperations = async (
  projectId: string,
  activeCanvasId: string,
  operations: TAiOperation[],
  rejected: number,
  deckSlides: TAiSlideContext[],
): Promise<TApplyResult> => {
  const elementIdMap = new Map<string, string>();
  const slideIdMap = new Map<string, string>();
  /** Canvases created by this request — their broadcasts are deferred. */
  const createdCanvasIds: string[] = [];
  const deletedCanvasIds: string[] = [];
  /** Seeded once per canvas, then tracked locally instead of re-counting per op. */
  const elementCounts = new Map<string, number>();

  const counts: TOpCounts = {
    slidesCreated: 0,
    slidesDeleted: 0,
    slidesDuplicated: 0,
    slidesReordered: false,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    badReferences: 0,
    limited: 0,
    lastSlideRefusals: 0,
    rejected,
  };

  // Keyed by both the 1-based slideNumber (as a string) and the real canvasId,
  // so a fallback lookup works regardless of which one the model echoes back.
  const bySlideNumber = new Map<string, string>();
  const knownCanvasIds = new Set<string>();

  for (const slide of deckSlides) {
    bySlideNumber.set(String(slide.slideNumber), slide.canvasId);
    knownCanvasIds.add(slide.canvasId);
  }

  /**
   * Resolves an AI-supplied slide reference to a real canvasId.
   *
   * The model is told to copy the exact canvasId string, but on prompts that
   * loop uniformly over every slide ("add X to all slides") it has been
   * observed falling back to a short label instead — "slide3", "3", or a
   * locally-invented id it never registered via `createSlide` — for a slide
   * that already existed. `slideIdMap` alone only covers ids the model itself
   * defined earlier in this batch (new slides), so on its own it turned every
   * one of those into a silent bad-reference count against a real, existing
   * deck. Falling back to a bare/mentioned slide number recovers the common
   * case instead of discarding the op.
   */
  const resolveSlideId = (slideId?: string): string => {
    if (!slideId) {
      return activeCanvasId;
    }

    if (slideIdMap.has(slideId) || knownCanvasIds.has(slideId)) {
      return slideIdMap.get(slideId) ?? slideId;
    }

    const numberMatch = slideId.match(/\d+/);

    if (numberMatch) {
      const byNumber = bySlideNumber.get(numberMatch[0]);

      if (byNumber) {
        return byNumber;
      }
    }

    return slideId;
  };

  const getElementCount = async (canvasId: string): Promise<number> => {
    const cached = elementCounts.get(canvasId);

    if (cached !== undefined) {
      return cached;
    }

    const count = await canvasCacheService.countElements(projectId, canvasId);
    elementCounts.set(canvasId, count);

    return count;
  };

  /** A slide created by this request is announced later, in one combined event. */
  const isDeferred = (canvasId: string): boolean => createdCanvasIds.includes(canvasId);

  for (const op of operations) {
    if (op.action === "createSlide") {
      if (counts.slidesCreated >= MAX_AI_SLIDES_PER_REQUEST) {
        counts.limited += 1;
        continue;
      }

      const newCanvasId = crypto.randomUUID();
      // Appends unless the model asked for a specific position. An unknown
      // `afterSlideId` also appends (`createSlide` treats `indexOf === -1` as
      // "end"), so a misread reference degrades rather than failing.
      const afterCanvasId = op.afterSlideId ? resolveSlideId(op.afterSlideId) : undefined;
      await canvasCacheService.createSlide(projectId, newCanvasId, afterCanvasId);

      slideIdMap.set(op.slideId, newCanvasId);
      createdCanvasIds.push(newCanvasId);
      elementCounts.set(newCanvasId, 0);
      counts.slidesCreated += 1;

      await applySlideProperties(projectId, newCanvasId, op, { broadcast: false });

      continue;
    }

    if (op.action === "deleteSlide") {
      if (counts.slidesDeleted >= MAX_AI_SLIDE_DELETES_PER_REQUEST) {
        counts.limited += 1;
        continue;
      }

      const canvasId = resolveSlideId(op.slideId);
      const outcome = await canvasCacheService.deleteSlide(projectId, canvasId);

      if (outcome.status === "not-found") {
        counts.badReferences += 1;
        console.error("AI deleteSlide referenced unknown slide:", op.slideId, "->", canvasId);
        continue;
      }

      if (outcome.status === "last-slide") {
        counts.lastSlideRefusals += 1;
        continue;
      }

      counts.slidesDeleted += 1;
      deletedCanvasIds.push(canvasId);
      elementCounts.delete(canvasId);

      tryGetIo()?.to(projectRoom(projectId)).emit("slide:deleted", { projectId, socketId: "", canvasId });

      // The deck order shifted; every client needs the renumbering, not just
      // the removal.
      await broadcastDeckOrder(projectId);

      continue;
    }

    if (op.action === "duplicateSlide") {
      if (counts.slidesCreated + counts.slidesDuplicated >= MAX_AI_SLIDES_PER_REQUEST) {
        counts.limited += 1;
        continue;
      }

      const canvasId = resolveSlideId(op.slideId);
      const duplicated = await canvasCacheService.duplicateSlide(projectId, canvasId);

      if (!duplicated) {
        counts.badReferences += 1;
        console.error("AI duplicateSlide referenced unknown slide:", op.slideId, "->", canvasId);
        continue;
      }

      counts.slidesDuplicated += 1;
      // Registered so a later op in this same batch can target the copy.
      slideIdMap.set(op.slideId, canvasId);
      elementCounts.set(duplicated.canvas.canvasId, duplicated.elements.length);

      // Carries the canvas AND its elements, so the copy's thumbnail renders
      // without a follow-up hydration round trip.
      tryGetIo()
        ?.to(projectRoom(projectId))
        .emit("slide:duplicated", {
          projectId,
          socketId: "",
          slide: toCanvasDto(duplicated.canvas),
          elements: duplicated.elements.map(toElementDto),
          order: duplicated.order,
        });

      continue;
    }

    if (op.action === "reorderSlides") {
      const seen = new Set<string>();
      const resolved: string[] = [];

      for (const rawId of op.order) {
        const canvasId = resolveSlideId(rawId);

        if (seen.has(canvasId) || !(await canvasCacheService.hasSlide(projectId, canvasId))) {
          counts.badReferences += 1;
          console.error("AI reorderSlides referenced unknown/duplicate slide:", rawId, "->", canvasId);
          continue;
        }

        seen.add(canvasId);
        resolved.push(canvasId);
      }

      // Slides the model left out keep their relative order, appended after the
      // ones it named — otherwise a partial list would strand them at stale
      // `orderIndex` values and the strip's sort would be ambiguous.
      const existing = await canvasCacheService.listSlides(projectId);
      const missing = existing.map((slide) => slide.canvasId).filter((canvasId) => !seen.has(canvasId));
      const finalOrder = [...resolved, ...missing];

      if (finalOrder.length === 0) {
        continue;
      }

      await canvasCacheService.reorderSlides(
        projectId,
        finalOrder.map((canvasId, index) => ({ canvasId, orderIndex: index })),
      );

      counts.slidesReordered = true;
      await broadcastDeckOrder(projectId);

      continue;
    }

    if (op.action === "updateSlide") {
      const canvasId = resolveSlideId(op.slideId);

      if (!(await canvasCacheService.hasSlide(projectId, canvasId))) {
        counts.badReferences += 1;
        console.error("AI updateSlide referenced unknown slide:", op.slideId, "->", canvasId);
        continue;
      }

      const changed = await applySlideProperties(projectId, canvasId, op, { broadcast: !isDeferred(canvasId) });

      if (changed) {
        counts.updated += 1;
      } else {
        counts.skipped += 1;
      }

      continue;
    }

    const canvasId = resolveSlideId(op.slideId);

    if (!(await canvasCacheService.hasSlide(projectId, canvasId))) {
      counts.badReferences += 1;
      console.error(`AI ${op.action} referenced unknown slide:`, op.slideId, "->", canvasId);
      continue;
    }

    if (op.action === "create") {
      if ((await getElementCount(canvasId)) >= env.MAX_ELEMENTS_PER_CANVAS) {
        counts.limited += 1;
        continue;
      }

      const elementId = crypto.randomUUID();
      elementIdMap.set(op.elementId, elementId);

      const slideCanvas = await canvasCacheService.getCanvas(projectId, canvasId);
      const bounded = slideCanvas ? fitWithinCanvas(op, slideCanvas.width, slideCanvas.height) : op;

      const element = await canvasCacheService.createElement(
        projectId,
        canvasId,
        {
          elementId,
          type: op.type,
          x: bounded.x,
          y: bounded.y,
          width: bounded.width,
          height: bounded.height,
          rotation: op.rotation,
          opacity: op.opacity,
          fill: op.fill,
          stroke: op.stroke,
          strokeWidth: op.strokeWidth,
          cornerRadius: op.cornerRadius,
          props: op.props,
        },
        // No user authored this element — AI-created.
        null,
      );

      if (!element) {
        counts.skipped += 1;
        continue;
      }

      counts.created += 1;
      elementCounts.set(canvasId, (await getElementCount(canvasId)) + 1);

      if (!isDeferred(canvasId)) {
        tryGetIo()
          ?.to(projectRoom(projectId))
          .emit("element:created", { projectId, canvasId, socketId: "", element: toElementDto(element) });
      }

      continue;
    }

    if (op.action === "update") {
      const elementId = elementIdMap.get(op.elementId) ?? op.elementId;
      const current = (await canvasCacheService.listElements(projectId, canvasId)).find(
        (element) => element.elementId === elementId,
      );

      if (!current) {
        counts.skipped += 1;
        console.error("AI update referenced unknown element:", op.elementId, "->", elementId, "on", canvasId);
        continue;
      }

      const outcome = await canvasCacheService.applyPatch(projectId, canvasId, elementId, current.version, op.patch);

      if (outcome.status !== "applied") {
        counts.skipped += 1;
        continue;
      }

      counts.updated += 1;

      if (!isDeferred(canvasId)) {
        tryGetIo()
          ?.to(projectRoom(projectId))
          .emit("element:updated", {
            projectId,
            canvasId,
            socketId: "",
            elementId,
            version: outcome.version,
            patch: op.patch,
          });
      }

      continue;
    }

    // op.action === "delete"
    const elementId = elementIdMap.get(op.elementId) ?? op.elementId;
    const removed = await canvasCacheService.deleteElements(projectId, canvasId, [elementId]);

    if (removed.length === 0) {
      counts.skipped += 1;
      console.error("AI delete referenced unknown element:", op.elementId, "->", elementId, "on", canvasId);
      continue;
    }

    counts.deleted += 1;
    elementCounts.set(canvasId, Math.max((await getElementCount(canvasId)) - removed.length, 0));

    if (!isDeferred(canvasId)) {
      tryGetIo()
        ?.to(projectRoom(projectId))
        .emit("element:deleted", { projectId, canvasId, socketId: "", elementIds: removed });
    }
  }

  // Every newly-created slide is announced here, once it is fully populated,
  // so each arrives at the client as a single hydration.
  if (createdCanvasIds.length > 0) {
    // Read fresh rather than reusing `latestOrder`: slide deletes/reorders in
    // this same batch may have renumbered the deck after that snapshot.
    const order = (await canvasCacheService.listSlides(projectId)).map((slide, index) => ({
      canvasId: slide.canvasId,
      orderIndex: index,
    }));

    for (const canvasId of createdCanvasIds) {
      const canvas = await canvasCacheService.getCanvas(projectId, canvasId);

      if (!canvas) {
        continue;
      }

      const elements = await canvasCacheService.listElements(projectId, canvasId);

      tryGetIo()
        ?.to(projectRoom(projectId))
        .emit("slide:generated", {
          projectId,
          socketId: "",
          slide: toCanvasDto(canvas),
          elements: elements.map(toElementDto),
          order,
        });
    }
  }

  return { ...counts, createdCanvasIds, deletedCanvasIds };
};

/**
 * Applies a slide's size/background if the op carries either. Returns whether
 * anything actually changed, so the caller can count a no-op op as skipped.
 */
const applySlideProperties = async (
  projectId: string,
  canvasId: string,
  op: Extract<TAiOperation, { action: "createSlide" | "updateSlide" }>,
  { broadcast }: { broadcast: boolean },
): Promise<boolean> => {
  let canvas = await canvasCacheService.getCanvas(projectId, canvasId);

  if (!canvas) {
    return false;
  }

  let changed = false;

  if (op.aspectRatioPreset) {
    const size = ASPECT_RATIO_SIZES[op.aspectRatioPreset];

    if (size) {
      canvas = await canvasCacheService.resizeCanvas(
        projectId,
        canvasId,
        size.width,
        size.height,
        op.aspectRatioPreset,
      );
      changed = true;
    }
  }

  if (op.backgroundColor) {
    canvas = await canvasCacheService.setBackgroundColor(projectId, canvasId, op.backgroundColor);
    changed = true;
  }

  if (changed && broadcast) {
    tryGetIo()
      ?.to(projectRoom(projectId))
      .emit("canvas:resized", { projectId, canvasId, socketId: "", canvas: toCanvasDto(canvas) });
  }

  return changed;
};

/**
 * Fraction of a deck a single AI request may delete. A request that asks to
 * remove most of the deck at once is far more likely to be a misread prompt
 * than a genuine intent, and deletion is irreversible here (no undo).
 */
const MAX_DECK_DELETE_RATIO = 0.5;

/**
 * Caps how much of the deck one request may delete.
 *
 * `deleteSlide` refuses only the project's *last* slide, and it checks one op
 * at a time — so a batch of deletes will happily strip a 6-slide deck down to
 * a single slide before that refusal ever fires (observed in testing: "delete
 * all the slides" removed 5 of 6). Since deletion can't be undone, a batch
 * targeting more than half the deck is trimmed here, before any of it runs, and
 * the trimmed ops are reported as limited rather than applied silently.
 */
const guardDeckDeletions = (
  operations: TAiOperation[],
  deckSize: number,
): { operations: TAiOperation[]; blocked: number } => {
  const deleteCount = operations.filter((op) => op.action === "deleteSlide").length;
  // Always allow at least one deletion, so "delete slide 3" works on a
  // two-slide deck.
  const maxDeletes = Math.max(1, Math.floor(deckSize * MAX_DECK_DELETE_RATIO));

  if (deleteCount <= maxDeletes) {
    return { operations, blocked: 0 };
  }

  let allowed = maxDeletes;

  const kept = operations.filter((op) => {
    if (op.action !== "deleteSlide") {
      return true;
    }

    if (allowed > 0) {
      allowed -= 1;
      return true;
    }

    return false;
  });

  return { operations: kept, blocked: deleteCount - maxDeletes };
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// ─── Background enforcement helpers ──────────────────────────────────────────
// The AI frequently ignores background instructions, so these helpers detect
// missing background elements and inject them programmatically before the ops
// are applied — making the background (color + shapes) unconditional.

/**
 * Blends a hex color toward white by `factor` (0 = original, 1 = white).
 * Used to derive secondary and background colors from the primary accent.
 */
const lightenColor = (hex: string, factor: number): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * factor);
  const lg = Math.round(g + (255 - g) * factor);
  const lb = Math.round(b + (255 - b) * factor);
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
};

/**
 * True when a hex color looks like a design accent: neither near-white nor
 * near-black nor greyscale. Used to identify the accent color from AI ops.
 */
const isAccentColor = (hex: string): boolean => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return brightness >= 35 && brightness <= 210 && saturation >= 20;
};

/**
 * Scans AI create ops for the most frequently used accent-like fill color.
 * Falls back to indigo if nothing usable is found.
 */
const extractAccentColor = (operations: TAiOperation[]): string => {
  const counts = new Map<string, number>();

  for (const op of operations) {
    if (op.action !== "create" || !op.fill) continue;
    if (isAccentColor(op.fill)) {
      const key = op.fill.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let best: string | null = null;
  let bestCount = 0;

  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }

  return best ?? "#4f46e5";
};

/**
 * Returns all background decorative shapes from ops targeting a specific slide.
 *
 * Background shapes are low-opacity (< 0.4) rects or ellipses that sit in a
 * corner/edge zone, plus the thin full-width top accent strip.
 *
 * When `exact` is false (default), ops with no slideId resolve to the given
 * slideId — needed for the active slide where the AI often omits the field.
 * When `exact` is true, only ops with an explicit matching slideId are included
 * — use this for new slides whose ops always carry an explicit AI-invented id.
 */
const extractBackgroundShapesForSlide = (
  operations: TAiOperation[],
  slideId: string,
  slideWidth: number,
  slideHeight: number,
  exact = false,
): Extract<TAiOperation, { action: "create" }>[] => {
  const mx = slideWidth * 0.18;
  const my = slideHeight * 0.18;

  return operations.filter((op): op is Extract<TAiOperation, { action: "create" }> => {
    if (op.action !== "create") return false;
    const opSlide = exact ? op.slideId : (op.slideId ?? slideId);
    if (opSlide !== slideId) return false;
    if (op.type !== "ellipse" && op.type !== "rect") return false;
    if ((op.opacity ?? 1) >= 0.4) return false;
    // Thin full-width strip at the very top counts as a background shape.
    const isTopStrip = op.y <= 5 && op.height <= 15 && op.width >= slideWidth * 0.8;
    const hEdge = op.x < mx || op.x + op.width > slideWidth - mx;
    const vEdge = op.y < my || op.y + op.height > slideHeight - my;
    return isTopStrip || (hEdge && vEdge);
  });
};

/**
 * Clones a set of background shapes onto a different slide, assigning fresh
 * elementIds. Used to replicate the AI's theme-designed template to slides
 * that are missing a background.
 */
const cloneBackgroundShapesToSlide = (
  shapes: Extract<TAiOperation, { action: "create" }>[],
  targetSlideId: string,
): TAiOperation[] =>
  shapes.map((shape) => ({
    ...shape,
    slideId: targetSlideId,
    elementId: `bg-${crypto.randomUUID().slice(0, 8)}`,
  }));

/**
 * One decorative shape in the 1920×1080 reference frame. `fill` names a palette
 * slot resolved at build time; coordinates are scaled to the real slide size.
 */
type TBgShapeSpec = {
  type: "ellipse" | "rect" | "star";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: "primary" | "secondary";
  opacity: number;
  rotation?: number;
};

/**
 * Fallback background arrangements, used ONLY when the AI produced no background
 * shapes of its own. Several distinct layouts exist so the safety net doesn't
 * stamp the same "corner circle + top bar" onto every deck — one is chosen
 * deterministically from the accent color, so all slides in a deck share the
 * same layout (consistent) while different themes get different looks.
 *
 * All coordinates keep shapes fully within the 1920×1080 frame (x+w ≤ 1920,
 * y+h ≤ 1080) because `fitWithinCanvas` pulls any out-of-bounds element back
 * inside, which would otherwise reposition a shape meant to sit in a corner.
 */
const BG_ARRANGEMENTS: TBgShapeSpec[][] = [
  // 0 — Corner orbit: BR anchor + TL balance + TR accent + top spine.
  [
    { type: "ellipse", x: 1480, y: 620, w: 440, h: 440, fill: "primary", opacity: 0.14 },
    { type: "ellipse", x: 0, y: 0, w: 300, h: 300, fill: "secondary", opacity: 0.22 },
    { type: "ellipse", x: 1700, y: 0, w: 220, h: 220, fill: "secondary", opacity: 0.15 },
    { type: "rect", x: 0, y: 0, w: 1920, h: 10, fill: "primary", opacity: 1 },
  ],
  // 1 — Diagonal flow: TR + opposite BL + left-edge accent, no spine.
  [
    { type: "ellipse", x: 1620, y: 0, w: 300, h: 300, fill: "primary", opacity: 0.13 },
    { type: "ellipse", x: 0, y: 660, w: 420, h: 420, fill: "secondary", opacity: 0.2 },
    { type: "ellipse", x: 0, y: 440, w: 160, h: 160, fill: "primary", opacity: 0.1 },
  ],
  // 2 — Editorial: bottom diagonal band + TL accent + left rule.
  [
    { type: "rect", x: 0, y: 900, w: 1920, h: 120, fill: "secondary", opacity: 0.16, rotation: -10 },
    { type: "ellipse", x: 0, y: 0, w: 240, h: 240, fill: "primary", opacity: 0.12 },
    { type: "rect", x: 0, y: 0, w: 14, h: 1080, fill: "primary", opacity: 1 },
  ],
  // 3 — Accent star: BR star + TL balance + CR dot + top spine.
  [
    { type: "star", x: 1500, y: 640, w: 420, h: 420, fill: "primary", opacity: 0.12 },
    { type: "ellipse", x: 0, y: 0, w: 300, h: 300, fill: "secondary", opacity: 0.2 },
    { type: "ellipse", x: 1780, y: 460, w: 140, h: 140, fill: "primary", opacity: 0.1 },
    { type: "rect", x: 0, y: 0, w: 1920, h: 10, fill: "primary", opacity: 1 },
  ],
  // 4 — Minimal: one soft TL anchor + a small BR accent, lots of space.
  [
    { type: "ellipse", x: 0, y: 0, w: 380, h: 380, fill: "secondary", opacity: 0.18 },
    { type: "ellipse", x: 1660, y: 760, w: 260, h: 260, fill: "primary", opacity: 0.12 },
  ],
];

/** Small deterministic seed from a hex color, so a theme maps to one layout. */
const colorSeed = (hex: string): number => {
  let sum = 0;
  for (const ch of hex) sum += ch.charCodeAt(0);
  return sum;
};

/**
 * Builds a fallback two-color background for a slide, choosing a layout by the
 * accent color so different themes get visibly different backgrounds while a
 * single deck stays internally consistent. Only used when the AI supplied no
 * background of its own.
 */
const buildBackgroundTemplate = (
  canvasId: string,
  slideWidth: number,
  slideHeight: number,
  primaryColor: string,
  secondaryColor: string,
): TAiOperation[] => {
  const sx = slideWidth / 1920;
  const sy = slideHeight / 1080;
  const uid = () => crypto.randomUUID().slice(0, 8);

  const arrangement =
    BG_ARRANGEMENTS[colorSeed(primaryColor) % BG_ARRANGEMENTS.length] ?? BG_ARRANGEMENTS[0]!;

  return arrangement.map((spec) => ({
    action: "create",
    slideId: canvasId,
    elementId: `bg-${uid()}`,
    type: spec.type,
    x: Math.round(spec.x * sx),
    y: Math.round(spec.y * sy),
    width: Math.round(spec.w * sx),
    height: Math.round(spec.h * sy),
    fill: spec.fill === "primary" ? primaryColor : secondaryColor,
    opacity: spec.opacity,
    ...(spec.rotation !== undefined ? { rotation: spec.rotation } : {}),
  }));
};

/**
 * The one-line "what actually happened" note under the assistant's reply.
 *
 * Failures are reported by cause rather than lumped together: a slide the model
 * couldn't find is a different problem from a concurrent edit or a cap being
 * hit, and the old shared "skipped N (changed since last view)" wording made a
 * misread slide reference look like a race condition.
 */
const summarizeOps = (counts: TOpCounts): string | null => {
  const done: string[] = [];

  if (counts.slidesCreated > 0) done.push(`created ${plural(counts.slidesCreated, "slide")}`);
  if (counts.slidesDuplicated > 0) done.push(`duplicated ${plural(counts.slidesDuplicated, "slide")}`);
  if (counts.slidesDeleted > 0) done.push(`deleted ${plural(counts.slidesDeleted, "slide")}`);
  if (counts.slidesReordered) done.push("reordered the deck");
  if (counts.created > 0) done.push(`added ${plural(counts.created, "element")}`);
  if (counts.updated > 0) done.push(`updated ${counts.updated}`);
  if (counts.deleted > 0) done.push(`removed ${plural(counts.deleted, "element")}`);

  const problems: string[] = [];

  if (counts.badReferences > 0) {
    problems.push(`couldn't find ${plural(counts.badReferences, "slide or element")} that was referenced`);
  }

  if (counts.rejected > 0) problems.push(`couldn't apply ${plural(counts.rejected, "instruction")}`);
  if (counts.lastSlideRefusals > 0) problems.push("kept the last remaining slide (a project needs at least one)");
  if (counts.limited > 0) problems.push(`skipped ${plural(counts.limited, "change")} (limit reached)`);
  if (counts.skipped > 0) problems.push(`skipped ${plural(counts.skipped, "change")} (already changed)`);

  const all = [...done, ...problems];

  if (all.length === 0) {
    return null;
  }

  return `${all.join(", ")}.`;
};

export const sendAiMessage = async (req: Request<ProjectIdParams, unknown, SendAiMessageBody>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (membership.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot use the AI assistant" });
    return;
  }

  const { canvasId, content } = req.body;

  const canvas = await canvasCacheService.getCanvas(projectId, canvasId);

  if (!canvas) {
    res.status(404).json({ error: "Slide not found" });
    return;
  }

  const userMessage = await dbService.createAiMessage({
    projectId,
    canvasId,
    role: "user",
    content,
    createdBy: requesterId,
  });
  const userMessageDto = toAiMessageDto(userMessage);
  broadcastAiMessage(projectId, userMessageDto);

  const [slides, activeElements, historyRows] = await Promise.all([
    canvasCacheService.listSlides(projectId),
    canvasCacheService.listElements(projectId, canvasId),
    dbService.listAiMessages(projectId, canvasId, { limit: AI_HISTORY_LIMIT }),
  ]);

  // Elements are sent for every slide so cross-deck requests ("make every
  // title blue", "clear slide 4") have something to target — but only up to a
  // limit, beyond which a slide contributes geometry and a count only, since a
  // very large deck's full element dump would crowd out the response budget.
  // The active slide always gets full detail regardless of its position.
  const detailedCanvasIds = new Set<string>([canvasId]);

  for (const slide of slides) {
    if (detailedCanvasIds.size >= AI_FULL_DETAIL_SLIDE_LIMIT) {
      break;
    }

    detailedCanvasIds.add(slide.canvasId);
  }

  const slideContexts: TAiSlideContext[] = await Promise.all(
    slides.map(async (slide, index) => {
      const isActive = slide.canvasId === canvasId;
      const elements = isActive
        ? activeElements
        : detailedCanvasIds.has(slide.canvasId)
          ? await canvasCacheService.listElements(projectId, slide.canvasId)
          : null;

      return {
        canvasId: slide.canvasId,
        index,
        slideNumber: index + 1,
        width: slide.width,
        height: slide.height,
        backgroundColor: slide.backgroundColor,
        elementCount: elements ? elements.length : await canvasCacheService.countElements(projectId, slide.canvasId),
        elements,
      };
    }),
  );

  let reply: string;
  let opsSummary: string | null = null;
  let createdCanvasIds: string[] = [];
  let deletedCanvasIds: string[] = [];

  try {
    const aiResponse = await openAiService.generateLayoutResponse({
      userPrompt: content,
      slides: slideContexts,
      activeCanvasId: canvasId,
      history: historyRows.map((row) => ({ role: row.role, content: row.content })),
    });

    reply = aiResponse.reply;

    // `rejected` is threaded in so the summary can own up to instructions that
    // never parsed, rather than them vanishing silently.
    const guarded = guardDeckDeletions(aiResponse.operations, slides.length);

    // ── Background enforcement ────────────────────────────────────────────────
    // The AI owns the background design: it picks the color and shapes based on
    // the presentation's theme. The backend's role is:
    //   1. Extract the AI's reference background (color + shapes) from its ops
    //   2. Clone that design identically to every slide missing a background
    //   3. Normalize the background color so every slide is identical
    //   4. Fall back to a hardcoded two-color template ONLY if AI provided nothing
    //
    // This keeps backgrounds truly theme-aware (the AI picks travel-cyan vs
    // corporate-navy vs creative-orange) while guaranteeing consistency.

    // Fallback palette — used only when AI produced no usable background shapes.
    const primaryColor = extractAccentColor(guarded.operations);
    const secondaryColor = lightenColor(primaryColor, 0.5);

    // AI-invented slide ids for every slide this request creates.
    const newAiSlideIds = guarded.operations
      .filter((op): op is Extract<TAiOperation, { action: "createSlide" }> => op.action === "createSlide")
      .map((op) => op.slideId);

    const hasActiveSlideCreates = guarded.operations.some(
      (op) => op.action === "create" && (op.slideId === undefined || op.slideId === canvasId),
    );

    // Find the AI's reference background shapes — scanned from the first new
    // slide that has them. New slides are checked with exact=true (AI always sets
    // slideId on their ops); active slide uses exact=false (slideId may be omitted).
    // A usable reference must have at least one non-white shape — the cover
    // slide's decorative shapes are white (they sit on an accent wash), and
    // cloning those onto a light content slide would render them invisible. So
    // white-only shape sets are skipped in favor of a real content template.
    const isWhiteFill = (hex?: string | null): boolean => !hex || /^#?(f{3}|f{6})$/i.test(hex);
    const isUsableReference = (shapes: Extract<TAiOperation, { action: "create" }>[]): boolean =>
      shapes.some((s) => !isWhiteFill(s.fill));

    const referenceShapes = (() => {
      let whiteOnlyFallback: Extract<TAiOperation, { action: "create" }>[] | null = null;

      for (const aiSlideId of newAiSlideIds) {
        const shapes = extractBackgroundShapesForSlide(
          guarded.operations, aiSlideId, canvas.width, canvas.height, true,
        );
        if (shapes.length === 0) continue;
        if (isUsableReference(shapes)) return shapes;
        whiteOnlyFallback ??= shapes;
      }
      if (hasActiveSlideCreates) {
        const shapes = extractBackgroundShapesForSlide(
          guarded.operations, canvasId, canvas.width, canvas.height, false,
        );
        if (shapes.length > 0 && isUsableReference(shapes)) return shapes;
      }
      // Prefer a real content template; fall back to white-only only if that's
      // all the AI produced; else null → hardcoded template is built instead.
      return whiteOnlyFallback;
    })();

    // Background color priority — the AI's decision comes FIRST. The backend
    // never overrides a colour the AI deliberately chose; it only fills in when
    // the AI made no choice at all:
    //   1. AI's explicit choice           → the AI owns this decision (theme-aware)
    //   2. Existing non-white deck color  → preserves theme when the AI didn't set one
    //   3. Tinted fallback from primary   → last resort, only if nothing else exists
    const aiChosenBgColor = guarded.operations.find(
      (op): op is Extract<TAiOperation, { action: "createSlide" | "updateSlide" }> =>
        (op.action === "createSlide" || op.action === "updateSlide") &&
        !!op.backgroundColor &&
        !/^#?(f{3}|f{6})$/i.test(op.backgroundColor),
    )?.backgroundColor;

    const existingNonWhiteBg = slides.find(
      (s) => s.backgroundColor && !/^#?(f{3}|f{6})$/i.test(s.backgroundColor),
    )?.backgroundColor;

    const deckBgColor = aiChosenBgColor ?? existingNonWhiteBg ?? lightenColor(primaryColor, 0.88);

    /** Shapes to inject for a slide missing a background. */
    const bgShapesFor = (slideId: string): TAiOperation[] =>
      referenceShapes
        ? cloneBackgroundShapesToSlide(referenceShapes, slideId)
        : buildBackgroundTemplate(slideId, canvas.width, canvas.height, primaryColor, secondaryColor);

    let finalOperations = guarded.operations;

    if (hasActiveSlideCreates) {
      // 1. Inject background shapes if the AI didn't include any for this slide.
      const activeHasShapes =
        extractBackgroundShapesForSlide(finalOperations, canvasId, canvas.width, canvas.height).length > 0;
      if (!activeHasShapes) {
        finalOperations = [...bgShapesFor(canvasId), ...finalOperations];
      }

      // 2. Normalize the background color — unconditional so every slide matches.
      finalOperations = [
        ...finalOperations,
        { action: "updateSlide", slideId: canvasId, backgroundColor: deckBgColor },
      ];

      // 3. Full-replacement model: wipe existing elements so the AI's fresh layout
      //    starts from a clean slate.
      if (activeElements.length > 0) {
        const existingElementIds = activeElements.map((el) => el.elementId);
        await canvasCacheService.deleteElements(projectId, canvasId, existingElementIds);
        tryGetIo()
          ?.to(projectRoom(projectId))
          .emit("element:deleted", { projectId, canvasId, socketId: "", elementIds: existingElementIds });
      }
    }

    // Apply the same background to every newly created slide.
    // Shapes go in immediately after the slide's createSlide op so they land
    // below content elements in z-order.
    for (const aiSlideId of newAiSlideIds) {
      const slideHasShapes =
        extractBackgroundShapesForSlide(finalOperations, aiSlideId, canvas.width, canvas.height, true).length > 0;
      if (!slideHasShapes) {
        const bgShapes = bgShapesFor(aiSlideId);
        const createIdx = finalOperations.findIndex(
          (op) => op.action === "createSlide" && op.slideId === aiSlideId,
        );
        finalOperations =
          createIdx !== -1
            ? [
                ...finalOperations.slice(0, createIdx + 1),
                ...bgShapes,
                ...finalOperations.slice(createIdx + 1),
              ]
            : [...bgShapes, ...finalOperations];
      }

      // Normalize color on every new slide — same value, no drift.
      finalOperations = [
        ...finalOperations,
        { action: "updateSlide", slideId: aiSlideId, backgroundColor: deckBgColor },
      ];
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (finalOperations.length > 0 || aiResponse.rejected > 0 || guarded.blocked > 0) {
      const result = await applyOperations(
        projectId,
        canvasId,
        finalOperations,
        aiResponse.rejected,
        slideContexts,
      );
      // Deletions the deck-wipe guard refused are surfaced as limited, so the
      // user is told the request was trimmed rather than silently narrowed.
      result.limited += guarded.blocked;
      opsSummary = summarizeOps(result);
      createdCanvasIds = result.createdCanvasIds;
      deletedCanvasIds = result.deletedCanvasIds;
    }
  } catch (error) {
    console.error("AI assistant request failed", error);
    reply = FALLBACK_REPLY;
  }

  const assistantMessage = await dbService.createAiMessage({
    projectId,
    // The request's own slide may have been one of the ones just deleted, in
    // which case the FK has nothing to point at — anchor the reply to the
    // project instead of failing the whole request on the insert.
    canvasId: deletedCanvasIds.includes(canvasId) ? null : canvasId,
    role: "assistant",
    // The model has been seen returning whitespace-only text alongside a valid
    // set of operations; an empty chat bubble reads as a broken response, so
    // fall back to the ops summary (or a generic line) instead.
    content: reply.trim() || opsSummary || "Done.",
    opsSummary,
    createdBy: null,
  });
  const assistantMessageDto = toAiMessageDto(assistantMessage);
  broadcastAiMessage(projectId, assistantMessageDto);

  res.status(201).json({
    userMessage: userMessageDto,
    assistantMessage: assistantMessageDto,
    createdCanvasIds,
    deletedCanvasIds,
  });
};
