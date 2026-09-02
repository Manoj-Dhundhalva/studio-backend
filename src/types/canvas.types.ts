/**
 * Shared canvas domain types.
 *
 * Deliberately import-free: `db/schema.ts` needs `TElementProps` for its
 * `jsonb().$type<>()` column, while `socket/socket.types.ts` needs both these
 * and the schema-derived row types. Keeping these here breaks that cycle.
 */

/** Kept as a `const` tuple so `pgEnum` and the zod schemas share one source of truth. */
export const CANVAS_ELEMENT_TYPES = [
  "rect",
  "ellipse",
  "triangle",
  "line",
  "arrow",
  "star",
  "polygon",
  "text",
  "image",
  "icon",
] as const;

export type TCanvasElementType = (typeof CANVAS_ELEMENT_TYPES)[number];

export const TEXT_ALIGNMENTS = ["left", "center", "right"] as const;

export type TTextAlignment = (typeof TEXT_ALIGNMENTS)[number];

/**
 * Type-specific element fields, stored in the `canvas_elements.props` jsonb
 * column. Every field is optional rather than this being a discriminated union:
 * `$type<>()` applies to the column irrespective of the row's `type`, so a
 * union could never actually discriminate at the Drizzle layer. The per-type
 * shape is enforced at the API/socket boundary instead (see
 * `canvas.validation.ts`), where the element's `type` is known.
 */
export type TElementProps = {
  /** `text` and `icon` (an icon is a single glyph rendered as text). */
  text?: string | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  fontStyle?: string | undefined;
  align?: TTextAlignment | undefined;
  lineHeight?: number | undefined;

  /** `image` */
  src?: string | undefined;
  naturalWidth?: number | undefined;
  naturalHeight?: number | undefined;

  /** `star` */
  numPoints?: number | undefined;
  innerRadius?: number | undefined;

  /** `polygon` */
  sides?: number | undefined;

  /** `line` and `arrow`, as a flat [x1, y1, x2, y2, ...] list, Konva's format. */
  points?: number[] | undefined;
};

/** Presets offered by the workspace size control. `custom` means "use width/height as given". */
export const ASPECT_RATIO_PRESETS = {
  SQUARE: "1:1",
  LANDSCAPE: "16:9",
  PORTRAIT: "9:16",
  A4: "a4",
  PRESENTATION: "4:3",
  CUSTOM: "custom",
} as const;

export type TAspectRatioPreset = (typeof ASPECT_RATIO_PRESETS)[keyof typeof ASPECT_RATIO_PRESETS];
