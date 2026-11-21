# VENUE-HANDOFF · 现场 30 分钟接手卡

> 给「距上台还有半小时,东西不是你做的」的人。全程只需一台笔记本 + 一条能出外网的网。任何一步红灯:先跑 `node scripts/budget.mjs` 看钱,再查 docs/RUNBOOK.md §5 故障矩阵(每条 30 秒处置)。

## 第一步:读这三个文件(10 分钟,别多读)

| 顺序 | 文件 | 只读哪段 | 拿到什么 |
|---|---|---|---|
| 1 | `docs/RUNBOOK.md` | §0(三端一服务 + 为什么必须公网隧道)+ §3(T-60min 12 步) | 台上拓扑与唯一正确启动顺序;8791 端口、三条地址必须同源 |
| 2 | `README.md` | "Measured vs. target" 表(:51-62)+ "Things that were broken"(:175-190) | 话术口径:实测峰值 **16 tx/s@17 道**、真落块 **373**、**80 tx/s 只是配置目标**;0.42 s 是提交窗口不是落块 |
| 3 | `docs/KEYS.md` | 全文(就一屏) | 四份密钥文件(.env/.bots.json/.relayers.json/.deployer.json)各是谁、丢了/泄露了怎么办 |

## 第二步:跑这四条命令(15 分钟,含等待)

```bash
# 1) 依赖。node_modules 若被工作区缓存清理,按 RUNBOOK 附录用 junction 挂回,别 npm install 半小时
npm install

# 2) 六道门禁(密钥扫描/tsc/build/143 单测/二维码解码/跨设备控场)。全绿才有资格上台
node scripts/gate.mjs

# 3) 预算裁决:读 .relayers.json 真实余额,输出"够演哪一档"。决定你的台词,不许跳过(RUNBOOK §3 第 0 步)
node scripts/budget.mjs

# 4) 一键上台:build → cloudflared 公网隧道 → 注入 JOIN_URL 起中继 → 验收二维码,打印三条同源 https 地址
node scripts/stage.mjs --check
```

期望:`stage.mjs` 末尾打印 `大屏/观众页/导演` 三个 `https://xxx.trycloudflare.com` 地址 + `PASS: A…B…C…`。三条地址**全部用它打印的**开,混 localhost 字幕通道会静默死(RUNBOOK:33,62)。

## 第三步:改这三个配置(5 分钟,就这三处,其余都别动)

| 配置 | 位置 | 改成什么 | 为什么 |
|---|---|---|---|
| `PRIVATE_KEY` | `.env`(注资者/部署身份) | 你领到测试币的那个测试网地址私钥 | `npm run fund`/`deploy` 的唯一资金来源;`.env.example:6` 有占位形状 |
| `BOTS` + `GAP_MS` | `.env`(蜂群) | 钱少:`BOTS=10 GAP_MS=1500`(≈6.7 tx/s);别把 GAP 调小求快——<10 MON 的车道被 reserve 限死 0.83 tx/s,间隔不是瓶颈(RUNBOOK:108-118) | 花掉的是 gas,躺着的才是速率:两堵墙见 docs/COST.md |
| `RELAYER_COUNT` | `.env`(中继 key 数) | 默认 **8** 别动;只在新机器上第一次起时,让它生成地址→按 docs/LAUNCH-CARD.md 给每个地址注 ≥**0.27 MON**(RUNBOOK:175) | 8×0.27≈2.1 MON,刚好覆盖 78 观众+240 静默墙=318 笔;老配置 0.05/key 第 61 人 502 穿帮 |

**禁止清单**:`JOIN_URL` 留空(stage.mjs 自动注入隧道地址,写 localhost 会被中继拒绝并告警,index.mjs:1379-1402);`GAS_LIMIT` 不低于 60000(50000→0/3 revert,纯烧钱);不用 `git add -f` 强加密钥文件(RUNBOOK:358)。

## 交还前最后一眼

- 顶栏读什么模式:`实时 · <rpc>` / `DEMO+链上` / `DEMO · 合成打底`——**照它说话**,不说记忆里的数(RUNBOOK:151)。
- `/api/stats` 的 `dryKeys` 必须 0(curl `http://127.0.0.1:8791/api/stats`,字段口径见 docs/API.md §3)。
- 手机关 wifi 用流量扫大屏码点一格:格子变色 + 大屏出声 = 观众链路通(RUNBOOK §3 第 10-11 步,全场最关键)。

---

来源核对:docs/RUNBOOK.md:13-25,33,62,83,108-118,151,175,221,358;README.md:51-62,175-190;.env.example:5-6,10-14,28-31;docs/KEYS.md(本包);docs/LAUNCH-CARD.md(本包);server/index.mjs:1379-1402;scripts/stage.mjs:1-22;scripts/gate.mjs:1-13;docs/API.md §3。
