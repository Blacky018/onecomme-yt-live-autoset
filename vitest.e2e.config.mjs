import { defineConfig } from "vitest/config";

// E2E: ビルドした dist/yt-live-autoset/plugin.js を動かす（npm run test:e2e）
export default defineConfig({
  test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 15_000, fileParallelism: false },
});
