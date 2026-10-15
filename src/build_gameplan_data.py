"""
Builds data/static/gameplan_data.json for the Game Plan tree (public/gameplan.html).

Sources:
  - bunnymuffins.lol (WordPress API): comp tier list, augment guide, opener guide,
    leveling guide. Re-run every patch — the guides are updated per patch.
  - tactics.tools: the augment list with tier (silver/gold/prismatic) and the stages
    each augment can be offered at (2-1 / 3-2 / 4-2).
  - CommunityDragon: augment descriptions + icons.

The guide text is kept as AI grounding for /api/gameplan-augments; the page shows only
structured facts (tiers, leveling tables, conditions, BIS augments) and credits the source.

Usage: python src/build_gameplan_data.py
"""

import html
import json
import re
import requests
from pathlib import Path

OUTPUT = Path(__file__).parent.parent / "data" / "static" / "gameplan_data.json"
UA = {"User-Agent": "Mozilla/5.0"}
TT_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://tactics.tools/"}
STAGES = ["2-1", "3-2", "4-2"]


def wp_page(slug):
    """Some guides are WordPress pages, others posts — try both."""
    for kind in ("pages", "posts"):
        url = f"https://bunnymuffins.lol/wp-json/wp/v2/{kind}?slug={slug}&_fields=slug,modified,content"
        r = requests.get(url, headers=UA, timeout=20)
        r.raise_for_status()
        d = r.json()
        if d:
            return d[0]["content"]["rendered"], d[0]["modified"]
    raise RuntimeError(f"bunnymuffins page not found: {slug}")


def to_text(fragment):
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", fragment, flags=re.S)
    t = re.sub(r"<br\s*/?>|</(p|li|h\d|tr|div|button)>", "\n", t)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t).replace("’", "'").replace("‘", "'")
    t = re.sub(r"[ \t\xa0]+", " ", t)
    return "\n".join(l.strip() for l in t.splitlines() if l.strip())


def norm(name):
    """Augment/comp name → match key ("Champ Delivery+" ≠ "Champ Delivery")."""
    n = html.unescape(name).replace("’", "'").lower()
    n = n.replace("&", "and").replace("'", "")
    n = re.sub(r"\b(iii|ii|i)\b", lambda m: {"i": "1", "ii": "2", "iii": "3"}[m.group(1)], n)
    return re.sub(r"[^a-z0-9+]", "", n)


# ── Leveling tables ───────────────────────────────────────────────────────────

def parse_level_rows(lines):
    """['Lose Streak', 'Round 2-3 2-7 ...', 'Level 4 5 6 ...', ...] → [{label, steps:[{round, level}]}]."""
    out, label = [], None
    i = 0
    while i < len(lines):
        l = lines[i]
        if l.startswith("Round ") and i + 1 < len(lines) and lines[i + 1].startswith("Level "):
            rounds = re.findall(r"\d-\d(?: or \d-\d)?(?: \(\d+g\+\))?|\d\+", l[6:])
            levels = lines[i + 1][6:].split()
            out.append({"label": label or "Standard",
                        "steps": [{"round": r, "level": lv} for r, lv in zip(rounds, levels)]})
            label = None
            i += 2
            continue
        if len(l) < 30 and not l.startswith("Level"):
            label = l
        i += 1
    return out


# ── Meta page → comps ─────────────────────────────────────────────────────────

def strategy_of(pattern):
    p = pattern.lower()
    if "fast 8/9" in p or "fast 9" in p:
        return "fast9"
    if "fast 8" in p:
        return "fast8"
    if "hybrid" in p:
        return "reroll12"
    m = re.search(r"(\d) cost reroll", p)
    if m:
        return f"reroll{m.group(1)}"
    return "standard"


def section(lines, start, stops):
    """Lines after the `start` label up to the next label in `stops`."""
    try:
        i = next(k for k, l in enumerate(lines) if l.rstrip(" :").lower() == start.lower())
    except StopIteration:
        return []
    out = []
    for l in lines[i + 1:]:
        # A label can sit alone ("Tips:") or lead its text ("Stage 3: Continue...")
        if l.rstrip(" :").lower() in stops or l.split(":", 1)[0].strip().lower() in stops:
            break
        out.append(l)
    return out


def parse_meta(raw):
    # Summary line: short names + "*" (needs an emblem/augment) keyed by anchor id
    summary = {}
    for m in re.finditer(r'<a href="#([^"]+)">([^<]+)</a>(\*?)', raw):
        summary[m.group(1)] = {"short": to_text(m.group(2)), "needsSpecial": bool(m.group(3))}

    # Tier headers ("S Tier: ...") and comp headings, in page order
    marks = [(m.start(), "tier", m.group(1)) for m in
             re.finditer(r"<h2[^>]*>\s*(?:<[^>]+>\s*)*([SABC]|Special) Tier", raw)]
    marks += [(m.start(), "comp", m.group(1)) for m in
              re.finditer(r'<h3 class="gb-headline[^"]*"[^>]*>(.*?)</h3>', raw)]
    marks.sort()

    labels = {"leveling pattern", "conditions", "how to play", "gameplan", "stage 1-2", "stage 3",
              "stage 4", "stage 5+", "tips", "item holder", "items", "augments",
              "best emblem/spatula holder"}
    comps, tier = [], None
    for k, (pos, kind, val) in enumerate(marks):
        if kind == "tier":
            tier = val
            continue
        end = marks[k + 1][0] if k + 1 < len(marks) else len(raw)
        chunk = raw[pos:end]
        anchor = re.search(r'id="([^"]+)"', chunk)
        anchor = anchor.group(1) if anchor else None
        if anchor and anchor.startswith("gb-"):
            anchor = None
        text = to_text(chunk)
        lines = text.splitlines()
        if "Leveling Pattern:" not in text:
            continue

        # Inline labels ("Gameplan: ...", "Stage 3: ...") live on the same line as their text
        def inline(label):
            m = re.search(rf"^{re.escape(label)}\s*:\s*(.+)$", text, re.M)
            return m.group(1).strip() if m else ""

        lp = section(lines, "Leveling Pattern", {"conditions"})
        pattern = lp[0] if lp else ""
        notes = [re.sub(r"\s*(Mixed|Win|Lose) Streak$", "", l) for l in lp[1:]
                 if len(l) > 14 and not re.match(r"(Round|Level) [\d ]", l)]
        aug_lines = section(lines, "Augments", {"learn tft the right way"} | labels)
        bis = next((l[4:].strip() for l in aug_lines if l.startswith("BIS:")), "")
        general = next((l[8:].strip() for l in aug_lines if l.startswith("General:")), "")
        codes = re.findall(r'data-copy="([0-9a-zA-Z]+)"', chunk)
        builder = re.search(r'href="(https://teamfight\.lol/team-builder[^"]+)"', chunk)
        name = to_text(val)
        info = summary.get(anchor, {}) if tier != "Special" else {}
        if any(c["name"] == name for c in comps):
            continue  # same comp listed again under another tier
        comps.append({
            "id": anchor or norm(name),
            "name": name,
            "short": info.get("short", name),
            "tier": tier,
            "needsSpecial": info.get("needsSpecial", False),
            "strategy": strategy_of(pattern),
            "levelingPattern": pattern,
            "leveling": parse_level_rows(lp[1:]),
            "levelingNotes": notes,
            "conditions": section(lines, "Conditions", labels),
            "plan": {
                "overview": inline("Gameplan"),
                "stage2": inline("Stage 1-2"),
                "stage3": inline("Stage 3"),
                "stage4": inline("Stage 4"),
                "stage5": inline("Stage 5+"),
            },
            "tips": section(lines, "Tips", labels),
            "itemHolders": inline("Item Holder"),
            "items": section(lines, "Items", labels),
            "augments": {"bis": [a.strip() for a in bis.split(",") if a.strip()], "priority": general},
            "teamCode": codes[0] if codes else None,
            "builderUrl": html.unescape(builder.group(1)) if builder else None,
        })
    return comps


# ── Augment guide ─────────────────────────────────────────────────────────────

def parse_augment_guide(raw):
    text = to_text(raw)
    body = text.split("Augment Appears Games to Learn Guide", 1)[-1]
    out = {}
    for l in body.splitlines():
        m = re.match(r"^(.+?)\s+((?:\d-\d,?\s*)*)\s*(\d+)\s+(.+)$", l)
        if not m:
            continue
        name, stages, learn, note = m.groups()
        out[norm(name)] = {
            "name": name.strip(),
            "stages": re.findall(r"\d-\d", stages),
            "gamesToLearn": int(learn),
            "guide": note.strip(),
        }
    # A guide line can wrap onto the next line (e.g. "Bonus Gift+ 3-2 10" + text)
    lines = body.splitlines()
    for a, b in zip(lines, lines[1:]):
        m = re.match(r"^(.+?)\s+((?:\d-\d,?\s*)+)\s*(\d+)$", a)
        if m and norm(m.group(1)) not in out:
            out[norm(m.group(1))] = {"name": m.group(1).strip(), "stages": re.findall(r"\d-\d", m.group(2)),
                                     "gamesToLearn": int(m.group(3)), "guide": b.strip()}
    general = [l for l in text.split("All Augments", 1)[0].splitlines()
               if l.startswith(("Economy", "Combat/item", "Trait augments", "General tip"))]
    return out, general


# ── Opener guide → directional rules ──────────────────────────────────────────

def parse_openers(raw):
    text = to_text(raw)
    rules = []
    block = text.split("Broken Openers:", 2)[-1].split("How to find and decide", 1)[0]
    for l in block.splitlines():
        if "->" in l or "?" in l and "->" in l:
            cond, _, comps = l.partition("->")
            rules.append({"if": cond.strip().rstrip("?").strip(), "play": [c.strip() for c in comps.split(",") if c.strip()]})
    hard = section(block.splitlines(), "Hard Force", {"conditional", "reroll check", "lose streak"})
    # Per-augment advice paragraphs (heading line = augment names, then the advice)
    aug_notes = {}
    after = text.split("tempo is king", 1)[-1].split("How to find and decide", 1)[0]
    cur = None
    for l in after.splitlines():
        if len(l) < 70 and not l.endswith("."):
            cur = l
            aug_notes[cur] = []
        elif cur:
            aug_notes[cur].append(l)
    aug_notes = {k: " ".join(v) for k, v in aug_notes.items() if v}
    return {"hardForce": hard, "rules": rules, "augmentNotes": aug_notes, "fullText": text}


# ── Legal augment list ───────────────────────────────────────────────────────

def fetch_tt_augments():
    r = requests.get("https://ap.tft.tools/static/s18/data.js", headers=TT_HEADERS, timeout=20)
    r.raise_for_status()
    m = re.search(r"window\.data18\s*=\s*JSON\.parse\(`(.*?)`\)", r.text, re.DOTALL)
    return json.loads(m.group(1)).get("augments", {})


def cd_desc(it):
    desc = it.get("desc") or ""
    for k, v in (it.get("effects") or {}).items():
        if isinstance(v, (int, float)):
            desc = desc.replace(f"@{k}@", f"{v:g}")
    desc = re.sub(r"@[^@]+@", "?", desc)
    desc = re.sub(r"<br\s*/?>", " ", desc)
    return re.sub(r"<[^>]+>|%i:[a-zA-Z]+%", "", desc).strip()


def cd_png(icon):
    return ("https://raw.communitydragon.org/latest/game/" + icon.lower().replace(".tex", ".png")) if icon else None


def fetch_cdragon():
    """→ (augments by norm(name), names by apiName for items/augments/champions)."""
    r = requests.get("https://raw.communitydragon.org/latest/cdragon/tft/en_us.json", headers=UA, timeout=30)
    r.raise_for_status()
    data = r.json()
    s18 = next(s for s in data["setData"] if s.get("mutator") == "TFTSet18")
    aug_ids = set(s18.get("augments") or [])
    names, augs, icons = {}, {}, {}
    for it in data["items"]:
        api, name = it.get("apiName"), it.get("name")
        if not api or not name:
            continue
        names[api] = name
        icons[api] = cd_png(it.get("icon"))
        if api in aug_ids or "_Augment_" in api:
            # Set 18 ids win over older copies of the same augment
            if api in aug_ids or norm(name) not in augs:
                augs[norm(name)] = {"apiName": api, "desc": cd_desc(it), "icon": cd_png(it.get("icon"))}
    for c in s18.get("champions") or []:
        if c.get("apiName") and c.get("name"):
            names[c["apiName"]] = c["name"]
    return augs, names, icons


def build_augments(tt, guide, cd):
    rank_name = {1: "silver", 2: "gold", 3: "prismatic"}
    augs = {}
    for key, a in tt.items():
        n = norm(a["name"])
        stages = [s for s, ok in zip(STAGES, a.get("picks") or []) if ok]
        g = guide.get(n, {})
        c = cd.get(n, {})
        augs[n] = {
            "name": a["name"], "tier": rank_name.get(a.get("rank"), "gold"),
            # The guide's stages are set-specific; tactics.tools' flags are broader
            "stages": g.get("stages") or stages,
            "guide": g.get("guide"), "gamesToLearn": g.get("gamesToLearn"),
            "desc": c.get("desc"), "icon": c.get("icon"), "apiName": c.get("apiName"),
        }
    # Guide-only augments (tactics.tools lags on new ones)
    for n, g in guide.items():
        if n not in augs and g["stages"]:
            c = cd.get(n, {})
            augs[n] = {"name": g["name"], "tier": None, "stages": g["stages"], "guide": g["guide"],
                       "gamesToLearn": g["gamesToLearn"], "desc": c.get("desc"), "icon": c.get("icon"),
                       "apiName": c.get("apiName")}
    return augs


# ── Augment tags (facts the page's if-then rules key on; no guide text shipped) ──

TAG_RULES = [
    ("econ", r"\becon|\bgold\b|interest|cash ?out"),
    ("items", r"\bitems?\b|component|anvil|grab bag|forge|artifact|radiant|\bbis\b"),
    ("combat", r"combat|\btanks?\b|frontline|front line|\bcarry\b|carries"),
    ("trait", r"emblem|\btraits?\b|vertical"),
    ("tempo", r"tempo|win ?streak|strongest board|be strong|board wins"),
    ("losestreak", r"lose streak|loss streak|lose-streak"),
    ("reroll", r"reroll|3 star|3\*"),
    ("fast9", r"fast 9|fast 8/9|level 9|5 cost"),
    ("fast8", r"fast 8|4 cost"),
    ("gamble", r"gamble|risky"),
    ("direction", r"no direction|lacking direction|get direction"),
]


def tag_augments(augments, trait_names):
    traits_by_low = {t.lower(): t for t in trait_names}
    for a in augments.values():
        text = f"{a.get('guide') or ''} {a['name']}".lower()
        a["tags"] = [t for t, rx in TAG_RULES if re.search(rx, text)]
        if (a.get("desc") or "") and re.search(r"\bgold\b|\bxp\b|interest", a["desc"].lower()) and "econ" not in a["tags"]:
            a["tags"].append("econ")
        a["traits"] = sorted({traits_by_low[w] for w in traits_by_low if re.search(rf"\b{re.escape(w)}\b", text)})


# ── Comp damage lean + component wants (from the carries' items) ──────────────

COMPONENTS = {1: "BF Sword", 2: "Recurve Bow", 3: "Rod", 4: "Tear", 5: "Chain Vest",
              6: "Negatron Cloak", 7: "Giant's Belt", 8: "Sparring Gloves", 9: "Spatula", 10: "Frying Pan"}
TANK_PARTS = {5, 6, 7}
# Item stats are hybrid this set (most give AD% *and* AP), so lean comes from what the
# item is built for. Attack-speed / mana items that both sides use count for neither.
AD_ITEMS = {"Infinity Edge", "Deathblade", "Last Whisper", "Kraken's Fury", "Sterak's Gage", "Giant Slayer",
            "Edge of Night", "Bloodthirster", "Red Buff", "Titan's Resolve", "Runaan's Hurricane", "Striker's Flail"}
AP_ITEMS = {"Rabadon's Deathcap", "Jeweled Gauntlet", "Archangel's Staff", "Morellonomicon", "Void Staff",
            "Nashor's Tooth", "Ionic Spark", "Hextech Gunblade", "Blue Buff"}


def comp_shape(final_comp, items_by_name, main_champion=None):
    """→ carries (each with its own AD/AP lean), the comp's overall lean, and the components
    its carries and tanks want."""
    carries, carry_parts, tank_parts = [], {}, {}
    for u in final_comp:
        parts = [c for it in u["items"] for c in (items_by_name.get(it, {}).get("from") or [])]
        if not parts:
            continue
        is_tank = sum(c in TANK_PARTS for c in parts) > len(parts) / 2
        bucket = tank_parts if is_tank else carry_parts
        for c in parts:
            if c in COMPONENTS:
                bucket[COMPONENTS[c]] = bucket.get(COMPONENTS[c], 0) + 1
        if is_tank or len(u["items"]) < 2:
            continue
        ad = sum(it in AD_ITEMS for it in u["items"])
        ap = sum(it in AP_ITEMS for it in u["items"])
        if ad == ap:  # no clear signal from finished items: fall back to BF Sword vs Rod
            ad, ap = parts.count(1), parts.count(3)
        carries.append({"name": u["name"], "items": u["items"],
                        "lean": "AD" if ad > ap else "AP" if ap > ad else "Mixed"})
    # The comp leans the way its main carry does; otherwise the carries' majority
    main = next((c for c in carries if c["name"] == main_champion and c["lean"] != "Mixed"), None)
    votes = [c["lean"] for c in carries if c["lean"] != "Mixed"]
    lean = main["lean"] if main else ("AD" if votes.count("AD") > votes.count("AP") else
                                      "AP" if votes.count("AP") > votes.count("AD") else "Mixed")
    carries.sort(key=lambda c: c["name"] != main_champion)  # main carry first
    top = lambda d: [{"name": k, "count": v} for k, v in sorted(d.items(), key=lambda kv: -kv[1])][:4]
    return {"carries": carries, "lean": lean, "wants": {"carry": top(carry_parts), "tank": top(tank_parts)}}


def load_calc_data():
    p = Path(__file__).parent.parent / "data" / "static" / "calculator_data.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"units": {}, "traits": {}}


# ── Leveling guide → generic tables per strategy ──────────────────────────────

LEVEL_SECTIONS = [
    ("fast9", "Standard Leveling (for Fast 8 or 9)"),
    ("reroll1", "1 Cost Reroll"),
    ("reroll2", "2 Cost Reroll"),
    ("reroll3", "3 Cost Reroll"),
    ("reroll12", "Hybrid 1 and 2 Cost Rerolls"),
]


def parse_leveling_guide(text):
    """Each heading appears twice (table of contents, then body) — parse the body copy."""
    lines = text.splitlines()
    starts = []
    for key, head in LEVEL_SECTIONS:
        idx = [i for i, l in enumerate(lines) if l.startswith(head)]
        if idx:
            starts.append((idx[-1], key))
    end = next((i for i, l in enumerate(lines) if l.startswith("Strength of the Lobby") and i > starts[0][0]), len(lines))
    starts.sort()
    out = {}
    for k, (i, key) in enumerate(starts):
        stop = starts[k + 1][0] if k + 1 < len(starts) else end
        body = lines[i + 1:stop]
        out[key] = {
            "leveling": parse_level_rows(body),
            # Short rule lines only — the long paragraphs stay out of the page and prompt
            "notes": [l for l in body if 14 < len(l) <= 160 and not re.match(r"(Round|Level) [\d ]", l)
                      and not re.match(r"^(Win|Lose|Mixed|Normal)[\w/ ]*Streak", l) and l not in ("Lose Streak", "Other")],
        }
    out["fast8"] = out.get("fast9")
    return out


# ── TFT Academy comps (SvelteKit __data.json, devalue-encoded) ────────────────

def devalue(arr):
    memo = {}

    def h(i):
        if not isinstance(i, int) or i < 0:
            return None
        if i in memo:
            return memo[i]
        v = arr[i]
        if isinstance(v, list):
            if v and isinstance(v[0], str) and v[0] in ("Date", "Set", "Map", "BigInt", "RegExp"):
                r = v[1] if len(v) > 1 else None
            else:
                r = [h(x) for x in v]
        elif isinstance(v, dict):
            r = {k: h(x) for k, x in v.items()}
        else:
            r = v
        memo[i] = r
        return r
    return h(0)


def fetch_tfta():
    r = requests.get("https://tftacademy.com/tierlist/comps/__data.json", headers=UA, timeout=30)
    r.raise_for_status()
    nodes = r.json()["nodes"]
    patch = devalue(nodes[0]["data"]).get("patch")
    guides = next(devalue(n["data"]) for n in nodes if n and n.get("type") == "data" and "guides" in str(n["data"][0]))
    return patch, [g for g in guides["guides"] if g.get("isPublic")]


def tfta_strategy(style):
    s = (style or "").lower()
    m = re.match(r"(\d)-cost reroll", s)
    if m:
        return f"reroll{m.group(1)}"
    if "fast 8" in s:
        return "fast8"
    return "fast9"  # Fast 9 / Lose Streak play the standard curve


def build_tfta_comps(guides, names, augments_by_api, icons):
    def nm(api):
        raw = re.sub(r"^DA_(\d+_)?|\d+$", "", api or "").replace("_", " ")
        return names.get(api) or re.sub(r"(?<=[a-z])(?=[A-Z])", " ", raw).replace("Trait Augment", "").replace("  ", " ").strip()

    def aug_name(api):
        a = augments_by_api.get(api)
        return a["name"] if a else nm(api)

    def board(units):
        return [{"name": nm(u.get("apiName")), "stars": u.get("stars") or 1,
                 "items": [nm(i) for i in (u.get("items") or [])]} for u in (units or [])]

    tier_name = {"X": "Special"}
    comps = []
    for g in sorted(guides, key=lambda g: ("SABCX".find(g.get("tier") or "X"), g.get("displayIndex") or 0)):
        comps.append({
            "id": g["compSlug"],
            "name": g.get("metaTitle") or g["title"],
            "short": g["title"],
            "tier": tier_name.get(g.get("tier"), g.get("tier")),
            "style": g.get("style"),
            "strategy": tfta_strategy(g.get("style")),
            "difficulty": (g.get("difficulty") or "").title(),
            "mainChampion": nm((g.get("mainChampion") or {}).get("apiName")),
            "augments": [aug_name(a["apiName"]) for a in (g.get("augments") or []) if not a.get("disabled")],
            "augmentTypes": [t.title() for t in (g.get("augmentTypes") or [])],
            "augmentsTip": g.get("augmentsTip") or "",
            "tips": [{"stage": t.get("stage"), "tip": t.get("tip")} for t in (g.get("tips") or [])],
            # TFT Academy shows this list as "Item Priority" (finished item, then components)
            "itemPriority": [{"name": nm(c["apiName"]), "icon": icons.get(c["apiName"])} for c in (g.get("carousel") or [])],
            "earlyComp": board(g.get("earlyComp")),
            "finalComp": board(g.get("finalComp")),
            "url": f"https://tftacademy.com/tierlist/comps/{g['compSlug']}",
            "updated": g.get("updated"),
        })
    return comps


def match_bm(tfta_comps, bm_comps):
    """Attach the closest BunnyMuffins comp (leveling table, conditions, team code) to each
    TFT Academy comp by shared champion/trait words. Returns {bm name: tfta id} for openers."""
    def words(s):
        return {w for w in re.findall(r"[a-z']+", s.lower().replace("'", "")) if len(w) > 2} - \
            {"reroll", "fast", "flex", "cost", "the", "and"}

    bm_to_tfta = {}
    for b in bm_comps:
        bw = words(b["name"]) | words(b["short"])
        holders = {w for l in b["items"] for w in words(l.split(":")[0])}
        best, best_score = None, 0
        for t in tfta_comps:
            tw = words(t["short"]) | words(t["name"])
            champs = {w for u in t["finalComp"] for w in words(u["name"])}
            score = 3 * len(bw & tw) + len(bw & champs) + len(holders & champs) + (t["strategy"][:4] == b["strategy"][:4])
            if norm(t["short"]) in (norm(b["name"]), norm(b["short"])):
                score += 10
            if score > best_score:
                best, best_score = t, score
        if best and best_score >= 4:
            bm_to_tfta[b["name"]] = best["id"]
            bm_to_tfta[b["short"]] = best["id"]
            best.setdefault("bm", b)
    return bm_to_tfta


def main():
    meta_raw, meta_mod = wp_page("meta")
    aug_raw, aug_mod = wp_page("augments")
    op_raw, op_mod = wp_page("openers")
    lvl_raw, lvl_mod = wp_page("tft-leveling-guide")

    bm_comps = parse_meta(meta_raw)
    guide, aug_general = parse_augment_guide(aug_raw)
    openers = parse_openers(op_raw)
    cd_augs, names, icons = fetch_cdragon()
    augments = build_augments(fetch_tt_augments(), guide, cd_augs)
    by_api = {a["apiName"]: a for a in augments.values() if a.get("apiName")}

    lvl_text = to_text(lvl_raw)
    level_tables = parse_leveling_guide(lvl_text)
    tfta_patch, tfta_guides = fetch_tfta()
    comps = build_tfta_comps(tfta_guides, names, by_api, icons)
    bm_to_tfta = match_bm(comps, bm_comps)
    calc = load_calc_data()
    trait_names = sorted({t["name"] for t in calc["traits"].values() if t.get("name")})
    tag_augments(augments, trait_names)
    unit_traits = {u.get("name"): u.get("traits") or [] for u in calc["units"].values()}
    units_by_name = {u.get("name"): u for u in calc["units"].values()}
    items_by_name = {i["name"]: i for i in calc.get("items", {}).values()}
    for c in comps:
        counts = {}
        for u in c["finalComp"]:
            for t in unit_traits.get(u["name"], []):
                counts[t] = counts.get(t, 0) + 1
        # Champion art + cost; drop summons/props that aren't shop units
        for board in ("finalComp", "earlyComp"):
            for u in c[board]:
                cu = units_by_name.get(u["name"])
                u["cost"], u["icon"] = (cu.get("cost"), cu.get("icon")) if cu else (None, None)
            c[board] = [u for u in c[board] if u["cost"]]
        c.update(comp_shape(c["finalComp"], items_by_name, c["mainChampion"]))
        words = c["short"].lower()
        c["traits"] = sorted([t for t, n in counts.items() if n >= 2 or t.lower() in words], key=lambda t: -counts.get(t, 0))
    for c in comps:
        b = c.pop("bm", None)
        generic = level_tables.get(c["strategy"]) or {"leveling": [], "notes": []}
        # BunnyMuffins' per-comp table only if it plays the same curve TFT Academy says
        own = b if b and b["strategy"] == c["strategy"].replace("fast8", "fast9") else None
        c["leveling"] = (own and own["leveling"]) or generic["leveling"]
        c["levelingNotes"] = (own and own["levelingNotes"]) or generic["notes"]
        c["bm"] = b and {k: b[k] for k in ("name", "tier", "conditions", "plan", "tips", "items",
                                            "itemHolders", "augments", "teamCode", "builderUrl")}

    bm_patch = re.search(r"Set \d+ Patch ([\d.]+[a-z]?)", to_text(meta_raw))
    out = {
        "sources": ["tftacademy.com", "bunnymuffins.lol", "tactics.tools"],
        "patch": tfta_patch or (bm_patch.group(1) if bm_patch else None),
        "updated": {"tftacademy": max((c["updated"] or "" for c in comps), default=None),
                    "bmMeta": meta_mod, "bmAugments": aug_mod, "bmOpeners": op_mod, "bmLeveling": lvl_mod},
        "metaSummary": to_text(meta_raw).split("Augment Guide", 1)[0].replace("Video Guides at YouTube", "").replace("Meta Snapshot Summary", "").strip(),
        "comps": comps,
        "bmCompToTfta": bm_to_tfta,
        "augments": augments,
        "augmentPrinciples": aug_general,
        "openerGuide": {k: v for k, v in openers.items() if k != "fullText"},
        "openerGuideText": openers["fullText"],
        "levelingGuideText": lvl_text,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")

    unknown_augs = sorted({a for c in comps for a in c["augments"] if norm(a) not in augments})
    unmatched_bm = [b["name"] for b in bm_comps if b["name"] not in bm_to_tfta]
    print(f"{len(comps)} TFT Academy comps ({sum(1 for c in comps if c['bm'])} matched to BunnyMuffins), "
          f"{len(augments)} augments ({sum(1 for a in augments.values() if a['guide'])} with guide notes), "
          f"{len(openers['rules'])} opener rules -> {OUTPUT}")
    if unmatched_bm:
        print("  BunnyMuffins comps with no TFT Academy match:", unmatched_bm)
    if unknown_augs:
        print("  TFT Academy augments not in the augment list:", unknown_augs)


if __name__ == "__main__":
    main()
