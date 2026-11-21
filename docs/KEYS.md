# KEYS · 密钥管理卡(角色 / 排除 / 轮换 / 泄露响应)

> 前提铁律:本仓库**一切钱包都是测试网一次性账号**("If you fork this, use accounts you are willing to burn",README.md:239)。任何主网资产/主钱包私钥都不许出现在下列任何文件里。

## 1. 四个角色,四份文件

| 文件 | 角色 | 内容形状 | 谁读写 | 生命周期 |
|---|---|---|---|---|
| `.env` | 部署者/注资者配置 + 前端构建参数 | `PRIVATE_KEY=0x…`(注资/部署身份,`.env.example:6`)、`BOTS/GAP_MS/FUND_MON/PORT/RELAYER_COUNT/GAS_PRICE_GWEI` 等 | `npm run deploy/keys/fund/swarm/relay`(`--env-file-if-exists=.env`,package.json:6-13) | 长期,人手维护 |
| `.bots.json` | **蜂群车道**(40 个独立付款 EOA=并行度上限) | `[{address, pk}, …]` 数组,`npm run keys` 生成/复用(scripts/keys.ts:12-26,默认 `BOTS=40`) | keys.ts 写,fund.ts 读(lib.ts:133),swarm.ts 用 | 换场可整文件重生成 |
| `.relayers.json` | **观众代付池**(默认 8 个中继 key) | 私钥字符串数组(兼容 `keys`/`relayers` 字段与 `privateKey/pk/key` 对象形状,index.mjs:262-274) | 中继首启自动生成并落盘,权限 `0o600`(index.mjs:303-310);`RELAYER_KEYS` 环境变量优先于文件(index.mjs:23,277-287) | 补币后自动恢复;泄露即整批作废 |
| `.deployer.json` | 部署者私钥(`pk` 字段)遗留文件 | `{pk}` | 当前脚本不再读取(部署身份走 `.env` 的 `PRIVATE_KEY`),但**盘上存在且含私钥**(docs/VERIFY-2026-11-21.md:28) | 只许留在忽略清单里,禁止复活使用 |

注:`deployments.json` **不是**密钥文件——只有公开合约地址/区块号,必须提交,否则中继进"未部署"模式(.gitignore:21-22,1546-1555)。

## 2. 排除清单(逐行对照 .gitignore)

```
.gitignore:5  .env            :6 .env.local       :7  web/.env
.gitignore:8  .bots.json
.gitignore:10 .relayers.json  :11 .relayers.json.bak
.gitignore:13 .deployer.json  :14 .deployer.json.bak
.gitignore:15 *.key           :16 *.pem           :17 secrets*
```

两条注释是血泪:`.relayers.json` 曾漏配过一行——"提交公开仓库等于把私钥发出去"(.gitignore:9);`.deployer.json` 曾被 `git add -A` 一起带进暂存区(.gitignore:12)。第三道保险是门禁第 0 道 `scripts/check-secrets.mjs`:按文件名(`.env/.relayers.json/.deployer.json/.bots.json/*.key/*.pem`,check-secrets.mjs:10,41-43)与内容双扫,**开发期间它抓到过三个密钥文件,其中一个已被 `git add`**(README.md:166,RUNBOOK.md:401)。

操作纪律:改过这四份文件后照常 `git add -A` 即可(已被忽略,`git status` 不出现);**永远不要 `git add -f` 强加**(RUNBOOK.md:358)。推送前固定动作:`node scripts/gate.mjs`(含密钥扫描)→ 再单跑 `node scripts/check-secrets.mjs` 复核(RUNBOOK.md:350-354)。

## 3. 轮换步骤(计划内换血,如赛前重开一场)

```bash
# 1) 车道:删文件重生成(40 个新车道),再注资
rm .bots.json && npm run keys && npm run fund       # 期望:车道数=40 / 新注资 40

# 2) 中继:停进程 → 删/改名 .relayers.json → 重启,首启自动生新 8 key 并打印地址
#    (不想停进程可用 RELAYER_KEYS=0x…,0x… 临时换一批,文件不动,index.mjs:23)
node server/index.mjs            # 记下打印的 8 个地址(index.mjs:1873)
# 给 8 个地址各打 ≥0.27 MON(= 78 观众 + 240 静默墙 = 318 笔 ≈ 2.1 MON ÷ 8,
#    老配置 0.05/key 只够 60 笔,第 61 人起 502 当场穿帮 —— RUNBOOK.md:171-175)
^C && node server/index.mjs      # 余额自检通过、无"没有 gas"告警(index.mjs:1882-1902)

# 3) 部署者:换 .env 的 PRIVATE_KEY(新领币地址),重新 npm run deploy 才会换新合约
#    —— 一般不换合约:观众格子上链历史在旧地址上,复用现 deployment。
```

轮换判定口径:注资额由**两堵墙**决定——费率墙(0.0066 MON/笔,花掉的钱)与 reserve 速率墙(余额 <10 MON 限 0.83 tx/s/道,躺着的花不掉的钱),详见 docs/COST.md。蜂群车道若只求"能打"注 0.14 MON/道即可(实测场口径),要接近 80 tx/s 配置目标需每道 ≥10 MON(约 400 MON 储备,README.md:60)。

## 4. 泄露响应三步(顺序不可反,RUNBOOK.md:360-363)

1. **立刻把钱转掉 / 换地址**:把那批钱包的余额转到新生成的新地址(旧 key 视为公共信息);中继用 `RELAYER_KEYS` 热替换,车道重跑 `npm run keys && npm run fund`。
2. **清 git 历史**:`git filter-repo` 抹掉该文件 + 强推。**只做这一步没有意义**——文件从历史里删不掉已经发生的公开,①必须先行。
3. **一律按已泄露处理**:该批 key 对应的账号从此不进任何有资产场景;复盘提交记录,确认 gate 第 0 道为何当时没拦住,补规则进 check-secrets.mjs。

## 5. 占位示例(照抄即可跑,不含任何真钥)

```bash
cp .env.example .env
# 编辑 .env,只改这一行(领了测试币的地址):
#   PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY        ← .env.example:6 的占位形状即合法形状
npm run keys      # 生成 .bots.json(40 车道)
node server/index.mjs   # 首启生成 .relayers.json(8 key,0600),Ctrl-C
npm run fund      # 用 .env 的 PRIVATE_KEY 给车道注资(FUND_MON,默认 0.05;注资后等余额可见防抖 15s,fund.ts:49-65)
node scripts/budget.mjs  # 读 .relayers.json 真余额,回答"够演多久"
```

---

来源核对:README.md:166,237-239;RUNBOOK.md:157-166,171-178,350-363,401;.gitignore:5-17,21-22;package.json:6-13;.env.example:1-31;scripts/keys.ts:6,12-26;scripts/fund.ts:6-10,49-65;scripts/lib.ts:133;scripts/check-secrets.mjs:5,10,41-43;scripts/budget.mjs:38-63;server/index.mjs:19-31,260-310,1782-1902;docs/VERIFY-2026-11-21.md:28。
