import { defineConfig } from "vitest/config";

import { createPatchedPlaywrightProvider } from "./src/reproProvider";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: createPatchedPlaywrightProvider(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
    },
  },
});
