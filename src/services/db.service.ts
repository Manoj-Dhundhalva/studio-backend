import { db } from "@/db/connection.js";
import { contests, problems } from "@/db/schema.js";
import { and, arrayOverlaps, asc, desc, eq, gte, isNotNull, isNull, like, lte, or, SQL, sql } from "drizzle-orm";
import { CodeforcesService } from "./codeforces.service.js";
import type { TProblemFilterBody } from "@/modules/problem/problem.schema.js";
import type { TContestEditorial, TParsedProblem, TProblemIdentifier } from "@/modules/problem/problem.service.js";
import env from "@/config/env.js";

export class DbService {
  private static instance: DbService;

  private constructor(private readonly codeforces: CodeforcesService) {}

  public static getInstance(): DbService {
    if (!DbService.instance) {
      DbService.instance = new DbService(CodeforcesService.getInstance());
    }

    return DbService.instance;
  }

  async insertContestsWithConflictIgnore(): Promise<void> {
    try {
      const { result } = await this.codeforces.getContests();

      await db
        .insert(contests)
        .values(
          result.map((contest) => ({
            contestId: contest.id,
            contestName: contest.name,
            type: contest.type,
            startTime: contest.startTimeSeconds,
            duration: contest.durationSeconds,
          })),
        )
        .onConflictDoNothing({
          target: contests.contestId,
        });
    } catch (error) {
      throw new Error(`DB insertContestsWithConflictIgnore failed: ${String(error)}`, { cause: error });
    }
  }

  async insertProblemsWithConflictIgnore(): Promise<void> {
    try {
      const { result } = await this.codeforces.getProblems();

      // Insert problems (ignore duplicates)
      await db
        .insert(problems)
        .values(
          result.problems.map((p) => ({
            contestId: p.contestId,
            problemIndex: p.index,
            title: p.name,
            rating: p.rating,
            tags: p.tags,
          })),
        )
        .onConflictDoNothing({
          target: [problems.contestId, problems.problemIndex],
        });
    } catch (error) {
      throw new Error(`DB insertProblemsWithConflictIgnore failed: ${String(error)}`, { cause: error });
    }
  }

  async getProblem(payload: TProblemIdentifier) {
    try {
      const result = await db
        .select({
          contestId: contests.contestId,
          contestName: contests.contestName,
          startTime: contests.startTime,
          type: contests.type,

          problemIndex: problems.problemIndex,
          title: problems.title,
          rating: problems.rating,
          tags: problems.tags,

          timeLimitValue: problems.timeLimitValue,
          timeLimitUnit: problems.timeLimitUnit,

          memoryLimitValue: problems.memoryLimitValue,
          memoryLimitUnit: problems.memoryLimitUnit,

          problemStatement: problems.problemStatement,

          inputSpecification: problems.inputSpecification,
          outputSpecification: problems.outputSpecification,

          inputTestCase: problems.inputTestCase,
          outputTestCase: problems.outputTestCase,

          solutions: problems.solutions,

          note: problems.note,

          editorialUrl: contests.editorialUrl,
        })
        .from(problems)
        .innerJoin(contests, eq(problems.contestId, contests.contestId))
        .where(and(eq(problems.contestId, payload.contestId), eq(problems.problemIndex, payload.problemIndex)));
      return result[0];
    } catch (error) {
      throw new Error(`DB getProblem failed: ${String(error)}`, { cause: error });
    }
  }

  async getContestProblems(contestId: number) {
    try {
      const result = await db
        .select({
          contestId: contests.contestId,
          contestName: contests.contestName,
          startTime: contests.startTime,
          type: contests.type,

          problemIndex: problems.problemIndex,
          title: problems.title,
          rating: problems.rating,
          tags: problems.tags,

          timeLimitValue: problems.timeLimitValue,
          timeLimitUnit: problems.timeLimitUnit,

          memoryLimitValue: problems.memoryLimitValue,
          memoryLimitUnit: problems.memoryLimitUnit,

          problemStatement: problems.problemStatement,

          inputSpecification: problems.inputSpecification,
          outputSpecification: problems.outputSpecification,

          inputTestCase: problems.inputTestCase,
          outputTestCase: problems.outputTestCase,

          solutions: problems.solutions,

          note: problems.note,

          editorialUrl: contests.editorialUrl,
        })
        .from(problems)
        .innerJoin(contests, eq(problems.contestId, contests.contestId))
        .where(eq(problems.contestId, contestId));
      return result[0];
    } catch (error) {
      throw new Error(`DB getProblem failed: ${String(error)}`, { cause: error });
    }
  }

  async getProblemsByFilter(payload: TProblemFilterBody) {
    try {
      const { tags, ratings, startTime, sort, offset, limit } = payload;

      const conditions: SQL[] = [
        isNotNull(problems.problemStatement),
        sql`trim(${problems.problemStatement}) <> ''`,
        isNotNull(problems.rating),
      ];

      if (tags?.length > 0) {
        conditions.push(arrayOverlaps(problems.tags, tags));
      }

      if (ratings?.length === 2) {
        const [minRating, maxRating] = ratings;
        conditions.push(gte(problems.rating, minRating));
        conditions.push(lte(problems.rating, maxRating));
      }

      if (startTime?.length === 2) {
        const [from, to] = startTime;
        conditions.push(gte(contests.startTime, from));
        conditions.push(lte(contests.startTime, to));
      }

      let orderBy = desc(contests.startTime);

      if (sort.field === "rating") {
        orderBy = sort.order === "asc" ? asc(problems.rating) : desc(problems.rating);
      } else if (sort.field === "startTime") {
        orderBy = sort.order === "asc" ? asc(contests.startTime) : desc(contests.startTime);
      }

      const result = await db
        .select({
          contestId: contests.contestId,
          contestName: contests.contestName,
          startTime: contests.startTime,
          type: contests.type,

          problemIndex: problems.problemIndex,
          title: problems.title,
          rating: problems.rating,
          tags: problems.tags,

          timeLimitValue: problems.timeLimitValue,
          timeLimitUnit: problems.timeLimitUnit,

          memoryLimitValue: problems.memoryLimitValue,
          memoryLimitUnit: problems.memoryLimitUnit,

          problemStatement: problems.problemStatement,

          inputSpecification: problems.inputSpecification,
          outputSpecification: problems.outputSpecification,

          inputTestCase: problems.inputTestCase,
          outputTestCase: problems.outputTestCase,

          solutions: problems.solutions,

          note: problems.note,

          editorialUrl: contests.editorialUrl,
        })
        .from(problems)
        .innerJoin(contests, eq(problems.contestId, contests.contestId))
        .where(and(...conditions))
        .orderBy(orderBy)
        .offset(offset)
        .limit(limit);

      return result;
    } catch (error) {
      throw new Error(`DB getProblemsByFilter failed: ${String(error)}`, { cause: error });
    }
  }

  async updateProblem(payload: TProblemIdentifier, problem: TParsedProblem) {
    try {
      await db
        .update(problems)
        .set({
          timeLimitValue: problem.timeLimitValue,
          timeLimitUnit: problem.timeLimitUnit,

          memoryLimitValue: problem.memoryLimitValue,
          memoryLimitUnit: problem.memoryLimitUnit,

          problemStatement: problem.problemStatement,

          inputSpecification: problem.inputSpecification,
          outputSpecification: problem.outputSpecification,

          note: problem.note,

          inputTestCase: problem.inputTestCase,
          outputTestCase: problem.outputTestCase,
        })
        .where(and(eq(problems.contestId, payload.contestId), eq(problems.problemIndex, payload.problemIndex)));

      if (problem.editorialUrl) {
        await db
          .update(contests)
          .set({ editorialUrl: problem.editorialUrl })
          .where(eq(contests.contestId, payload.contestId));
      }
    } catch (error) {
      throw new Error(`DB updateProblem failed: ${String(error)}`, { cause: error });
    }
  }

  async updateSolution(payload: TProblemIdentifier, solutions: string[]): Promise<void> {
    try {
      await db
        .update(problems)
        .set({ solutions })
        .where(and(eq(problems.contestId, payload.contestId), eq(problems.problemIndex, payload.problemIndex)));
    } catch (error) {
      throw new Error(`DB updateSolution failed: ${String(error)}`, { cause: error });
    }
  }

  async getUnscrapedEditorials(): Promise<TContestEditorial[]> {
    try {
      return await db
        .select({
          contestId: contests.contestId,
          problemIndexes: sql<string[]>`array_agg(${problems.problemIndex} order by ${problems.problemIndex})`,
          editorialUrl: sql<string>`${contests.editorialUrl}`,
        })
        .from(contests)
        .innerJoin(problems, eq(contests.contestId, problems.contestId))
        .where(
          and(
            isNotNull(contests.editorialUrl),
            like(contests.editorialUrl, `${env.CODEFORCES_BASE_URL}/%`),
            sql`coalesce(cardinality(${problems.solutions}), 0) = 0`,
          ),
        )
        .groupBy(contests.contestId, contests.editorialUrl)
        .orderBy(desc(contests.contestId));
    } catch (error) {
      throw new Error(`DB getUnscrapedEditorials failed: ${String(error)}`, { cause: error });
    }
  }

  async getUnscrapedProblems(): Promise<TProblemIdentifier[]> {
    try {
      const results = await db
        .select({
          contestId: problems.contestId,
          problemIndex: problems.problemIndex,
        })
        .from(problems)
        .where(or(isNull(problems.problemStatement), sql`trim(${problems.problemStatement}) <> ''`));
      return results;
    } catch (error) {
      throw new Error(`DB getUnscrapedProblems failed: ${String(error)}`, { cause: error });
    }
  }
}

export const dbService = DbService.getInstance();
