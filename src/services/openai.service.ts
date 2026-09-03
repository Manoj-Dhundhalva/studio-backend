import axios from "axios";
import { z } from "zod";

import { env } from "@/config/env.js";
import { handleServiceApiError } from "@/services/helpers/service-error-handler.helper.js";
import {
  ASPECT_RATIO_SIZES,
  CANVAS_ELEMENT_TYPES,
  TEXT_ALIGNMENTS,
  type TAspectRatioPreset,
} from "@/types/canvas.types.js";

import type { CanvasElement } from "@/services/db.service.js";

// A whole-deck response is a much bigger generation than a single-slide edit,
// so this is well above the single-shape case. The SDK-less axios call has no
// timeout of its own — mirrors `cloudinary.service.ts`.
const AI_REQUEST_TIMEOUT_MS = 120 * 1000;

/**
 * Generous enough for a ~10-slide deck of titles/bullets. Without an explicit
 * cap the model can stop mid-object, which surfaces only as an opaque
 * `JSON.parse` failure rather than "the deck was too long".
 */
const AI_MAX_OUTPUT_TOKENS = 16000;

const CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

/**
 * One slide's context for the prompt. `elements` is only populated for the
 * active slide — sending every slide's full element list would blow up the
 * prompt on a large deck — so the prompt tells the model it may only edit
 * elements on the slide it can actually see.
 */
export type TAiSlideContext = {
  canvasId: string;
  index: number;
  /** 1-based position, matching how the user says "slide 3". */
  slideNumber: number;
  width: number;
  height: number;
  backgroundColor: string;
  elementCount: number;
  /** `null` when the deck is too large to send every slide's elements. */
  elements: CanvasElement[] | null;
};

export type TAiRequestInput = {
  userPrompt: string;
  slides: TAiSlideContext[];
  activeCanvasId: string;
  /** Prior turns, oldest first, for conversational context. */
  history: { role: "user" | "assistant"; content: string }[];
};

// `custom` is excluded deliberately: it carries no pixel size of its own, so
// the model has nothing meaningful to resize a slide to when it picks it.
const aspectRatioPresetSchema = z.enum(
  Object.keys(ASPECT_RATIO_SIZES) as [Exclude<TAspectRatioPreset, "custom">, ...Exclude<TAspectRatioPreset, "custom">[]],
);

// Mirrors `elementPropsSchema` in `canvas.validation.ts`. The AI path calls the
// cache service directly rather than going through `elementCreateInputSchema`,
// so these bounds are the only thing standing between a hallucinated
// `fontSize: 1e9` and the jsonb column.
const aiElementPropsSchema = z.object({
  text: z.string().max(5000).optional(),
  fontFamily: z.string().max(120).optional(),
  fontSize: z.number().positive().max(1000).optional(),
  fontStyle: z.string().max(60).optional(),
  align: z.enum(TEXT_ALIGNMENTS).optional(),
  lineHeight: z.number().positive().max(10).optional(),
  src: z.string().max(2048).optional(),
  naturalWidth: z.number().nonnegative().optional(),
  naturalHeight: z.number().nonnegative().optional(),
  numPoints: z.number().int().min(3).max(60).optional(),
  innerRadius: z.number().nonnegative().optional(),
  sides: z.number().int().min(3).max(60).optional(),
  points: z.array(z.number()).max(200).optional(),
});

/** AI-invented key (e.g. "s1"/"el1"), re-keyed to a real UUID server-side. */
const aiLocalIdSchema = z.string().min(1).max(120);

const aiOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createSlide"),
    slideId: aiLocalIdSchema,
    /** Insert directly after this slide; omitted appends to the end of the deck. */
    afterSlideId: aiLocalIdSchema.optional(),
    aspectRatioPreset: aspectRatioPresetSchema.optional(),
    backgroundColor: z.string().max(64).optional(),
  }),
  z.object({
    action: z.literal("updateSlide"),
    slideId: aiLocalIdSchema,
    aspectRatioPreset: aspectRatioPresetSchema.optional(),
    backgroundColor: z.string().max(64).optional(),
  }),
  z.object({
    action: z.literal("deleteSlide"),
    slideId: aiLocalIdSchema,
  }),
  z.object({
    action: z.literal("duplicateSlide"),
    slideId: aiLocalIdSchema,
  }),
  z.object({
    action: z.literal("reorderSlides"),
    /**
     * The COMPLETE new deck order. Mirrors `reorderSlides`/`reorderElements` in
     * the cache service, where the caller sends the full order and the server
     * writes it verbatim — no move-one-slide primitive to keep in sync.
     */
    order: z.array(aiLocalIdSchema).min(1).max(1000),
  }),
  z.object({
    action: z.literal("create"),
    /** Omitted means "the active slide", preserving single-slide behaviour. */
    slideId: aiLocalIdSchema.optional(),
    // The model occasionally drops this on an op nothing else refers back to
    // (seen in practice — every other field present, `elementId` just missing).
    // Rejecting the whole batch over one unused id is wasteful, so a missing
    // id is filled in with a fresh one here; it only matters as a local key for
    // a later op in the SAME batch to reference, and one that never gets
    // referenced doesn't need a model-supplied id at all.
    elementId: aiLocalIdSchema.optional().default(() => crypto.randomUUID()),
    type: z.enum(CANVAS_ELEMENT_TYPES),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    fill: z.string().max(64).nullable().optional(),
    stroke: z.string().max(64).nullable().optional(),
    strokeWidth: z.number().nonnegative().max(500).optional(),
    cornerRadius: z.number().nonnegative().max(5000).optional(),
    props: aiElementPropsSchema.optional(),
  }),
  z.object({
    action: z.literal("update"),
    slideId: aiLocalIdSchema.optional(),
    elementId: aiLocalIdSchema,
    // No `zIndex`: `TElementPatch` has no such field and `elementPatchSchema`
    // is `.strict()`, so accepting it would be a silently-dropped instruction.
    patch: z
      .object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().nonnegative().optional(),
        height: z.number().nonnegative().optional(),
        rotation: z.number().optional(),
        opacity: z.number().min(0).max(1).optional(),
        fill: z.string().max(64).nullable().optional(),
        stroke: z.string().max(64).nullable().optional(),
        strokeWidth: z.number().nonnegative().max(500).optional(),
        cornerRadius: z.number().nonnegative().max(5000).optional(),
        props: aiElementPropsSchema.optional(),
      })
      .strict(),
  }),
  z.object({
    action: z.literal("delete"),
    slideId: aiLocalIdSchema.optional(),
    elementId: aiLocalIdSchema,
  }),
]);

export type TAiOperation = z.infer<typeof aiOperationSchema>;

/**
 * The envelope is validated separately from the operations inside it, and the
 * operations are then parsed one at a time.
 *
 * Parsing the whole array in one `z.array(aiOperationSchema)` made a single
 * malformed op (or one using an action the schema doesn't know) fail the entire
 * parse — discarding the model's `reply` and every valid operation alongside
 * it, so a 30-second generation surfaced to the user as nothing but a generic
 * "couldn't process that" message. Per-op parsing keeps everything that is
 * usable and reports the remainder honestly.
 */
const aiEnvelopeSchema = z.object({
  reply: z.string().min(1),
  operations: z.array(z.unknown()).max(600),
});

export type TAiLayoutResponse = {
  reply: string;
  operations: TAiOperation[];
  /** Operations dropped because they didn't match the schema. */
  rejected: number;
};

const presetList = Object.entries(ASPECT_RATIO_SIZES)
  .map(([preset, size]) => `"${preset}" (${size.width}x${size.height})`)
  .join(", ");

const buildSystemPrompt = (): string =>
  `You are a design assistant embedded in a Canva-like slide/presentation editor. You can create slides and place elements on them.

COORDINATE SYSTEM
Each slide has its own width/height. Origin is the top-left corner (0,0). All positions/sizes are in that slide's pixels.

ELEMENT MODEL
Element types: ${CANVAS_ELEMENT_TYPES.join(", ")}.
Every element has: type, x, y, width, height, rotation (degrees, default 0), opacity (0-1, default 1), fill (color or null), stroke (color or null), strokeWidth (default 0), cornerRadius (default 0).
Type-specific fields live in "props":
- text: text, fontFamily, fontSize, fontStyle ("normal"|"bold"|"italic"), align ("left"|"center"|"right"), lineHeight
- icon: text ONLY, set to a single emoji character that fits the content (e.g. 🌍 for environment, 📊 for analytics, 💬 for chat) — pick whichever real emoji best represents the idea (fontFamily/fontSize/fontStyle/align/lineHeight are ALL ignored for icons — do not bother setting them). It renders that literal glyph, centered, scaled to the element's box. Never use a text label like "star" as the icon's "text" — it must be the actual emoji character.
- image: src, naturalWidth, naturalHeight — you have NO access to any image library or generator, so NEVER create an "image" element or invent a "src" (a filename like "photo.png" is not a real file and will render as a broken image). For visual polish — banners, dividers, icon accents, decorative backgrounds — use shape elements ("rect", "ellipse", "star", "polygon", "line") with "fill"/"stroke" colors instead.
- star: numPoints, innerRadius
- polygon: sides
- line/arrow: no type-specific props. A "line"/"arrow" is a straight horizontal segment spanning its own bounding box — it renders across the full "width" at half the "height", exactly like every other element positioned by "x"/"y"/"width"/"height". Use "rotation" to angle it (e.g. 90 for vertical, 45 for diagonal) and a small "height" (e.g. 4-8) so it reads as a thin line rather than a thick bar. "width" and "height" are REQUIRED on every "line"/"arrow" exactly as on every other element — never omit them, and never use a "points" field (it is not rendered).

RESPONSE FORMAT
Respond with ONLY a raw JSON object (no markdown code fences) of this exact shape:
{
  "reply": "<short human-readable reply describing what you did, in plain conversational text>",
  "operations": [
    { "action": "createSlide", "slideId": "s1", "aspectRatioPreset": "16:9", "backgroundColor": "#ffffff" },
    { "action": "create", "slideId": "s1", "elementId": "el1", "type": "text", "x": 120, "y": 90, "width": 1680, "height": 100, "fill": "#1f1f1f", "props": { "text": "Slide title", "fontSize": 72, "fontStyle": "bold", "align": "left" } },
    { "action": "create", "slideId": "s1", "elementId": "el2", "type": "text", "x": 120, "y": 260, "width": 1680, "height": 300, "fill": "#333333", "props": { "text": "• First point\\n• Second point\\n• Third point", "fontSize": 34, "align": "left", "lineHeight": 1.5 } },
    { "action": "updateSlide", "slideId": "<real canvasId>", "backgroundColor": "#f5f5f5" },
    { "action": "update", "slideId": "s1", "elementId": "el1", "patch": { "x": 140 } },
    { "action": "update", "slideId": "<real canvasId>", "elementId": "<real elementId>", "patch": { "fill": "#ffffff", "props": { "text": "New heading", "fontSize": 48 } } },
    { "action": "create", "slideId": "<real canvasId>", "elementId": "el1", "type": "rect", "x": 120, "y": 700, "width": 400, "height": 6, "fill": "#4f46e5" },
    { "action": "delete", "slideId": "s1", "elementId": "el1" },
    { "action": "deleteSlide", "slideId": "<real canvasId>" },
    { "action": "duplicateSlide", "slideId": "<real canvasId>" },
    { "action": "reorderSlides", "order": ["<canvasId>", "<canvasId>", "<canvasId>"] }
  ]
}

SLIDE OPERATIONS
- "createSlide" — makes a new slide. Appends to the end by default; pass "afterSlideId" to insert it directly after a specific slide instead.
    { "action": "createSlide", "slideId": "s1", "afterSlideId": "<canvasId of slide 2>", "aspectRatioPreset": "16:9" }
- "updateSlide" — changes a slide's size ("aspectRatioPreset") and/or "backgroundColor".
- "deleteSlide" — permanently removes a slide and everything on it.
- "duplicateSlide" — copies a slide and everything on it; the copy is placed immediately after the original.
- "reorderSlides" — sets the deck order. "order" MUST list EVERY slide in the deck exactly once, in the desired final order. To move slide 5 to the front, emit the full list with that slide's canvasId first.

SLIDE CONTENT REQUIREMENTS (important)
- EVERY content slide must have a title AND real substance beneath it. That substance can be a body text element OR the text inside cards/steps/stats from a DESIGN SYSTEM composition — but a slide carrying only a title is not acceptable.
- Where you do use a body text element, it must be 3-5 concrete bullet points written for this specific topic — never placeholders like "Point 1" or "Lorem ipsum". Write the actual content the user would present. The same applies to card and step labels.
- A title-only layout is allowed ONLY for a deliberate cover slide, a section divider, or a QUOTE/STATEMENT composition.
- For a 16:9 (1920x1080) slide, this is the baseline full-width content box. It is the PLAINEST option and must never be the whole deck — use it only where a richer DESIGN SYSTEM composition genuinely does not fit, and still colour it with the theme tokens (title = ink, body = ink or inkMuted), never with hardcoded greys:
    title:  x=120, y=90,  width=1680, height=110, fontSize=72, fontStyle="bold"
    body:   x=120, y=260, width=1680, height=560, fontSize=34, lineHeight=1.5
  Note width=1680 = 1920 - 120 (left margin) - 120 (right margin). NEVER set width equal to the slide width when x > 0 — that overflows the slide. A full-bleed background band is the ONE exception: a "rect" deliberately spanning x=0..1920 is correct for TOP BAND / SIDE PANEL compositions.

DESIGN SYSTEM — aim for the look of a modern AI deck builder (Gamma/Pitch/Beautiful.ai): bold color blocking, big type, rounded cards, generous whitespace. Never plain black text on a bare white rectangle.

THEME — decide this ONCE, before writing any slide, and reuse the exact same hex values on every slide of the deck:
  accent      — the deck's signature color, chosen from the topic's mood (tech/SaaS → #4f46e5 indigo or #0ea5e9 sky; sustainability/health → #16a34a green; finance/corporate → #1e3a5f navy; creative/marketing → #db2777 pink or #ea580c orange; education → #7c3aed violet)
  accentSoft  — a very pale tint of the accent, for card fills and panel backgrounds (e.g. #eef2ff for indigo, #ecfdf5 for green)
  ink         — near-black body/heading text on light backgrounds: #111827
  inkMuted    — secondary/supporting text on light backgrounds: #6b7280
  onAccent    — text on top of the accent color: #ffffff
Never introduce a second unrelated hue mid-deck. Variety comes from LAYOUT, not from new colors.

WHAT YOU CAN AND CANNOT STYLE (the renderer ignores anything else, so don't waste operations on it):
- Available: "fill", "stroke", "strokeWidth", "cornerRadius" (ONLY on "rect" — it is ignored on every other shape), "opacity", "rotation", and for text "fontSize"/"fontStyle"/"align"/"lineHeight"/"fontFamily".
- NOT available anywhere: shadows, gradients, blur, borders on non-rect shapes with rounded corners, letter-spacing, text vertical-centering, text padding. Never try to fake a gradient by stacking many slightly-different rectangles.
- Fonts: default is Inter (a clean sans — just omit "fontFamily" to get it). For an editorial/serif feel use "Georgia, serif". Use ONE font family for the whole deck.
- Text elements auto-grow downward from "y"; there is no vertical centering. To visually center a line inside a band or card of height H starting at bandY, set the text's y ≈ bandY + (H - fontSize * 1.2) / 2.
- "icon" elements ignore "fill" — an icon renders in its own emoji colors, so never expect a tinted icon.

COMPOSITION — before writing a deck, ASSIGN A COMPOSITION TO EVERY SLIDE, then build each slide to its assigned composition. Hard requirements for a deck of 4+ slides:
  · The plain baseline title+body layout may be used on AT MOST half the slides — never on two slides in a row.
  · The cover and the closing slide must both be FULL-BLEED COLOR.
  · At least one middle slide must use ROUNDED CARDS, BIG NUMBER, SIDE PANEL or ASYMMETRIC SPLIT.
  · No two consecutive slides may share the same composition.
A deck where every middle slide is title + bullet list has FAILED these requirements, no matter how good the writing is.
Budget at least 4-6 elements on a typical content slide (a card slide is 13: title + 3 cards x 4). Do not economise on operations — a 6-slide deck should be roughly 30-40 elements in total. Two elements on a content slide means you defaulted to the plain layout and ignored the requirements above.
The compositions, with coordinates for 16:9 (1920x1080):
- FULL-BLEED COLOR: set the slide's own "backgroundColor" to the accent and put "onAccent" text on it. Highest impact — use it for the cover, section breaks and the closing slide.
- SIDE PANEL: a full-height "rect" at x=0,y=0,width=640,height=1080 filled with accent (or accentSoft), with the title inside it and the body text to its right starting at x=760. Strong, magazine-like.
- TOP BAND: a "rect" at x=0,y=0,width=1920,height=280 filled with accent, the title in "onAccent" inside it (y≈100), body below on the light background starting at y=380.
- ROUNDED CARDS: exactly 3 (or 4) "rect"s with "cornerRadius": 24 and fill accentSoft, in a row spanning x=120..1800, each holding FOUR elements — an "icon", a bold label, and a short one-line description (the rect is the fourth). Every card must have all of them; a card that is just a rect and a label is incomplete. For 3 cards: width=533 each at x=120, 693, 1266 (gap 40), y=300, height=400. Emit ONLY the individual card rects — never an extra full-width background rect behind them, and never a card with no text in it. This is the signature "AI deck" look — prefer it over a plain bullet list whenever the content is a set of parallel items.
- BIG NUMBER: for stats/steps, an oversized numeral text (fontSize 140-200, fontStyle "bold", fill accent) with a small label beneath it — repeated 2-4 times across the slide.
- ASYMMETRIC SPLIT: title + short lead paragraph on the left half (x=120, width=760), a single large accent shape (rect with cornerRadius 24, or ellipse) filling the right half (x=1000, width=800, y=200, height=680) as a visual anchor.
- QUOTE/STATEMENT: one short sentence at fontSize 64-80 centered with generous margins on accentSoft, plus a short thin accent "rect" (width≈120, height=8) above it as a rule.

TYPE SCALE — use these sizes so hierarchy reads from the back of a room:
  cover title 110-140 bold · section-break title 90-110 bold · slide title 64-76 bold · card/step label 30-36 bold · body & bullets 30-36 · caption/footnote 22-26 · big-number stat 140-200 bold.
Body copy is never smaller than 28. Keep any one text element under ~60 words; if it needs more, split it across cards or a second slide.

CONTRAST — always pair background and text explicitly: light background (#ffffff / #f8fafc / accentSoft) → "ink" text with "inkMuted" for support; accent or dark background → "onAccent" text. Never dark-on-dark or light-on-light, and always set "fill" on every text element.

WHITESPACE — keep a 120px margin on all four sides (content spans x=120..1800). Leave at least 40px between any two elements. An uncrowded slide with 4-6 well-placed elements always beats a busy one; never fill space just because it is empty.

PRESENTATION STRUCTURE — when asked to build a full deck/presentation for a project or topic (not a single-slide edit)
Tell a narrative, don't just list facts. Use as many of these roles as the requested slide count allows, in this order, merging or dropping roles to fit a short deck and adding more CONTENT slides to fill a long one — never pad with filler, and never force all of these into a 3-4 slide deck:
1. COVER — project/topic name, a short tagline, one-line description.
2. PROBLEM — the situation/challenge this addresses and why it matters.
3. SOLUTION — the core idea and how it answers slide 2; make the problem->solution relationship obvious (e.g. two side-by-side boxes connected by an arrow).
4. KEY FEATURES — DO NOT write this as a bullet list. Use the ROUNDED CARDS composition: 3-4 cards side by side, each a "rect" with "cornerRadius": 24 filled accentSoft, holding an icon + a bold label + a short line. For N cards across width=1680 starting at x=120: cardWidth = (1680 - (N-1)*40) / N, card i's x = 120 + i*(cardWidth+40), all at y=300 with height=400. Inside EACH card, every child is inset by 40 from the card's x AND must use width = cardWidth-80 (NOT the card's full width — a child at x = cardX+40 with the card's own width would spill 40px past its right edge): an "icon" (70x70, at x = cardX + cardWidth/2 - 35, y = cardY+50), a bold label (fontSize 32, at cardY+160), and a short 1-line explanation (fontSize 26, fill inkMuted, at cardY+240) — 4 elements per card. Center the text with "align": "center".
5. HOW IT WORKS — DO NOT write this as a single text line or a bullet list, even one using "→" arrows — that is NOT an acceptable flow diagram. Build REAL separate box and arrow elements, one "create" op per box and per connector. Worked example for a 3-step flow on a 16:9 (1920x1080) slide, to be adapted to the real step count and labels (copy this exact shape and pattern, just changing text/count):
    { "action": "create", "elementId": "step1box", "type": "rect", "x": 120, "y": 500, "width": 480, "height": 160, "fill": "#eef2ff", "cornerRadius": 24 }
    { "action": "create", "elementId": "step1text", "type": "text", "x": 120, "y": 550, "width": 480, "height": 60, "fill": "#1f1f1f", "props": { "text": "1. Download the app", "fontSize": 26, "fontStyle": "bold", "align": "center" } }
    { "action": "create", "elementId": "arrow1", "type": "arrow", "x": 600, "y": 570, "width": 120, "height": 8, "fill": "#4f46e5", "stroke": "#4f46e5" }
    { "action": "create", "elementId": "step2box", "type": "rect", "x": 720, "y": 500, "width": 480, "height": 160, "fill": "#eef2ff", "cornerRadius": 24 }
    { "action": "create", "elementId": "step2text", "type": "text", "x": 720, "y": 550, "width": 480, "height": 60, "fill": "#1f1f1f", "props": { "text": "2. Log daily activity", "fontSize": 26, "fontStyle": "bold", "align": "center" } }
    { "action": "create", "elementId": "arrow2", "type": "arrow", "x": 1200, "y": 570, "width": 120, "height": 8, "fill": "#4f46e5", "stroke": "#4f46e5" }
    { "action": "create", "elementId": "step3box", "type": "rect", "x": 1320, "y": 500, "width": 480, "height": 160, "fill": "#eef2ff", "cornerRadius": 24 }
    { "action": "create", "elementId": "step3text", "type": "text", "x": 1320, "y": 550, "width": 480, "height": 60, "fill": "#1f1f1f", "props": { "text": "3. See your impact", "fontSize": 26, "fontStyle": "bold", "align": "center" } }
  For N steps, divide the same way: boxWidth = (1680 - (N-1)*120) / N, each box's x = 120 + i*(boxWidth+120), the arrow between box i and i+1 filling the 120px gap between them.
6. ARCHITECTURE / TECH STACK — group technologies/components under short headings (e.g. "Frontend", "Backend", "Database"), each as a heading text element plus a bullet-list text element beneath it. If a request specifically calls for an architecture/data-flow diagram, build it the same box+arrow way as step 5 instead of describing it in a text line.
7. IMPACT / BENEFITS / FUTURE SCOPE — short, concrete bullets under clear sub-headings; a metric or number can be its own large bold text element next to its label for emphasis.
8. CONCLUSION / CLOSING — 3-4 key takeaways or a short closing statement, calmer than the cover, plus contact/thank-you if it's a pitch/demo context.
There is NO diagram/chart/illustration element and NO access to real screenshots or generated images (see the image rule above) — every "diagram" in this deck is built the same way: text in boxes, connected by arrows/lines, colored with the deck's one accent. Never claim in "reply" that you added a screenshot, photo, or generated image — describe what you actually built (shapes, icons, text).
Never invent statistics, technologies, results, or specifics the user never provided — write a generic-but-real placeholder line instead (e.g. "Add your team's key metric here") rather than fabricating a number or fact.

SLIDE TARGETING
- To make a NEW slide, emit "createSlide" with a short "slideId" you invent (e.g. "s1", "s2"), then emit that slide's element ops with the SAME "slideId" so they land on it.
- To target an EXISTING slide, use its real "canvasId" — copy the exact string from the deck context you were given.
- The user refers to slides by POSITION ("slide 3", "the last slide", "the first two"). Map that to the matching "slideNumber" in the deck context and use THAT slide's "canvasId". NEVER put a bare number like "3" in a "slideId" — it will not match anything.
- Omit "slideId" entirely on an element op to target the currently-active slide (the default).
- Aspect ratio presets available: ${presetList}. Pick "16:9" for presentations/pitch decks unless told otherwise.
- When a request applies to EVERY slide ("add X to all slides", "restyle the whole deck"), go through the deck context slide by slide and copy each one's exact "canvasId" for its ops — never invent a shared label like "slide1".."slideN" for slides that already exist, and never reuse one slide's canvasId for another.
- To restyle an EXISTING element ("make every title blue"), copy its exact "elementId" from the deck context — do not guess or invent one. If a slide's elements were not listed in full (deck too large), you may only ADD new elements to it, not "update"/"delete" ones you can't see.
- To ADD a brand-new element to an EXISTING slide ("add a divider to slide 2", "add some visual polish to every slide"), use "create" with that slide's real "canvasId" as "slideId" — the SAME "create" op used for a new slide's content, just pointed at an existing "canvasId" instead of a fresh one. NEVER use "update" to add something that isn't already there — "update"'s "patch" only edits fields of ONE existing element named by "elementId"; it has no way to add a new element, and any op that tries (e.g. nesting an "elements" array/list inside "patch") will be rejected outright.

RULES
- Only include operations actually needed. If the user just asks a question, return an empty operations array.
- Deleting is allowed when the user asks for it — say in your "reply" which slides you removed. Only delete what was actually asked for, never every slide in the deck, and never delete anything on a vague request; ask for clarification in "reply" instead.
- If the user asks for N slides, emit exactly N "createSlide" ops, each followed by its own content. Do not put multiple slides' worth of content on one slide.
- "fill" on a text element IS THE TEXT COLOUR. Always set it explicitly (e.g. "#1f1f1f" on a light background, "#ffffff" on a dark one). If you omit it the text renders in an unreadable light grey.
- Size text boxes to their content: height must be at least lineCount * fontSize * lineHeight. Titles ~56-80px, body/bullets ~28-36px.
- There is no list element. A bullet list is ONE text element whose "text" joins lines with "\\n" and uses a literal "•" prefix per line.
- Paint order within a slide follows the order of your operations — emit background shapes before the text that sits on top of them.
- Keep every element fully inside its slide's bounds: x >= margin AND x + width <= slideWidth - margin, same for y/height. Use a margin of ~6% of the slide width.
- Before placing, moving, or resizing ANY element, check its bounding box (x, y, width, height) against every OTHER element already on that slide (from the deck context, plus any you've already added earlier in this same response) and against the box you're about to write. Two elements overlap when they intersect on both axes: (aX < bX + bWidth) AND (aX + aWidth > bX) AND same for y/height. Choose coordinates that avoid overlap with anything meant to stay visible (e.g. don't drop a new shape on top of existing text) — stack deliberately only when one element is clearly meant to sit behind another (e.g. a background band placed and ordered before the text on top of it). When asked to "move" or "rearrange" a slide, work out each element's new box the same way so the result has no unintended overlaps.
- For "update"/"delete", "elementId" must be a real id you were given, or one you invented earlier in this same operations array.
- Every "create" op MUST include an "elementId" (a short string you invent, e.g. "el1") — never omit it, even for an element nothing else refers back to.
- "update"'s "patch" ONLY accepts these top-level keys: x, y, width, height, rotation, opacity, fill, stroke, strokeWidth, cornerRadius, props. It is REJECTED ENTIRELY (the whole operation is dropped) if it contains anything else.
    - To change text content, font size, font style, alignment, or line height, nest them under "patch.props" — e.g. "patch": { "props": { "text": "New text", "fontSize": 40 } }. NEVER put "text"/"fontSize"/etc. directly on "patch" — they belong under "patch.props" only.
    - "backgroundColor" is a SLIDE property, not an element one — to change a slide's background, use "updateSlide", never "update".`;

const buildUserPrompt = (input: TAiRequestInput): string => {
  const deck = input.slides.map((slide) => ({
    canvasId: slide.canvasId,
    slideNumber: slide.slideNumber,
    width: slide.width,
    height: slide.height,
    backgroundColor: slide.backgroundColor,
    isActiveSlide: slide.canvasId === input.activeCanvasId,
    elementCount: slide.elementCount,
    elements: slide.elements
      ? slide.elements.map((element) => ({
          elementId: element.elementId,
          type: element.type,
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
          rotation: element.rotation,
          opacity: element.opacity,
          fill: element.fill,
          stroke: element.stroke,
          strokeWidth: element.strokeWidth,
          cornerRadius: element.cornerRadius,
          props: element.props,
        }))
      : "not listed (deck too large) — you may add elements to this slide, but you cannot edit or delete its existing ones",
  }));

  return `Current deck (${input.slides.length} slide${input.slides.length === 1 ? "" : "s"}):\n${JSON.stringify(
    deck,
  )}\n\nRequest: ${input.userPrompt}`;
};

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
      { role: "system", content: buildSystemPrompt() },
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: buildUserPrompt(input) },
    ];

    try {
      const response = await axios.post(
        CHAT_COMPLETIONS_URL,
        {
          model: env.OPENAI_MODEL,
          messages,
          response_format: { type: "json_object" },
          max_tokens: AI_MAX_OUTPUT_TOKENS,
        },
        {
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: AI_REQUEST_TIMEOUT_MS,
        },
      );

      const finishReason: unknown = response.data?.choices?.[0]?.finish_reason;
      const content: unknown = response.data?.choices?.[0]?.message?.content;

      if (typeof content !== "string") {
        throw new Error("OpenAI response had no message content");
      }

      // A truncated response is invalid JSON, which would otherwise surface as
      // an unhelpful `JSON.parse` SyntaxError.
      if (finishReason === "length") {
        throw new Error("OpenAI response was truncated — the requested deck is too large for one request");
      }

      const parsed: unknown = JSON.parse(content);

      const envelope = aiEnvelopeSchema.safeParse(parsed);

      // Only a malformed envelope is fatal — without a `reply` there is nothing
      // to show the user at all.
      if (!envelope.success) {
        console.error("OpenAI response did not match expected shape. Raw content:", content);
        throw envelope.error;
      }

      const operations: TAiOperation[] = [];
      let rejected = 0;

      for (const raw of envelope.data.operations) {
        const op = aiOperationSchema.safeParse(raw);

        if (op.success) {
          operations.push(op.data);
          continue;
        }

        rejected += 1;
        console.error("Discarding malformed AI operation:", JSON.stringify(raw), op.error.issues);
      }

      return { reply: envelope.data.reply, operations, rejected };
    } catch (error) {
      handleServiceApiError("OpenAI", error);
    }
  }
}

export const openAiService = OpenAiService.getInstance();
