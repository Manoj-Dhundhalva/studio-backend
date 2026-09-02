import { eq } from "drizzle-orm";
import { db } from "@/db/connection.js";
import { users } from "@/db/schema.js";

export type NewUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

export class DbService {
  private static instance: DbService;

  private constructor() {}

  public static getInstance(): DbService {
    if (!DbService.instance) {
      DbService.instance = new DbService();
    }

    return DbService.instance;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return user ?? null;
  }

  async findUserById(userId: string): Promise<User | null> {
    const [user] = await db.select().from(users).where(eq(users.userId, userId)).limit(1);
    return user ?? null;
  }

  async updateUsername(userId: string, username: string): Promise<User | null> {
    const [user] = await db
      .update(users)
      .set({ username })
      .where(eq(users.userId, userId))
      .returning();
    return user ?? null;
  }

  /**
   * Creates the user, or returns the existing row when the email is already taken.
   *
   * `onConflictDoNothing` would return zero rows for a returning user, so the
   * conflict path performs a no-op touch to guarantee `returning()` yields a row.
   * Profile fields are deliberately left untouched so a user-edited username or
   * avatar is not clobbered on every login.
   */
  async upsertUser(user: NewUser): Promise<User> {
    const [upsertedUser] = await db
      .insert(users)
      .values(user)
      .onConflictDoUpdate({ target: users.email, set: { updatedAt: new Date() } })
      .returning();

    if (!upsertedUser) {
      throw new Error(`Failed to upsert user with email ${user.email}`);
    }

    return upsertedUser;
  }
}

export const dbService = DbService.getInstance();
