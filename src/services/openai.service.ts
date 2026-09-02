import axios from "axios";
import { z } from "zod";

import { env } from "@/config/env.js";
import { handleServiceApiError } from "@/services/helpers/service-error-handler.helper.js";
import { CANVAS_ELEMENT_TYPES, TEXT_ALIGNMENTS } from "@/types/canvas.types.js";

import type { CanvasElement } from "@/services/db.service.js";

// Chat completions are far faster than a file upload, but the SDK-less axios
// call still has no timeout of its own — mirrors `cloudinary.service.ts`.
const AI_REQUEST_TIMEOUT_MS = 60 * 1000;

const CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export type TAiRequestInput = {
  userPrompt: string;
  canvas: { width: number; height: number; backgroundColor: string };
  elements: CanvasElement[];
  /** Prior turns, oldest first, for conversational context. */
  history: { role: "user" | "assistant"; content: string }[];
};

const aiOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    elementId: z.string().min(1).max(120),
    type: z.enum(CANVAS_ELEMENT_TYPES),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number().optional(),
    opacity: z.number().optional(),
    fill: z.string().nullable().optional(),
    stroke: z.string().nullable().optional(),
    strokeWidth: z.number().optional(),
    cornerRadius: z.number().optional(),
    props: z
      .object({
        text: z.string().optional(),
        fontFamily: z.string().optional(),
        fontSize: z.number().optional(),
        fontStyle: z.string().optional(),
        align: z.enum(TEXT_ALIGNMENTS).optional(),
        lineHeight: z.number().optional(),
        src: z.string().optional(),
        naturalWidth: z.number().optional(),
        naturalHeight: z.number().optional(),
        numPoints: z.number().optional(),
        innerRadius: z.number().optional(),
        sides: z.number().optional(),
        points: z.array(z.number()).optional(),
      })
      .optional(),
  }),
  z.object({
    action: z.literal("update"),
    elementId: z.string().min(1).max(120),
    patch: z
      .object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        rotation: z.number().optional(),
        opacity: z.number().optional(),
        fill: z.string().nullable().optional(),
        stroke: z.string().nullable().optional(),
        strokeWidth: z.number().optional(),
        cornerRadius: z.number().optional(),
        zIndex: z.number().optional(),
        props: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  }),
  z.object({
    action: z.literal("delete"),
    elementId: z.string().min(1).max(120),
  }),
]);

export type TAiOperation = z.infer<typeof aiOperationSchema>;

const aiLayoutResponseSchema = z.object({
  reply: z.string().min(1),
  operations: z.array(aiOperationSchema).max(200),
});

export type TAiLayoutResponse = z.infer<typeof aiLayoutResponseSchema>;

const buildSystemPrompt = (canvas: TAiRequestInput["canvas"]): string =>
  `You are a design assistant embedded in a Canva-like slide editor. You help the user design one slide (canvas) by proposing element changes.

Canvas: width=${canvas.width}, height=${canvas.height}, origin is the top-left corner (0,0), backgroundColor=${canvas.backgroundColor}. All positions/sizes are in canvas pixels.

Element types: ${CANVAS_ELEMENT_TYPES.join(", ")}.
Every element has: type, x, y, width, height, rotation (degrees, default 0), opacity (0-1, default 1), fill (color or null), stroke (color or null), strokeWidth (default 0), cornerRadius (default 0), zIndex (paint order, higher on top).
Type-specific fields live in "props":
- text/icon: text, fontFamily, fontSize, fontStyle, align ("left"|"center"|"right"), lineHeight
- image: src, naturalWidth, naturalHeight
- star: numPoints, innerRadius
- polygon: sides
- line/arrow: points, a flat [x1,y1,x2,y2,...] list

You will be given the current elements on the slide as JSON (each with a real "elementId"). Respond with ONLY a JSON object of this exact shape:
{
  "reply": "<short human-readable reply describing what you did, in plain conversational text>",
  "operations": [
    { "action": "create", "elementId": "<short id you invent, e.g. 'el1'>", "type": "...", "x": 0, "y": 0, "width": 100, "height": 100, "fill": "#...", "props": {...} },
    { "action": "update", "elementId": "<existing real elementId, or an id you invented earlier in this same operations array>", "patch": { "x": 10 } },
    { "action": "delete", "elementId": "<existing real elementId>" }
  ]
}

Rules:
- Only include "operations" that are actually needed to satisfy the request. If the user only asks a question, return an empty operations array.
- Keep every element fully within the canvas bounds unless the user explicitly asks otherwise.
- For "update"/"delete", elementId MUST be one of the real ids given to you, or an id you just invented earlier in this same response for a "create" op.
- Do not wrap the JSON in markdown code fences. Return raw JSON only.`;

export class OpenAiService {
  private static instance: OpenAiService;

  private constructor() {}

  public static getInstance(): OpenAiService {
    if (!OpenAiService.instance) {
      OpenAiService.instance = new OpenAiService();
    }

    return OpenAiService.instance;
  }

  private ensureConfigured(): void {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
  }

  async generateLayoutResponse(input: TAiRequestInput): Promise<TAiLayoutResponse> {
    this.ensureConfigured();

    const messages = [
      { role: "system", content: buildSystemPrompt(input.canvas) },
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      {
        role: "user",
        content: `Current elements on this slide:\n${JSON.stringify(
          input.elements.map(({ elementId, type, x, y, width, height, rotation, opacity, fill, stroke, strokeWidth, cornerRadius, zIndex, props }) => ({
            elementId,
            type,
            x,
            y,
            width,
            height,
            rotation,
            opacity,
            fill,
            stroke,
            strokeWidth,
            cornerRadius,
            zIndex,
            props,
          })),
        )}\n\nRequest: ${input.userPrompt}`,
      },
    ];

    try {
      const response = await axios.post(
        CHAT_COMPLETIONS_URL,
        {
          model: env.OPENAI_MODEL,
          messages,
          response_format: { type: "json_object" },
        },
        {
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: AI_REQUEST_TIMEOUT_MS,
        },
      );

      const content: unknown = response.data?.choices?.[0]?.message?.content;

      if (typeof content !== "string") {
        throw new Error("OpenAI response had no message content");
      }

      const parsed: unknown = JSON.parse(content);

      const result = aiLayoutResponseSchema.safeParse(parsed);

      if (!result.success) {
        console.error("OpenAI response did not match expected shape. Raw content:", content);
        throw result.error;
      }

      return result.data;
    } catch (error) {
      handleServiceApiError("OpenAI", error);
    }
  }
}

export const openAiService = OpenAiService.getInstance();
