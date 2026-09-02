/**
 * Presence palette. Chosen to stay legible as a cursor and an avatar ring on
 * both the light and dark app themes.
 */
const PRESENCE_COLORS = [
  "#f5222d",
  "#fa8c16",
  "#fadb14",
  "#52c41a",
  "#13c2c2",
  "#1677ff",
  "#722ed1",
  "#eb2f96",
] as const;

export class ColorUtils {
  private static instance: ColorUtils;

  private constructor() {}

  static getInstance(): ColorUtils {
    if (!ColorUtils.instance) {
      ColorUtils.instance = new ColorUtils();
    }
    return ColorUtils.instance;
  }

  /**
   * Derives a stable colour from a user id, so the same person keeps the same
   * cursor colour across reconnects and across every other member's screen
   * without the server having to track assignments.
   */
  presenceColorFor(userId: string): string {
    let hash = 0;

    for (let index = 0; index < userId.length; index += 1) {
      // Classic djb2-style mix; `| 0` keeps it in int32 so it can't drift into
      // float territory on long ids.
      hash = (hash * 33 + userId.charCodeAt(index)) | 0;
    }

    const bucket = Math.abs(hash) % PRESENCE_COLORS.length;

    // `noUncheckedIndexedAccess`: the modulo guarantees a hit, but the compiler
    // can't know that.
    return PRESENCE_COLORS[bucket] ?? "#1677ff";
  }
}
