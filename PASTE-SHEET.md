# 现场粘贴板 · Monad Battlefield(3 分钟演示,不许现场打字)
> 用法:演示前把本文件在另一窗口打开,需要什么直接整段复制。所有值均真链上可查。

## 大屏 / 页面
```
https://monabattlefield.pages.dev/
https://monabattlefield.pages.dev/?demo=1&crowd=8000
https://monabattlefield.pages.dev/verify
https://monabattlefield.pages.dev/director.html
https://naiwaniubi.github.io/monad-battlefield/
```

## 仓库 / 提交
```
https://github.com/NaIWaniubi/monad-battlefield
mojo.devnads.com/events/18  (项目 id=456,已提交 pending)
```

## 合约 / 链
```
合约地址    0xd525ef7ee4072e80765fd61633d80322040afd9d
网络        Monad Testnet (chainId 10143)
部署区块    79333331
```

## 硬证据(每个都能当场点开)
```
并行物证区块   https://testnet.monadscan.com/block/81474005
              (单块 17 笔 claim,来自 17 个不同 EOA)
观众端到端 tx  https://testnet.monadscan.com/tx/0x36f2c5ea66d949cccadf936f2c06b5d2e6a976b4f9e50248323c9c7ad3ac8536
revert 计费实证 0x6194609f8e93385698c501510b7aba7a5b09f520b12bfda002e2c8dcffcb4ec8
真结算 #1      0xd09b90251adec25098db13339a1cc53f32246033f9bbe0c52a06c70565f7fde5  (0.006666 MON, block 81534262)
真结算 #2      0xd773135df013a6e9f6e2b78df2eee8a011f5ffd9d5c52890298db3cd266b5714  (0.006666 MON, block 81534268)
真结算 #3      0x62a11b9fae1f6c59421d1c084f060705673601ee8e6bfb5e653e4031363fa4dc  (0.006668 MON, block 81534278)
verify 演示地址 0x3470b1aEb06d28145b37DFE7d77190196a79ecb8  (窗口填 5000,命中 3 笔:#321/#1111/#1234)
```

## 一条 curl 复现并行物证
```bash
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x4db8035",true]}' \
 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).result.transactions;const C='0xd525ef7ee4072e80765fd61633d80322040afd9d';const m=t.filter(x=>(x.to||'').toLowerCase()===C);console.log(m.length+' claims / '+new Set(m.map(x=>x.from)).size+' distinct senders')})"
```

## 三条口径(照读,不自由发挥)
```
1. 实测峰值 16 tx/s @17 车道 = reserve-balance 理论 0.83×17≈14.2(平台物理墙)
2. 80 tx/s 只是配置目标,需每道 ≥10 MON(约 400 MON 储备)
3. 大屏 demo 模式的密度是合成的(顶栏标 DEMO);链上部分(verify/tx/结算)全是真交易
```
