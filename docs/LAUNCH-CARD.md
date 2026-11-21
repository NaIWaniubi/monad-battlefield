# LAUNCH-CARD · 领币与注资一页卡

> 从"零测试币"到"中继 8 key 全部有 gas"。单价速查:**1 笔 = 0.0066 MON / 78 人 = 0.51 / 静默墙 240 笔 = 1.6 / 中继 8 key 一场最小 = 2.1**(docs/COST.md;注资红线每 key ≥0.27,RUNBOOK:175)。

## 1. 去哪领币(按优先级,照序走)

| 顺位 | 入口 | 额度 | 备注 |
|---|---|---|---|
| ① | **`mojo.devnads.com/events/18` → 「水龙头」tab** | 参赛者额度,远高于公共龙头 | **活动开始后开放**(RUNBOOK:103)。首选,额度大、不排队 |
| ② | **`faucet.monad.xyz`**(公共兜底) | 不绑定仅 **5 MON**;Connect X / Connect Discord 后更高 | 5 MON ≈ 90 秒 × 8 tx/s,**只够应急**(RUNBOOK:97,104) |
| ③ | 现场问 Monad DevRel | 不确定 | 按档位报数,别说错:观众参与+静默墙 ≈ **3 MON**;要 40 车道逼近 80 tx/s 配置目标 = 每道 ≥10 MON **储备**(约 400 MON 躺账)**+ ~50 MON 费**(RUNBOOK:105,137) |
| ④ | 多地址分批领 | — | 兜底,注意别把水龙头刷爆(RUNBOOK:106) |

**Turnstile 真人验证**:公共龙头页有 Cloudflare 人机验证,**必须真人点一次**,自动化/反复刷新只会加长冷却(现场操作经验,非本仓库代码行为;领币这步请本人到场操作)。

## 2. 注资 relay key(实测步骤,RUNBOOK §1 压成一页)

```bash
# 0) 先把①领到的币打进"注资者地址",私钥写入 .env 的 PRIVATE_KEY(.env.example:5-6)

# 1) 首启中继 → 自动生成 .relayers.json 并打印 8 个地址 → Ctrl-C 停
node server/index.mjs
#    日志:「密钥池:已生成 8 个并写入 .relayers.json(请给每个地址打 gas)」(index.mjs:305-306)
#    横幅逐行列出 #0..#7 地址(index.mjs:1873)

# 2) 用注资者地址给这 8 个地址各转 ≥ 0.27 MON
#    为什么是 0.27:78 观众 + 240 静默墙 = 318 笔 ≈ 2.1 MON ÷ 8 key;
#    老配置 0.05/key = 60 笔,第 61 人开始 502 —— 当场穿帮就是这么来的(RUNBOOK:175)

# 3) 重启中继,自检余额八行全绿(每行 relayer#N 0.xxxx MON,无「没有 gas——暂时停用」)
node server/index.mjs

# 4) 验收(两条都要过)
curl -s http://127.0.0.1:8791/health      # 期望 {"ok":true,"block":<真实高度>,"rpc":true}(RUNBOOK:183-184)
curl -s http://127.0.0.1:8791/api/stats   # 期望 "dryKeys":0(index.mjs:388;字段表见 docs/API.md §3)
```

**蜂群车道是另一笔账**(别和中继混):`npm run keys` 生成 40 车道、`npm run fund` 按 `FUND_MON` 注资(默认 0.05/道;注资后有 15 s 余额可见防抖,等它打印"全部就位"再起 swarm,fund.ts:49-65)。注资 <10 MON/道只是"能打",速率被 reserve-balance 锁在 0.83 tx/s/道——要么每道 ≥10 MON 解除,要么接受算术、台上走 docs/COST.md §5 第二档台词,没有第三种(RUNBOOK:176)。

**中途烧穿**:key 没 gas 会进停用名单,**打币后 ≤30 s 自动恢复、不用重启**(index.mjs:779-783,1252-1271);全场第一铁律——上台第 0 步永远是 `node scripts/budget.mjs`(RUNBOOK:221)。

---

来源核对:docs/RUNBOOK.md:97,103-106,157-166,171-178,183-187,221;.env.example:5-6;package.json:8-10;scripts/fund.ts:49-65;scripts/budget.mjs:1-8;server/index.mjs:303-310,388,779-783,1252-1271,1873,1882-1902;docs/COST.md、docs/API.md(本包);docs/KEYS.md(本包)。Turnstile 一条为现场操作经验,出处已如实标注。
