import type { User as DbUser } from "@/services/db.service.js";

// Passport declares `Express.User` as an empty interface and assigns whatever the
// verify callback passes to `done` onto `req.user`. Merge our row shape into it so
// `req.user` is typed instead of needing an `as any` at every call site.
declare global {
  namespace Express {
    // The empty body is the point: declaration merging needs an `interface`, and the
    // shape comes entirely from DbUser.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends DbUser {}
  }
}

export {};
