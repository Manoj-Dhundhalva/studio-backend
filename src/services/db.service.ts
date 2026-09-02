import { and, desc, eq, exists } from "drizzle-orm";
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
}

export const dbService = DbService.getInstance();
