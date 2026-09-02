import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db/connection.js";
import { projectMembers, projects, users } from "@/db/schema.js";

export type NewUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;

export type UserProjectSummary = {
  projectId: string;
  projectName: string;
  accessibility: ProjectMember["role"];
  updatedAt: Date;
};

// Hard cap on an unpaginated list endpoint so one user's membership rows can't
// balloon a single response. Revisit with real pagination if this is ever hit.
const MAX_USER_PROJECTS = 200;

const MAX_USER_SEARCH_RESULTS = 20;

/** Escapes ILIKE wildcards so a query containing `%` or `_` is matched literally. */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

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
    const [user] = await db.update(users).set({ username }).where(eq(users.userId, userId)).returning();
    return user ?? null;
  }

  /** Case-insensitive substring search over username and email, best username matches first. */
  async searchUsers(query: string): Promise<Pick<User, "userId" | "avatarUrl" | "username" | "email">[]> {
    const pattern = `%${escapeLikePattern(query)}%`;

    return await db
      .select({ userId: users.userId, avatarUrl: users.avatarUrl, username: users.username, email: users.email })
      .from(users)
      .where(or(ilike(users.username, pattern), ilike(users.email, pattern)))
      .orderBy(users.username)
      .limit(MAX_USER_SEARCH_RESULTS);
  }

  async findUsersByIds(userIds: string[]): Promise<User[]> {
    if (userIds.length === 0) {
      return [];
    }

    return await db.select().from(users).where(inArray(users.userId, userIds));
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

  /** Creates a new project and makes the given user its admin, in a single transaction. */
  async createProject(userId: string, projectName: string): Promise<{ project: Project; member: ProjectMember }> {
    return await db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values({ projectName }).returning();

      if (!project) {
        throw new Error("Failed to create project");
      }

      const [member] = await tx
        .insert(projectMembers)
        .values({ projectId: project.projectId, userId, role: "admin" })
        .returning();

      if (!member) {
        throw new Error("Failed to add project admin");
      }

      return { project, member };
    });
  }

  /** Lists every project the given user is a member of, most recently updated first. */
  async getUserProjects(userId: string): Promise<UserProjectSummary[]> {
    return await db
      .select({
        projectId: projects.projectId,
        projectName: projects.projectName,
        accessibility: projectMembers.role,
        updatedAt: projects.updatedAt,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.projectId))
      .where(eq(projectMembers.userId, userId))
      .orderBy(desc(projects.updatedAt))
      .limit(MAX_USER_PROJECTS);
  }

  /** Fetches a project along with the given user's membership in it, or null if either doesn't exist. */
  async getProjectForUser(
    projectId: string,
    userId: string,
  ): Promise<{ project: Project; member: ProjectMember } | null> {
    const [row] = await db
      .select({ project: projects, member: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.projectId))
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);

    return row ?? null;
  }

  /**
   * Renames a project, but only if `userId` is one of its admins — the admin check
   * runs as part of the same UPDATE (via the EXISTS subquery) instead of a separate
   * read-then-write, so a role change racing this call can't create a window where
   * a since-demoted member's request still goes through. Returns null if the project
   * doesn't exist or `userId` isn't an admin of it; the caller can fall back to
   * `getProjectForUser` to tell those two cases apart for the error response.
   */
  async updateProjectName(projectId: string, userId: string, projectName: string): Promise<Project | null> {
    const [project] = await db
      .update(projects)
      .set({ projectName })
      .where(
        and(
          eq(projects.projectId, projectId),
          exists(
            db
              .select()
              .from(projectMembers)
              .where(
                and(
                  eq(projectMembers.projectId, projectId),
                  eq(projectMembers.userId, userId),
                  eq(projectMembers.role, "admin"),
                ),
              ),
          ),
        ),
      )
      .returning();

    return project ?? null;
  }

  /**
   * Adds (or, for a userId already on the project, re-invites with the given role)
   * the given members. Caller is responsible for the admin check beforehand.
   */
  async addProjectMembers(
    projectId: string,
    members: { userId: string; accessibility: ProjectMember["role"] }[],
  ): Promise<ProjectMember[]> {
    return await db
      .insert(projectMembers)
      .values(members.map(({ userId, accessibility }) => ({ projectId, userId, role: accessibility })))
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: sql`excluded.role`, updatedAt: new Date() },
      })
      .returning();
  }

  /** Removes the given users from the project. Caller is responsible for the admin check beforehand. */
  async removeProjectMembers(projectId: string, userIds: string[]): Promise<string[]> {
    const removed = await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, userIds)))
      .returning({ userId: projectMembers.userId });

    return removed.map((row) => row.userId);
  }

  /**
   * Updates a batch of members' accessibility (role) atomically — either every update
   * in the batch applies, or none do. Refuses — returning `"last-admin"` — if applying
   * the whole batch would leave the project with zero admins (accounting for admins the
   * same batch promotes, not just the ones it demotes). Returns null if any userId in
   * the batch isn't a member of the project. Every touched row (the targets, plus every
   * current admin, since a demotion elsewhere in the batch affects the count) is locked
   * with `FOR UPDATE` for the transaction's duration, so two concurrent batch updates
   * can't each read a stale admin count and both proceed into leaving zero admins.
   * Caller is responsible for the requester's admin check beforehand.
   */
  async updateProjectMembersRoles(
    projectId: string,
    members: { userId: string; accessibility: ProjectMember["role"] }[],
  ): Promise<ProjectMember[] | null | "last-admin"> {
    return await db.transaction(async (tx) => {
      const targetUserIds = members.map(({ userId }) => userId);

      const targetRows = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, targetUserIds)))
        .for("update");

      if (targetRows.length !== members.length) {
        return null;
      }

      const adminRows = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "admin")))
        .for("update");

      const resultingAdminIds = new Set(adminRows.map((row) => row.userId));

      for (const { userId, accessibility } of members) {
        if (accessibility === "admin") {
          resultingAdminIds.add(userId);
        } else {
          resultingAdminIds.delete(userId);
        }
      }

      if (resultingAdminIds.size === 0) {
        return "last-admin";
      }

      const updated: ProjectMember[] = [];

      for (const { userId, accessibility } of members) {
        const [member] = await tx
          .update(projectMembers)
          .set({ role: accessibility })
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
          .returning();

        if (member) {
          updated.push(member);
        }
      }

      return updated;
    });
  }

  /**
   * Lists a project's members with their profile info, paginated and sorted by
   * username. Runs the page query and the total count concurrently since neither
   * depends on the other. Caller is responsible for verifying access beforehand.
   */
  async getProjectMembers(
    projectId: string,
    { limit, offset }: { limit: number; offset: number },
  ): Promise<{
    members: (Pick<User, "userId" | "avatarUrl" | "username" | "email"> & {
      accessibility: ProjectMember["role"];
    })[];
    total: number;
  }> {
    const [members, [totalRow]] = await Promise.all([
      db
        .select({
          userId: users.userId,
          avatarUrl: users.avatarUrl,
          username: users.username,
          email: users.email,
          accessibility: projectMembers.role,
        })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.userId))
        .where(eq(projectMembers.projectId, projectId))
        .orderBy(asc(users.username))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId)),
    ]);

    return { members, total: totalRow?.count ?? 0 };
  }
}

export const dbService = DbService.getInstance();
