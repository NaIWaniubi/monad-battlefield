/** 极小 .env 读取器：只在 process.env 缺失时兜底，不覆盖已有环境变量 */
import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

export const MON = 10n ** 18n;
export const fmt = (wei) => (wei === null || wei === undefined ? "-" : (Number(wei) / 1e18).toFixed(6) + " MON");
