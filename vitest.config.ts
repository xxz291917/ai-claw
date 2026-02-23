import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Suppress macOS "no default printer" dialog from any child process
    env: {
      CUPS_SERVER: "",
    },
  },
});
