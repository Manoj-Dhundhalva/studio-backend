import axios from "axios";
import { ZodError } from "zod";

export function handleServiceApiError(service: string, error: unknown): never {
  if (axios.isAxiosError(error)) {
    throw new Error(`${service} API error: ${JSON.stringify(error)}`, { cause: error });
  }

  if (error instanceof ZodError) {
    throw new Error(
      `${service} API returned invalid response format: ${error.issues.map((issue) => issue.message).join(", ")}`,
      { cause: error },
    );
  }

  if (error instanceof Error) {
    throw new Error(`${service} API error: ${error.message}`, { cause: error });
  }

  throw new Error(`${service} API error: Unknown error`, { cause: error });
}
