import "dotenv/config";
import { startServer } from "./server.js";

// The Claude Agent SDK spawns a child process and writes to its stdin.
// If the child exits before the write completes, Node emits an EPIPE error
// on the socket. This is harmless but crashes the process if unhandled.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    console.error("[warn] EPIPE on child process pipe (ignored)");
    return;
  }
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});

startServer();
