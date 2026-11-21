# Windows 新机器从零到可演示。前置: Node >= 20 (winget install OpenJS.NodeJS.LTS)
$ErrorActionPreference = "Stop"
node -e "if(+process.versions.node.split('.')[0]<20){throw 'Node<20'}"
npm ci
npm run build:contract
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "★ 编辑 .env 填 PRIVATE_KEY(测试网)后重跑本脚本"; exit 0 }
node scripts/check-secrets.mjs
npx vitest run
npm run build:web
Write-Host "OK → npm run venue 一键开栈(或 node scripts/stage.mjs 走公网隧道)"
