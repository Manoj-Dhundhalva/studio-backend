import { pgTable, text, integer, timestamp, primaryKey, real, boolean } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const contests = pgTable("contests", {
  contestId: integer("contest_id").primaryKey(),
  contestName: text("contest_name").default(""),
  type: text("type").default(""),
  startTime: integer("start_time").notNull(),
  duration: integer("duration").notNull(),
  editorialUrl: text("editorial_url").default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const problems = pgTable(
  "problems",
  {
    contestId: integer("contest_id")
      .notNull()
      .references(() => contests.contestId),
    problemIndex: text("problem_index").notNull(),
    title: text("title").default(""),
    rating: integer("rating"),

    timeLimitValue: real("time_limit_value"),
    timeLimitUnit: text("time_limit_unit").default(""),

    memoryLimitValue: integer("memory_limit_value"),
    memoryLimitUnit: text("memory_limit_unit").default(""),

    problemStatement: text("problem_statement").default(""),

    inputSpecification: text("input_specification").default(""),
    outputSpecification: text("output_specification").default(""),

    note: text("note").default(""),

    inputTestCase: text("input_test_case").default(""),
    outputTestCase: text("output_test_case").default(""),

    tags: text("tags").array().notNull().default([]),

    isScraped: boolean("is_scraped").notNull().default(false),

    solutions: text("solutions").array().notNull().default([]),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.problemIndex, table.contestId] })],
);

// Relations
export const contestsRelations = relations(contests, ({ many }) => ({
  problems: many(problems),
}));

export const problemsRelations = relations(problems, ({ one }) => ({
  contest: one(contests, {
    fields: [problems.contestId],
    references: [contests.contestId],
  }),
}));
