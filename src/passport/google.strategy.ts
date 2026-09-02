import passport from "passport";
import { Strategy } from "passport-google-oauth20";

import env from "@/config/env.js";
import { authService } from "@/services/auth.service.js";

const googleStrategyOptions = {
  clientID: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  // Must be absolute: a relative path is resolved against the request origin only,
  // which drops the router mount prefix. Keep in sync with @/modules/auth/auth.routes.ts
  // and with the redirect URI registered in the Google Cloud console.
  callbackURL: `${env.SERVER_URL}/api/auth/google/callback`,
};

passport.use(
  new Strategy(googleStrategyOptions, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const user = await authService.findOrCreateUserFromGoogleProfile(profile);
      done(null, user);
    } catch (error) {
      done(error as Error);
    }
  }),
);
