export class TimeUtils {
  private static instance: TimeUtils;

  private constructor() {}

  static getInstance(): TimeUtils {
    if (!TimeUtils.instance) {
      TimeUtils.instance = new TimeUtils();
    }
    return TimeUtils.instance;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
