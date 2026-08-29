import axios, { type AxiosInstance } from "axios";
import z from "zod";
import env from "@/config/env.js";
import { handleServiceApiError } from "./helpers/index.js";

type TScrapeTask = {
  url: string;
  timeout?: number;
};

type TScrapePayload = {
  scrapeTasks: TScrapeTask[];
};

export const ScrapeResponseSchema = z.object({
  htmlPages: z.array(z.string()),
});

export type TScrapeResponse = z.infer<typeof ScrapeResponseSchema>;

export class WebScraperService {
  private static instance: WebScraperService;

  private client: AxiosInstance;

  private readonly SCRAPE_ENDPOINT = "/api/scraper" as const;

  private constructor() {
    this.client = axios.create({
      baseURL: env.WEB_SCRAPER_API_URL,
      timeout: 3 * 60 * 1000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  public static getInstance(): WebScraperService {
    if (!WebScraperService.instance) {
      WebScraperService.instance = new WebScraperService();
    }

    return WebScraperService.instance;
  }

  async scrape(payload: TScrapePayload): Promise<TScrapeResponse> {
    try {
      const res = await this.client.post(this.SCRAPE_ENDPOINT, payload);
      const parsed = ScrapeResponseSchema.parse(res.data);
      return parsed;
    } catch (error) {
      handleServiceApiError("WebScraper", error);
    }
  }
}

export const webScraper = WebScraperService.getInstance();
