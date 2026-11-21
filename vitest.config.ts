/**
 * W4 · 纯逻辑单测配置。
 *
 * 刻意不引入 web/vite.config.ts：
 *   root 是 "web"，那套配置会去解析 web/.env 和 index.html；
 *   单测只跑 tests/ 下的纯函数，不需要浏览器环境。
 *
 * 用 node 环境而不是 jsdom：
 *   metrics.ts 完全不碰 DOM；grid.ts 的 GridState 也不碰，
 *   只有 GridRenderer 的方法体里用 window/document（构造时才执行）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 有没有测试都退 0；CI 里想看覆盖率时再打开 coverage
    passWithNoTests: false,
    reporters: ["default"],
  },
});
