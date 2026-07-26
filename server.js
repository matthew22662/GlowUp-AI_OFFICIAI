"use strict";

require("dotenv").config();

const { loadConfig } = require("./config");
const { createApplication } = require("./app");

let runtime;
let server;

async function start() {
  const config = loadConfig();
  runtime = await createApplication(config);
  server = runtime.app.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({
      level: "info",
      event: "server_ready",
      app: config.appName,
      version: "5.0.1",
      port: config.port,
      databaseMode: runtime.databaseMode,
      aiEnabled: runtime.aiEnabled,
      routes: ["/", "/admin", "/cabinet", "/onboarding", "/health"]
    }));
  });
}

async function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", event: "shutdown", signal }));
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  if (!server) {
    await runtime?.close();
    process.exit(0);
  }
  server.close(async () => {
    await runtime?.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  console.error(JSON.stringify({
    level: "fatal",
    event: "startup_failed",
    code: error?.code,
    message: error?.message,
    stack: process.env.NODE_ENV === "development" ? error?.stack : undefined
  }));
  process.exit(1);
});
