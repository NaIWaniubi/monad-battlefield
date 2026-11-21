/**
 * 提交前密钥扫描 —— 门禁的第 6 道。
 *
 * 为什么需要它：这个项目里已经有三个密钥文件被打包进过 git 暂存区
 * （.relayers.json、.deployer.json，以及差点漏掉的 .env）。
 * 公开仓库里的私钥撤不回来 —— 删掉文件也留在历史里。
 * 靠人记「别忘了 gitignore」是不可靠的，所以做成一道会失败的检查。
 *
 * 两条判据：
 *   1. 文件名：.env / .relayers.json / .deployer.json / .bots.json / *.key / *.pem
 *   2. 文件内容：出现 "pk": "0x<64 hex>" 或 privateKey/PRIVATE_KEY 后跟 0x<64 hex>
 *      （交易哈希同样是 64 hex，所以只在「字段名 + 值」这种形状上判，避免误报）
 *
 * 用法：node scripts/check-secrets.mjs
 * 退出码：0 = 干净，1 = 有密钥要处理，2 = 不是 git 仓库（跳过）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 << 20 });
}

let tracked;
try {
  tracked = git("ls-files").split("\n").filter(Boolean);
} catch {
  console.log("跳过：不是 git 仓库（提交前先 git init）");
  process.exit(2);
}

/** 文件名判据 */
const NAME_RULES = [
  { re: /(^|\/)\.env$/, why: "环境变量，通常含 PRIVATE_KEY" },
  { re: /(^|\/)\.env\.(local|production)$/, why: "环境变量" },
  { re: /(^|\/)\.relayers\.json$/, why: "8 个中继钱包私钥" },
  { re: /(^|\/)\.deployer\.json$/, why: "部署者私钥（pk 字段）" },
  { re: /(^|\/)\.bots\.json$/, why: "40 个蜂群钱包私钥" },
  { re: /\.(key|pem)$/i, why: "密钥文件" },
  { re: /(^|\/)secrets?[^/]*$/i, why: "名字就是 secrets" },
];

/** 内容判据：只在「字段名 + 64 hex」这种形状上判，避开交易哈希 */
const CONTENT_RULES = [
  { re: /"(pk|privateKey|private_key|secretKey)"\s*:\s*"0x[0-9a-fA-F]{64}"/, why: 'JSON 私钥字段 "pk": "0x…"' },
  { re: /\b(PRIVATE_KEY|RELAYER_KEYS|DEPLOYER_PK)\s*=\s*0x[0-9a-fA-F]{64}/, why: "env 风格私钥赋值" },
];

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|yml|yaml|sol|env|example|sh|ps1|py)$/i;

const problems = [];

for (const f of tracked) {
  for (const r of NAME_RULES) {
    if (r.re.test(f)) problems.push({ file: f, why: r.why, kind: "文件名" });
  }
}

for (const f of tracked) {
  if (!TEXT_EXT.test(f)) continue;
  let src;
  try {
    if (statSync(resolve(ROOT, f)).size > 2 << 20) continue; // 跳过超大文件
    src = readFileSync(resolve(ROOT, f), "utf8");
  } catch {
    continue;
  }
  for (const r of CONTENT_RULES) {
    if (r.re.test(src)) problems.push({ file: f, why: r.why, kind: "内容" });
  }
}

if (!problems.length) {
  console.log(`干净：${tracked.length} 个已跟踪文件里没有密钥。`);
  process.exit(0);
}

console.error(`发现 ${problems.length} 处密钥风险：`);
for (const p of problems) console.error(`  - [${p.kind}] ${p.file} —— ${p.why}`);
console.error("");
console.error("处理方式：");
console.error("  还没提交过：git rm --cached <file>，并把文件名加进 .gitignore");
console.error("  已经提交过：文件从历史里是删不掉的。要么重新 git init 建干净历史，");
console.error("              要么 git filter-repo 清理，并把那些钱包当已泄露 —— 换新的。");
process.exit(1);
