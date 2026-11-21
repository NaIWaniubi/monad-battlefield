"""
UX 审查用的截图采集器 —— 工作流的第一道确定性步骤。

产出 shots/ux/ 下三张图：
  main.png      大屏（1600×900，demo 模式跑 25 秒，让版图长起来）
  join.png      观众页（390×844，选完阵营）
  director.png  导演台（1280×800，演出脚本运行中）

用法：python -I scripts/ux-shot.py
依赖：vite 已在 5180 端口运行
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

# 路径按脚本自身位置解析，不按 cwd —— 从仓库根或从工作区根跑都一样
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("UX_BASE", "http://localhost:5180")
OUT = os.path.join(ROOT, "shots", "ux")


async def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    errors: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()

        # 1. 大屏
        ctx = await browser.new_context(viewport={"width": 1600, "height": 900}, device_scale_factor=2)
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"main: {str(e)[:100]}"))
        await page.goto(f"{BASE}/?demo=1", wait_until="domcontentloaded")
        await page.wait_for_timeout(25000)
        await page.screenshot(path=os.path.join(OUT, "main.png"))
        stats = await page.evaluate(
            "() => ({tps: document.getElementById('tps')?.textContent,"
            " total: document.getElementById('total')?.textContent,"
            " eth: document.getElementById('ethcost')?.textContent})"
        )
        print("main:", stats)
        await ctx.close()

        # 2. 观众页
        ctx2 = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        page2 = await ctx2.new_page()
        page2.on("pageerror", lambda e: errors.append(f"join: {str(e)[:100]}"))
        await page2.goto(f"{BASE}/join.html", wait_until="domcontentloaded")
        await page2.wait_for_timeout(2200)
        if await page2.locator(".faction").count():
            await page2.locator(".faction").nth(2).click()
            await page2.wait_for_timeout(1500)
        await page2.screenshot(path=os.path.join(OUT, "join.png"))
        print("join: ok")
        await ctx2.close()

        # 3. 导演台
        ctx3 = await browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
        page3 = await ctx3.new_page()
        page3.on("pageerror", lambda e: errors.append(f"director: {str(e)[:100]}"))
        await page3.goto(f"{BASE}/director.html", wait_until="domcontentloaded")
        await page3.wait_for_timeout(1500)
        if await page3.locator("#runShow").count():
            await page3.locator("#runShow").click()
            await page3.wait_for_timeout(5000)
        await page3.screenshot(path=os.path.join(OUT, "director.png"))
        print("director: ok")
        await ctx3.close()

        await browser.close()

    if errors:
        print("PAGE ERRORS:", errors)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
