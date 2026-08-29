import app from "@/server.js";
import { env } from "@/config/env.js";

app.get("/", (_, res) => res.send("Hello, World!"));

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
  console.log(`Environment: ${env.APP_STAGE}`);
});
