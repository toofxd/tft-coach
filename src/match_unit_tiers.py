"""
Reads BunnyMuffins' stage-1 unit priority tier lists (one screenshot per cost on the
openers page) and writes data/static/unit_tiers.json: {cost: [{name, tier, slot}]}.

The tiers only exist as images, so each grid cell is matched against the Set 18
champion art from CommunityDragon (normalized pixel correlation). Re-run after
BunnyMuffins updates the openers page; check the printed scores — a low score or a
small gap to the runner-up means a cell needs a manual look.

Usage: python src/match_unit_tiers.py
"""

import io
import json
import re
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).parent.parent
OUTPUT = ROOT / "data" / "static" / "unit_tiers.json"
UA = {"User-Agent": "Mozilla/5.0"}
TIERS = ["S", "A", "B", "C", "F"]
# Grid of each tier image: x of the first icon, step between icons, icon size (px)
GRID = {1: (130, 74.4, 62), 2: (86, 50.4, 42), 3: (86, 50.4, 42)}


def get_image(url):
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGB")


def tier_image_urls():
    for kind in ("pages", "posts"):
        d = requests.get(f"https://bunnymuffins.lol/wp-json/wp/v2/{kind}?slug=openers&_fields=content",
                         headers=UA, timeout=30).json()
        if d:
            html = d[0]["content"]["rendered"]
            break
    else:
        raise RuntimeError("openers page not found")
    start = html.find("Unit Priority", html.find("Unit Priority") + 20)  # body copy, not the table of contents
    urls = {}
    for cost in (1, 2, 3):
        i = html.find(f"{cost} Costs", start)
        m = re.search(r'<img[^>]+src="([^"]+)"', html[i:i + 2000])
        urls[cost] = m.group(1)
    return urls


def champion_refs():
    data = requests.get("https://raw.communitydragon.org/latest/cdragon/tft/en_us.json", headers=UA, timeout=60).json()
    s18 = next(s for s in data["setData"] if s.get("mutator") == "TFTSet18")
    refs = {}
    for c in s18["champions"]:
        if c.get("cost") not in (1, 2, 3) or not c.get("traits"):
            continue
        for kind in ("tileIcon", "squareIcon"):
            if c.get(kind):
                url = "https://raw.communitydragon.org/latest/game/" + c[kind].lower().replace(".tex", ".png")
                try:
                    refs.setdefault(c["cost"], {}).setdefault(c["name"], []).append(get_image(url))
                except requests.RequestException:
                    pass
    return refs


def feat(img, size=24):
    a = np.asarray(img.resize((size, size), Image.LANCZOS), dtype=np.float32) / 255
    return (a - a.mean()) / (a.std() + 1e-6)


def main():
    urls = tier_image_urls()
    refs = champion_refs()
    ref_feats = {cost: {n: [feat(i) for i in imgs] for n, imgs in by.items()} for cost, by in refs.items()}
    out = {}
    for cost, (x_start, step, size) in GRID.items():
        img = get_image(urls[cost])
        band = img.height / 5
        rows = []
        for t, tier in enumerate(TIERS):
            yc = band * t + band / 2
            k = 0
            while True:
                x0 = int(round(x_start + k * step))
                if x0 + size > img.width:
                    break
                crop = img.crop((x0 + 3, int(yc - size / 2) + 3, x0 + size - 3, int(yc + size / 2) - 3))
                if np.asarray(crop, dtype=np.float32).std() < 25:  # flat background = no more icons in this tier
                    break
                f = feat(crop)
                scored = sorted(((max(float((f * r).mean()) for r in fs), n) for n, fs in ref_feats[cost].items()),
                                reverse=True)
                rows.append({"name": scored[0][1], "tier": tier, "slot": k})
                print(f"{cost}-cost {tier}{k}: {scored[0][1]:14} score {scored[0][0]:.2f}  next {scored[1][1]} "
                      f"({scored[0][0] - scored[1][0]:.2f} gap)")
                k += 1
        names = [r["name"] for r in rows]
        if len(names) != len(set(names)):
            print(f"  WARNING: duplicate match in {cost}-cost — check the scores above")
        out[str(cost)] = rows
    OUTPUT.write_text(json.dumps({"source": urls, "tiers": out}, indent=1), encoding="utf-8")
    print(f"-> {OUTPUT}")


if __name__ == "__main__":
    main()
