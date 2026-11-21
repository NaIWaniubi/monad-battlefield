#!/usr/bin/env bash
# 新机器从零到可演示(README/VENUE-HANDOFF 的脚本化)。Windows 用 setup.ps1。
set -euo pipefail
command -v node >/dev/null || { echo "请先装 Node >= 20"; exit 1; }
node -e 'if(+process.versions.node.split(".")[0]<20)throw 0' 2>/dev/null || { echo "Node <20"; exit 1; }
npm ci || npm install
npm run build:contract
[ -f .env ] || { cp .env.example .env && echo "★ 编辑 .env 填 PRIVATE_KEY(测试网)后重跑"; exit 0; }
node scripts/check-secrets.mjs
npx vitest run
npm run build:web
echo "OK → npm run venue 一键开栈(或 stage.mjs 走公网隧道)"
