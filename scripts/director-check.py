"""
跨设备控场验收 —— 证明「平板开导演台、笔记本放大大屏」真的能推字幕。

为什么单独写一条：BroadcastChannel 只在同浏览器同源页面间有效，
而导演台的设计意图就是第二块屏幕。原实现 postMessage 不报错、
状态栏显示「已发送」，大屏那边什么都没有 —— 静默失效 + 假装成功。
这条验收用**两个独立 browser context**（互不共享 BroadcastChannel）
模拟两台设备，只允许走中继通道。

A. 两个 context 打开同一个 origin
B. 导演台 A 推一条字幕
C. 大屏 B 必须真的显示出来（不是「已发送」就算数）
D. 导演台状态栏必须标明「跨设备」（说明走的是中继，不是同屏通道）

用法：python -I scripts/director-check.py [--base http://IP:8791]
"""
import argparse
import asyncio
import os
import re
import sys
import urllib.request
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "shots", "director-x")


def relay_base(port: int = 8791) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/config", timeout=8) as r:
        cfg = json.load(r)
    m = re.match(r"(https?://[^/]+)", cfg.get("joinUrl") or "")
    return m.group(1) if m else f"http://127.0.0.1:{port}"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    port = int(os.environ.get("PORT", "8791"))
    base = args.base or relay_base(port)
    fails: list[str] = []
    print(f"origin = {base}")

    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()

        # 两个独立 context = 两台设备（BroadcastChannel 不共享）
        ctx_screen = await browser.new_context(viewport={"width": 1600, "height": 900})
        ctx_director = await browser.new_context(viewport={"width": 1280, "height": 800})
        screen = await ctx_screen.new_page()
        director = await ctx_director.new_page()

        errors: list[str] = []
        screen.on("pageerror", lambda e: errors.append(f"screen: {str(e)[:140]}"))
        director.on("pageerror", lambda e: errors.append(f"director: {str(e)[:140]}"))

        # ── A. 两端打开 ─────────────────────────────────
        # 大屏用 demo 避免等链上事件，控场通道与数据无关
        await screen.goto(base + "/?demo=1", wait_until="domcontentloaded")
        await screen.wait_for_timeout(2500)
        await director.goto(base + "/director.html", wait_until="domcontentloaded")
        await director.wait_for_timeout(1500)

        director_ok = await director.locator("#banner").count() > 0
        if not director_ok:
            fails.append("A: 导演台没有 #banner 输入框")
        print(f"[A] 大屏 + 导演台已开（两个独立 context）")

        # ── B. 推一条字幕 ──────────────────────────────
        text = "跨设备字幕 · " + base.split("//")[-1][:22]
        box = director.locator("#banner")
        await box.fill(text)
        # 找「推送」按钮：有的版本是 chip、有的是 button
        # 推送按钮是 button[data-act="banner"]（见 director.html:46）
        pushed = False
        for sel in ['button[data-act="banner"]', 'button:has-text("推送")', "#sendBanner"]:
            loc = director.locator(sel)
            if await loc.count():
                await loc.first.click()
                pushed = True
                break
        if not pushed:
            fails.append("B: 没找到推送按钮")
            print("[B] 没找到推送按钮，可用按钮：",
                  await director.locator("button").all_text_contents())
        else:
            print(f"[B] 已点推送：{text!r}")

        # ── C. 大屏必须真的显示 ────────────────────────
        shown = False
        for _ in range(20):  # 最多 10s（大屏每秒轮询一次）
            await screen.wait_for_timeout(500)
            cls = await screen.locator("#banner-bar").get_attribute("class") or ""
            body = (await screen.locator("#banner-bar").text_content() or "").strip()
            if "show" in cls and text[:10] in body:
                shown = True
                break
        if shown:
            print(f"[C] 大屏已显示字幕：{text!r}")
        else:
            cls = await screen.locator("#banner-bar").get_attribute("class") or ""
            body = (await screen.locator("#banner-bar").text_content() or "").strip()
            fails.append(f"C: 大屏没显示字幕（class={cls!r} text={body!r}）")
            print(f"[C] 大屏未显示（class={cls!r} text={body!r}）")

        # ── D. 状态栏必须说「跨设备」 ──────────────────
        status = (await director.locator("#status").text_content() or "").strip()
        print(f"[D] 导演台状态 = {status}")
        if "跨设备" not in status:
            fails.append(f"D: 状态栏没标明走的是中继通道（{status!r}）")

        await screen.screenshot(path=os.path.join(OUT, "screen.png"))
        await director.screenshot(path=os.path.join(OUT, "director.png"))

        if errors:
            fails.append(f"页面运行时错误：{errors}")
        await browser.close()

    print("")
    if fails:
        print("FAIL:")
        for f in fails:
            print("  -", f)
        return 1
    print("PASS: 两台设备（独立 context）通过中继通道推字幕成功，大屏真的显示了。")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))