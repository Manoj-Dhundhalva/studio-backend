import { z } from "zod";

import { ASPECT_RATIO_PRESETS, CANVAS_ELEMENT_TYPES, TEXT_ALIGNMENTS } from "@/types/canvas.types.js";

/**
 * One source of validation for both transports: the socket handlers and the
 * REST canvas endpoints parse the same schemas, so a payload that is rejected
 * over HTTP cannot sneak in over a socket.
 */

const CANVAS_MIN_DIMENSION = 64;
const CANVAS_MAX_DIMENSION = 8000;

/** Caps on the jsonb blob — the only place a props size bomb can be stopped. */
const MAX_TEXT_LENGTH = 5000;
const MAX_POINTS = 200;

const colorSchema = z.string().trim().min(1).max(64);

const finiteNumber = z.number().finite();

export const elementPropsSchema = z
  .object({
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    fontFamily: z.string().trim().max(120).optional(),
    fontSize: finiteNumber.positive().max(1000).optional(),
    fontStyle: z.string().trim().max(60).optional(),
    align: z.enum(TEXT_ALIGNMENTS).optional(),
    lineHeight: finiteNumber.positive().max(10).optional(),

    src: z.url().max(2048).optional(),
    naturalWidth: finiteNumber.nonnegative().optional(),
    naturalHeight: finiteNumber.nonnegative().optional(),

    numPoints: z.number().int().min(3).max(60).optional(),
    innerRadius: finiteNumber.nonnegative().optional(),

    sides: z.number().int().min(3).max(60).optional(),

    points: z.array(finiteNumber).max(MAX_POINTS).optional(),
  })
  // No unknown keys: `props` is persisted verbatim into jsonb, so anything
  // accepted here is stored forever.
  .strict();

export const elementCreateInputSchema = z.object({
  elementId: z.uuid(),
  type: z.enum(CANVAS_ELEMENT_TYPES),
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.nonnegative(),
  height: finiteNumber.nonnegative(),
  rotation: finiteNumber.optional(),
  opacity: finiteNumber.min(0).max(1).optional(),
  fill: colorSchema.nullable().optional(),
  stroke: colorSchema.nullable().optional(),
  strokeWidth: finiteNumber.nonnegative().max(500).optional(),
  cornerRadius: finiteNumber.nonnegative().max(5000).optional(),
  props: elementPropsSchema.optional(),
});

export const elementPatchSchema = z
  .object({
    x: finiteNumber.optional(),
    y: finiteNumber.optional(),
    width: finiteNumber.nonnegative().optional(),
    height: finiteNumber.nonnegative().optional(),
    rotation: finiteNumber.optional(),
    opacity: finiteNumber.min(0).max(1).optional(),
    fill: colorSchema.nullable().optional(),
    stroke: colorSchema.nullable().optional(),
    strokeWidth: finiteNumber.nonnegative().max(500).optional(),
    cornerRadius: finiteNumber.nonnegative().max(5000).optional(),
    props: elementPropsSchema.optional(),
  })
  .strict();

// ------------------------------------------------------------ socket payloads

const projectScoped = { projectId: z.uuid() };

export const joinPayloadSchema = z.object(projectScoped);

export const leavePayloadSchema = z.object(projectScoped);

export const cursorMovePayloadSchema = z.object({
  ...projectScoped,
  x: finiteNumber,
  y: finiteNumber,
});

export const selectionChangePayloadSchema = z.object({
  ...projectScoped,
  elementIds: z.array(z.uuid()).max(500),
});

export const elementCreatePayloadSchema = z.object({
  ...projectScoped,
  element: elementCreateInputSchema,
});

export const elementUpdatePayloadSchema = z.object({
  ...projectScoped,
  elementId: z.uuid(),
  baseVersion: z.number().int().nonnegative(),
  patch: elementPatchSchema,
});

export const elementDeletePayloadSchema = z.object({
  ...projectScoped,
  elementIds: z.array(z.uuid()).min(1).max(500),
});

export const elementReorderPayloadSchema = z.object({
  ...projectScoped,
  order: z
    .array(
      z.object({
        elementId: z.uuid(),
        zIndex: z.number().int(),
      }),
    )
    .min(1)
    .max(1000),
});

export const canvasResizePayloadSchema = z.object({
  ...projectScoped,
  width: z.number().int().min(CANVAS_MIN_DIMENSION).max(CANVAS_MAX_DIMENSION),
  height: z.number().int().min(CANVAS_MIN_DIMENSION).max(CANVAS_MAX_DIMENSION),
  aspectRatioPreset: z.enum(Object.values(ASPECT_RATIO_PRESETS)),
});

// -------------------------------------------------------------- REST payloads

// `projectId` params reuse `project.validation.ts`'s `projectIdParamsSchema` —
// the canvas routes are registered on the project router, so there is one
// schema for that param, not two that can drift.

export const updateCanvasSchema = z
  .object({
    width: z.number().int().min(CANVAS_MIN_DIMENSION).max(CANVAS_MAX_DIMENSION).optional(),
    height: z.number().int().min(CANVAS_MIN_DIMENSION).max(CANVAS_MAX_DIMENSION).optional(),
    aspectRatioPreset: z.enum(Object.values(ASPECT_RATIO_PRESETS)).optional(),
    backgroundColor: colorSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateCanvasBody = z.infer<typeof updateCanvasSchema>;
