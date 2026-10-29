"""Generate the demo "live stream" video used by the e2e test and README screenshots.
Renders an original title card with Playwright and turns it into a 30 s WebM with ffmpeg."""

import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
VIDEO = FIX / "demo.webm"

NODES_L = [(60, 80), (60, 190), (60, 300)]
NODES_M = [(190, 60), (190, 190), (190, 320)]
NODES_R = [(320, 130), (320, 250)]


def lines(a, b):
    return "".join(
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>'
        for x1, y1 in a
        for x2, y2 in b
    )


def circles(nodes):
    return "".join(f'<circle cx="{x}" cy="{y}" r="20"/>' for x, y in nodes)


HTML = f"""
<html><body style="margin:0;width:1280px;height:720px;overflow:hidden;font-family:'Segoe UI',sans-serif;
background:radial-gradient(90% 80% at 20% 10%,#3e251a 0%,#161b22 55%),#161b22;color:#fff;position:relative">
<div style="position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,.03) 0 1px,transparent 1px 64px),
repeating-linear-gradient(0deg,rgba(255,255,255,.03) 0 1px,transparent 1px 64px)"></div>
<div style="position:absolute;left:64px;top:56px;display:flex;gap:12px;align-items:center;font-size:18px">
  <span style="background:#ff3b5c;padding:6px 12px;border-radius:8px;font-weight:800;letter-spacing:.08em">&#9679; LIVE</span>
  <span style="background:rgba(255,255,255,.1);padding:6px 12px;border-radius:8px">12 480 watching</span>
</div>
<div style="position:absolute;left:64px;top:170px;width:760px">
  <div style="font-size:22px;color:#ffb17c;font-weight:700;letter-spacing:.12em">DEV STREAM &middot; EPISODE 42</div>
  <div style="font-size:64px;font-weight:800;line-height:1.05;margin-top:14px">Building a neural network from scratch</div>
  <div style="font-size:24px;color:#b8b8cc;margin-top:22px">Python &middot; NumPy &middot; live coding</div>
</div>
<svg style="position:absolute;right:70px;top:150px" width="380" height="380" viewBox="0 0 380 380">
  <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ff9c56"/><stop offset="1" stop-color="#f26522"/></linearGradient></defs>
  <g stroke="url(#g)" stroke-width="2" opacity=".55">{lines(NODES_L, NODES_M)}{lines(NODES_M, NODES_R)}</g>
  <g fill="url(#g)">{circles(NODES_L + NODES_M + NODES_R)}</g>
</svg>
</body></html>
"""

with tempfile.TemporaryDirectory(prefix="nt-demo-") as scratch:
    FRAME = Path(scratch) / "demo-frame.png"
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 720})
        page.set_content(HTML)
        page.screenshot(path=str(FRAME))
        b.close()

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-i",
            str(FRAME),
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:sample_rate=48000",
            "-t",
            "30",
            "-r",
            "10",
            "-c:v",
            "libvpx",
            "-b:v",
            "400k",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-af",
            "volume=0.15",
            str(VIDEO),
        ],
        check=True,
    )
    print("wrote", VIDEO, VIDEO.stat().st_size, "bytes")
