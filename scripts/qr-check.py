"""
二维码可达性验收 —— 把「手机扫了能不能打开」变成一条可判定的命令。

三种情形，任何一种不成立就退出码非 0：
  A. 用局域网地址开大屏  → 二维码必须出现，**解码出来的文本**就是观众页地址，
                          主机是物理网卡局域网 IPv4，且真的 HTTP GET 得到 200
  B. 用 localhost 开大屏、中继在跑 → 二维码**仍然**必须是局域网地址
                          （这正是原来那个 bug 的回归测试：以前这里会编码 localhost）
  C. 用 localhost 开大屏、中继不可达（路由层 abort /api/config 注入故障）
                          → 必须不画二维码，改出「二维码不可扫」告警卡 + 可执行修法

用法：python -I scripts/qr-check.py [--base http://IP:8791]
依赖：中继已在 8791 监听且 dist/ 已构建；playwright + opencv 或 pyzbar
"""
import argparse
import asyncio
import ipaddress
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "shots", "qr")

def relay_base(port: int = 8791) -> str:
    """中继是地址的唯一权威 —— 问它要，别在 Python 里再算一遍网卡。

    踩过的坑：Node 的 os.networkInterfaces() 和 psutil 枚举到的网卡集合不一样
    （这台机器上 psutil 多出一个「以太网 3」172.19.83.237，Node 根本看不到它），
    两边各排一次序就会选出不同的 IP，验收脚本于是去连一个中继从没打算用的地址。
    直接读 /api/config 的 joinUrl，测的就是中继真正会给出去的那个地址。
    """
    import json

    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/config", timeout=8) as r:
        cfg = json.load(r)
    join = cfg.get("joinUrl") or ""
    m = re.match(r"(https?://[^/]+)", join)
    return m.group(1) if m else f"http://127.0.0.1:{port}"


def is_phone_reachable(host: str) -> bool:
    """手机能不能路由到这个主机。

    两种合法形态：
      - 局域网模式：物理网卡上的私网 IPv4（手机连了同一个 wifi）
      - 隧道模式：公网域名（手机用流量也能开）
    三种死法：回环、169.254 自分配、100.64/10 CGNAT（Tailscale）。
    """
    if not host:
        return False
    if host.lower() in ("localhost", "::1"):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # 不是 IP → 当作域名。公网域名可扫；.local 之类的 mDNS 名字手机解析不了
        return not host.lower().endswith((".local", ".internal", ".lan"))
    if ip.is_loopback or ip.is_link_local or ip.is_unspecified:
        return False
    if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
        return False
    return True


def decode_qr(png_path: str) -> str:
    """先 opencv，再 pyzbar。两个都读不出就抛。"""
    try:
        import cv2

        img = cv2.imread(png_path)
        if img is not None:
            data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
            if data:
                return data
    except Exception:
        pass
    from pyzbar.pyzbar import decode
    from PIL import Image

    for r in decode(Image.open(png_path)):
        if r.type == "QRCODE":
            return r.data.decode("utf-8")
    raise RuntimeError("二维码解码失败（opencv 与 pyzbar 都没读出内容）")


async def shoot_qr(page, url: str, tag: str, block_config: bool = False):
    """开一页，等二维码或告警卡，返回 (decoded, shown_url, qr_visible, warn_visible, warn_fix)。"""
    if block_config:
        await page.route("**/api/config", lambda route: route.abort())
    await page.goto(url, wait_until="domcontentloaded")
    # 二维码和告警卡是互斥的，等其中任意一个出现
    try:
        await page.wait_for_selector("#qrwrap:not([hidden]), #qrwarn:not([hidden])", timeout=20000)
    except Exception:
        pass
    await page.wait_for_timeout(1200)

    qr_visible = await page.locator("#qrwrap").is_visible()
    warn_visible = await page.locator("#qrwarn").is_visible()
    shown = (await page.locator("#qrurl").text_content() or "").strip() if qr_visible else ""
    fix = (await page.locator("#qrwarn-fix").text_content() or "").strip() if warn_visible else ""

    decoded = ""
    if qr_visible:
        png = os.path.join(OUT, f"qr-{tag}.png")
        await page.locator("#qrwrap").screenshot(path=png)
        try:
            decoded = decode_qr(png)
        except Exception as e:
            decoded = f"<解码失败: {e}>"
    await page.screenshot(path=os.path.join(OUT, f"main-{tag}.png"))
    return decoded, shown, qr_visible, warn_visible, fix


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    port = int(os.environ.get("PORT", "8791"))
    base = args.base or relay_base(port)
    # 回环情形一律走本机中继端口：隧道模式下 https://localhost 是不成立的
    loopback_base = f"http://localhost:{port}"
    fails: list[str] = []
    print(f"中继给出的地址  = {base}")
    print(f"大屏（回环）    = {loopback_base}")

    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 900}, device_scale_factor=2)
        errors: list[str] = []

        def new_page():
            p = ctx.new_page()
            return p

        # ── A. 局域网 origin ─────────────────────────────────
        pa = await new_page()
        pa.on("pageerror", lambda e: errors.append(f"A: {str(e)[:140]}"))
        da, sa, qa, wa, _ = await shoot_qr(pa, base + "/", "lan")
        print(f"\n[A] 二维码可见={qa} 告警卡={wa}")
        print(f"[A] 下方明文   = {sa}")
        print(f"[A] 解码结果   = {da}")
        if not qa:
            fails.append("A: 局域网 origin 下二维码没出现")
        if wa:
            fails.append("A: 局域网 origin 下不该出告警卡")
        host = ""
        if da and not da.startswith("<"):
            m = re.match(r"https?://([^/:]+)", da)
            host = m.group(1) if m else ""
            if not is_phone_reachable(host):
                fails.append(f"A: 解码出的主机手机路由不到：{host!r}")
            if not da.endswith("/join.html"):
                fails.append(f"A: 解码出的不是观众页：{da!r}")
            if sa and sa not in da:
                fails.append(f"A: 明文地址与二维码内容不一致：{sa!r} vs {da!r}")
        elif qa:
            fails.append(f"A: {da or '没拿到二维码内容'}")

        # 真的 GET 一次解码出的地址
        if da.startswith("http"):
            try:
                with urllib.request.urlopen(da, timeout=10) as r:
                    body = r.read(6000).decode("utf-8", "replace")
                    code = r.status
                if code != 200:
                    fails.append(f"A: 观众页 HTTP {code}")
                elif "grid" not in body and "join" not in body.lower():
                    fails.append("A: 观众页返回 200 但内容不像观众页")
                else:
                    print(f"[A] 观众页实访 = HTTP {code} · OK")
            except Exception as e:
                fails.append(f"A: 观众页打不开：{e}")

        # ── B. 回环 origin + 中继在跑（原 bug 的回归测试）──────
        pb = await new_page()
        pb.on("pageerror", lambda e: errors.append(f"B: {str(e)[:140]}"))
        db, sb, qb, wb, _ = await shoot_qr(pb, loopback_base + "/", "loopback-relay-up")
        print(f"\n[B] 二维码可见={qb} 告警卡={wb}")
        print(f"[B] 解码结果   = {db}")
        if not qb:
            fails.append("B: 中继在跑时，localhost 开大屏也应该能给出可扫二维码")
        elif db.startswith("http"):
            mb = re.match(r"https?://([^/:]+)", db)
            hb = mb.group(1) if mb else ""
            if not is_phone_reachable(hb):
                fails.append(f"B: 回归失败 —— localhost 开大屏时二维码仍编码了 {hb!r}（手机扫不开）")
            else:
                print(f"[B] 回归通过   = localhost 开大屏，二维码依然是 {hb}")
        else:
            fails.append(f"B: {db or '没拿到二维码内容'}")

        # ── C. 回环 origin + 中继不可达（故障注入）─────────────
        pc = await new_page()
        pc.on("pageerror", lambda e: errors.append(f"C: {str(e)[:140]}"))
        dc, sc, qc, wc, fc = await shoot_qr(pc, loopback_base + "/", "relay-down", block_config=True)
        print(f"\n[C] 二维码可见={qc} 告警卡={wc}")
        print(f"[C] 修法提示   = {fc}")
        if qc:
            fails.append("C: 中继不可达时仍然画了二维码（手机扫不开）")
        if not wc:
            fails.append("C: 中继不可达时没有出告警卡")
        if wc and not fc:
            fails.append("C: 告警卡没给出可执行修法")

        if errors:
            fails.append(f"页面运行时错误：{errors}")
        await browser.close()

    print("")
    if fails:
        print("FAIL:")
        for f in fails:
            print("  -", f)
        return 1
    print("PASS: A 二维码编码的是手机可达地址、实访 200；B localhost 开大屏也给出同一个可达地址（原 bug 已修）；C 中继挂了不出死码、给出修法。")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))