import passport from "passport";

export const google = passport.authenticate("google", { scope: ["email", "profile"] });

export const googleCallback = passport.authenticate("google", { session: false });
