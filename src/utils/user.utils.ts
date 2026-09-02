export class UserUtils {
  private static instance: UserUtils;

  private constructor() {}

  static getInstance(): UserUtils {
    if (!UserUtils.instance) {
      UserUtils.instance = new UserUtils();
    }
    return UserUtils.instance;
  }

  generateUsername(email: string): string {
    return (email.split("@")[0] || "user").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  }
}
