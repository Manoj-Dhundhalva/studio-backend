import env from "@/config/env.js";
import rateLimit from "express-rate-limit";

export const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW,
  max: 100,
  message: {
    status: "error",
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
