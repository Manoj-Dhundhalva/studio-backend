import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { CANVAS_ELEMENT_TYPES, type TAspectRatioPreset, type TElementProps } from "@/types/canvas.types.js";

export const users = pgTable("users", {
  userId: uuid("user_id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  username: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const projects = pgTable("projects", {
  projectId: uuid("project_id").primaryKey().defaultRandom(),
  projectName: text("project_name").notNull().default("Untitled"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const projectMemberRoleEnum = pgEnum("project_member_role", ["admin", "editor", "viewer"]);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    role: projectMemberRoleEnum("role").notNull().default("viewer"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.userId],
    }),
    // The PK is (project_id, user_id), so it doesn't serve "find this user's
    // projects" lookups (e.g. GET /projects) — that needs user_id leading.
    index("project_members_user_id_idx").on(table.userId),
  ],
);

/**
 * One slide/page of a project — its dimensions and background.
 *
 * A separate table rather than columns on `projects` for two reasons: it keeps
 * canvas geometry out of the project-listing queries, and a project can hold
 * more than one of these (multi-page/slide designs) — `orderIndex` is the
 * slide's position within its project.
 */
export const canvases = pgTable(
  "canvases",
  {
    canvasId: uuid("canvas_id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    width: integer("width").notNull().default(1080),
    height: integer("height").notNull().default(1080),
    // Typed rather than bare `text` so the preset union is enforced everywhere the
    // row is read, without needing a pgEnum migration to add a preset later.
    aspectRatioPreset: text("aspect_ratio_preset").$type<TAspectRatioPreset>(),
    backgroundColor: text("background_color").notNull().default("#ffffff"),
    // Bumped on every resize so a reconnecting client can tell its cached canvas
    // is stale, mirroring the per-element `version` below.
    version: integer("version").notNull().default(0),
    // Position among a project's slides. Reordering rewrites every sibling's
    // value with sequential integers (mirrors `canvasElements.zIndex`) rather
    // than a fractional key — slide counts are small and reorders are
    // click-driven, not a high-frequency path worth optimizing for.
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Serves "list this project's slides in order" — the hot read once a
    // project holds more than one slide.
    index("canvases_project_id_order_index_idx").on(table.projectId, table.orderIndex),
  ],
);

export const canvasElementTypeEnum = pgEnum("canvas_element_type", CANVAS_ELEMENT_TYPES);

/**
 * One shape/text/image/icon on a canvas.
 *
 * Hybrid storage: the transform and style fields are universal to every element
 * type and are patched on every drag, so they get real numeric columns. The
 * type-specific fields are sparse and would leave a wide, mostly-NULL table, so
 * they live in the `props` jsonb blob instead.
 */
export const canvasElements = pgTable(
  "canvas_elements",
  {
    elementId: uuid("element_id").primaryKey().defaultRandom(),
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.canvasId, { onDelete: "cascade" }),
    type: canvasElementTypeEnum("type").notNull(),

    x: doublePrecision("x").notNull().default(0),
    y: doublePrecision("y").notNull().default(0),
    width: doublePrecision("width").notNull().default(100),
    height: doublePrecision("height").notNull().default(100),
    rotation: doublePrecision("rotation").notNull().default(0),
    opacity: doublePrecision("opacity").notNull().default(1),

    fill: text("fill"),
    stroke: text("stroke"),
    strokeWidth: doublePrecision("stroke_width").notNull().default(0),
    cornerRadius: doublePrecision("corner_radius").notNull().default(0),

    zIndex: integer("z_index").notNull().default(0),

    props: jsonb("props").$type<TElementProps>().notNull().default({}),

    // Last-write-wins tiebreak. A client sends the version it based its patch
    // on; a lower value than stored means it lost the race and gets resynced.
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.userId, { onDelete: "set null" }),

    // Soft delete: lets the cache flusher express deletes as one bulk UPDATE in
    // the same transaction as the upsert, and leaves room for undo later.
    // Every read filters on `isNull(deletedAt)`.
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Serves the only hot read: every live element of a canvas, in paint order.
    index("canvas_elements_canvas_id_z_index_idx").on(table.canvasId, table.zIndex),
  ],
);
