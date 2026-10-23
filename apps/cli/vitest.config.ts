import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // No test may change the user's PATH (on Windows, the registry is the real one whatever the home).
    env: { SINGULARITY_NO_PATH: "1" }
  }
})
