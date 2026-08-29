class Utils {
  private static instance: Utils;

  private constructor() {}

  public static getInstance(): Utils {
    if (!Utils.instance) {
      Utils.instance = new Utils();
    }
    return Utils.instance;
  }

  stringToNumber(text: unknown): number | undefined {
    if (typeof text !== "string") return undefined;
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const num = Number(trimmed);
    return Number.isNaN(num) ? undefined : num;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const utils = Utils.getInstance();
