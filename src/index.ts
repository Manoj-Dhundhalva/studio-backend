import http from "node:http";

import app from "@/server.js";
import { env } from "@/config/env.js";
import { registerShutdownHooks } from "@/bootstrap/shutdown.js";
import { initSocketServer } from "@/socket/index.js";

app.get("/", (_, res) => res.send("Hello, World!"));

// Socket.IO needs the raw `http.Server`, which `app.listen()` would create and
// discard. `server.ts` stays a pure app factory; only the listening moves here.
const httpServer = http.createServer(app);

initSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
  console.log(`Environment: ${env.APP_STAGE}`);
});

registerShutdownHooks(httpServer);
