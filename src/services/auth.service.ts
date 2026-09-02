import type { Profile } from "passport-google-oauth20";

import { dbService, type User } from "@/services/db.service.js";
import { utils } from "@/utils/index.js";

export class AuthService {
  private static instance: AuthService;

  private constructor() {}

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }

    return AuthService.instance;
  }

  /** Maps a verified Google profile onto our user row, creating it on first login. */
  async findOrCreateUserFromGoogleProfile(profile: Profile): Promise<User> {
    const email = profile.emails?.[0]?.value ?? null;

    if (!email) {
      throw new Error("Google account does not have a public email");
    }

    const givenName = profile.name?.givenName ?? null;
    const familyName = profile.name?.familyName ?? null;

    const username =
      [givenName, familyName].filter(Boolean).join("_") || utils.user.generateUsername(email);

    return dbService.upsertUser({
      email,
      username,
      avatarUrl: profile.photos?.[0]?.value ?? null,
    });
  }
}

export const authService = AuthService.getInstance();
