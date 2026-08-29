import express from "express";
import morgan from "morgan";
import cors from "cors";

import router from "@/routes/index.js";
import { errorHandler, limiter } from "@/middlewares/index.js";
import { isProdEnv } from "@/config/env.js";

const app = express();

app.use(limiter);
app.use(morgan(isProdEnv() ? "combined" : "dev"));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use(errorHandler);

export default app;
