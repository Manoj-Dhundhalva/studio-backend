import z from "zod";
import { WebScraperService } from "@/services/web-scraper.service.js";
import { DbService } from "@/services/db.service.js";
import { ContestIdSchema } from "@/schema/contest.schema.js";
import { utils } from "@/utils/index.js";
import { getProblemUrl, parseProblemFromHtml, parseSolutionFromHtml } from "./problem.helpers.js";

export const ParsedProblemSchema = z.object({
  title: z.string(),
  timeLimitValue: z.number().positive(),
  timeLimitUnit: z.string(),
  memoryLimitValue: z.number().positive(),
  memoryLimitUnit: z.string(),
  problemStatement: z.string(),
  inputSpecification: z.string(),
  outputSpecification: z.string(),
  inputTestCase: z.string(),
  outputTestCase: z.string(),
  rating: z.number().int().min(800).optional(),
  tags: z.array(z.string()),
  editorialUrl: z.url(),
  note: z.string(),
});

export type TContestEditorial = {
  contestId: number;
  problemIndexes: string[];
  editorialUrl: string;
};

export type TContestEditorialPayload = {
  editorials: TContestEditorial[];
};

export const ProblemIdentifierSchema = z
  .object({
    contestId: ContestIdSchema,
    problemIndex: z.string().min(1),
  })
  .strict();

export const ProblemPayloadSchema = z
  .object({
    problems: z.array(ProblemIdentifierSchema).min(1),
  })
  .strict();

export const ProblemResponseSchema = z
  .object({
    problems: z.array(ParsedProblemSchema),
  })
  .strict();

export type TProblemIdentifier = z.infer<typeof ProblemIdentifierSchema>;
export type TProblemPayload = z.infer<typeof ProblemPayloadSchema>;
export type TParsedProblem = z.infer<typeof ParsedProblemSchema>;
export type TProblemResponse = z.infer<typeof ProblemResponseSchema>;

export class ProblemService {
  private static instance: ProblemService;

  private constructor(
    private readonly webScraper: WebScraperService,
    private readonly dbService: DbService,
  ) {}

  public static getInstance(): ProblemService {
    if (!ProblemService.instance) {
      ProblemService.instance = new ProblemService(WebScraperService.getInstance(), DbService.getInstance());
    }
    return ProblemService.instance;
  }

  private async updateSolution(payload: TContestEditorialPayload): Promise<void> {
    if (payload.editorials.length === 0) return;

    const scrapeTasks = payload.editorials.map((editorial) => ({ url: editorial.editorialUrl }));

    const { htmlPages } = await this.webScraper.scrape({ scrapeTasks });

    const results = htmlPages.map((htmlPage) => parseSolutionFromHtml(htmlPage));

    await Promise.all(
      payload.editorials.flatMap((editorial, i) => {
        const contestSolutions = results[i] ?? [];
        const contestId = editorial.contestId;

        return editorial.problemIndexes.map((problemIndex, j) => {
          const problemSolutions = contestSolutions[j] ?? [];
          return this.dbService.updateSolution({ contestId, problemIndex }, problemSolutions);
        });
      }),
    );
  }

  private async updateProblem(payload: TProblemPayload): Promise<void> {
    if (payload.problems.length === 0) return;

    const scrapeTasks = payload.problems.map((problem) => ({ url: getProblemUrl(problem) }));

    const { htmlPages } = await this.webScraper.scrape({ scrapeTasks });

    const problems = htmlPages.map((htmlPage) => parseProblemFromHtml(htmlPage));

    await Promise.all(
      problems.map((problem, i) => {
        if (!payload.problems[i] || !problem.problemStatement) return Promise.resolve();
        return this.dbService.updateProblem(payload.problems[i], problem);
      }),
    );
  }

  async scrapeProblemsInBatches(batchSize = 10): Promise<void> {
    const problems = await this.dbService.getUnscrapedProblems();

    console.log(`Found ${problems.length} unscraped problems`);

    for (let i = 0; i < problems.length; i += batchSize) {
      const batch = problems.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(problems.length / batchSize);

      console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} problems)`);

      await this.updateProblem({ problems: batch });

      console.log(`Completed batch ${batchNumber}/${totalBatches}`);

      await utils.sleep(3000);
    }

    console.log("Problem scraping completed");
  }

  async scrapeSolutionsInBatches(batchSize = 5): Promise<void> {
    const editorials = await this.dbService.getUnscrapedEditorials();

    console.log(`Found ${editorials.length} unscraped editorials`);

    for (let i = 0; i < editorials.length; i += batchSize) {
      const batch = editorials.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(editorials.length / batchSize);

      console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} problems)`);

      await this.updateSolution({ editorials: batch });

      console.log(`Completed batch ${batchNumber}/${totalBatches}`);

      await utils.sleep(3000);
    }

    console.log("Editorials scraping completed");
  }
}

export const problemService = ProblemService.getInstance();
