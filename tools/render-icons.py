"""Rasterize assets/icons/*.svg into the PNG sizes the extension needs (uses Playwright Chromium)."""

from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "assets" / "icons"
JOBS = [
    ("icon-small.svg", 16),
    ("icon-small.svg", 32),
    ("icon.svg", 48),
    ("icon.svg", 128),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(device_scale_factor=1)
    for svg, size in JOBS:
        markup = (ICONS / svg).read_text(encoding="utf-8")
        page.set_viewport_size({"width": size, "height": size})
        page.set_content(
            f'<html><body style="margin:0;background:transparent">'
            f'<div style="width:{size}px;height:{size}px">{markup.replace("<svg ", f"<svg width={size} height={size} ", 1)}</div></body></html>'
        )
        page.locator("div").screenshot(
            path=str(ICONS / f"icon-{size}.png"), omit_background=True
        )
        print("wrote", f"icon-{size}.png")
    browser.close()
