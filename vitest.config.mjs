import { defineConfig } from "vitest/config";

// 通常の単体テスト。E2E（e2e/）はビルドが要るので npm run test:e2e で別に動かす
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
