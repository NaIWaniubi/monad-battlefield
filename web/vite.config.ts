import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Vite 的 root 按「运行 vite 时的 cwd」解析，所以我们在仓库根跑时 root 必须是 "web"。
 *
 * 多页入口：大屏 / 观众页 / 导演台 / 到场验证 —— 少配一个，线上就会 404。
 */
export default defineConfig({
  root: "web",
  server: { port: 5180, host: true },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "web/index.html"),
        join: resolve(process.cwd(), "web/join.html"),
        director: resolve(process.cwd(), "web/director.html"),
        verify: resolve(process.cwd(), "web/verify.html"),
      },
    },
  },
});
