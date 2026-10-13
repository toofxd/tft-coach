"""
Merges tactics.tools stats with Community Dragon trait/cost data
into a single calculator_data.json for the HTML calculator.

Usage: python src/build_calculator_data.py
"""

import json
import re
import requests
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "data" / "static"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://tactics.tools/"}

STAT_KEY_MAP = {
    "AD": "ad", "Health": "hp", "BonusHealth": "hp", "ExtraHealth": "hp",
    "Armor": "armor", "MagicResist": "mr", "AP": "ap",
    "AttackSpeed": "as", "AS": "as", "BonusAttackSpeed": "as",
    "CritChance": "critChance", "ManaRegen": "manaRegen",
    "Omnivamp": "omnivamp", "BonusOmnivamp": "omnivamp",
    "LifeSteal": "lifeSteal", "DamageReduction": "dmgReduction",
    "BonusArmorMR": "armorMR",  # grants both armor and MR
}

# Standard TFT star-level HP and AD multipliers
STAR_MULT = {1: 1.0, 2: 1.8, 3: 3.24}


def fetch_tactics_data():
    r = requests.get("https://ap.tft.tools/static/s18/data.js", headers=HEADERS, timeout=15)
    r.raise_for_status()
    match = re.search(r'window\.data18\s*=\s*JSON\.parse\(`(.*?)`\)', r.text, re.DOTALL)
    return json.loads(match.group(1))


def fetch_en_locale():
    r = requests.get("https://ap.tft.tools/static/s18/en.js", headers=HEADERS, timeout=15)
    r.raise_for_status()
    match = re.search(r'window\.s18Unitsi18n\s*=\s*(\{.*?\});?\s*window\.', r.text, re.DOTALL)
    return json.loads(match.group(1)) if match else {}


def fetch_cdragon_data():
    r = requests.get(
        "https://raw.communitydragon.org/latest/cdragon/tft/en_us.json",
        headers={"User-Agent": "Mozilla/5.0"}, timeout=30
    )
    r.raise_for_status()
    data = r.json()
    set_data = next(s for s in data["setData"] if s.get("mutator") == "TFTSet18")
    set_data["allItems"] = data["items"]  # global list — holds this set's emblem recipes
    return set_data


# Component → numeric id used in item "from" arrays (matches EMBLEM_COMP_MAP in calculator.html)
COMPONENT_IDS = {
    "BFSword": 1, "RecurveBow": 2, "NeedlesslyLargeRod": 3, "TearOfTheGoddess": 4,
    "ChainVest": 5, "NegatronCloak": 6, "GiantsBelt": 7, "SparringGloves": 8,
    "Spatula": 9, "FryingPan": 10,
}


def build_emblems(cdragon_items, set_num):
    """Craftable emblems straight from cdragon — tactics.tools lags behind on new sets."""
    emblems = {}
    for it in cdragon_items:
        api = it["apiName"]
        if not re.search(rf"_{set_num}_Emblem[A-Z]", api):
            continue
        comps = [COMPONENT_IDS.get(c.split("_Component_")[-1]) for c in it.get("composition") or []]
        if len(comps) != 2 or None in comps:
            continue  # augment-only / non-craftable emblems
        emblems[api] = {
            "name": it["name"],
            "id": it.get("id"),
            "tags": ["CraftableEmblem"],
            "from": comps,
            "isAdaptive": False,
            "statBonuses": {},
            "allEffects": {},
            "icon": "https://raw.communitydragon.org/latest/game/"
                    + it["icon"].lower().replace(".tex", ".png"),
        }
    return emblems


def build_cdragon_craftables(cdragon_items, existing):
    """Completed items tactics.tools hasn't published yet for this set.
    Riot match data uses "DA_EdgeOfNight"; we key them as "EdgeOfNight" like tactics.tools."""
    base = {k: v for k, v in COMPONENT_IDS.items() if k not in ("Spatula", "FryingPan")}
    # Older-set copy of the same item, by display name (Edge of Night is "TFT_Item_GuardianAngel")
    by_name = {}
    for i in cdragon_items:
        if i.get("effects") and i["apiName"].startswith("TFT_Item_"):
            by_name.setdefault(i.get("name"), i)
    extra = {}
    for it in cdragon_items:
        api = it["apiName"]
        if not api.startswith("DA_") or "Emblem" in api:
            continue
        comps = [c.split("_Component_")[-1] for c in it.get("composition") or []]
        if len(comps) != 2 or not all(c in base for c in comps):
            continue
        key = api[len("DA_"):]
        if key in existing:
            continue
        # Set 18 items ship with empty effects in cdragon — borrow the standard item's stats
        effects = it.get("effects") or by_name.get(it["name"], {}).get("effects") or {}
        extra[key] = {
            "name": it["name"],
            # DamageReduction on borrowed items is a passive value (e.g. EoN's 100), not a stat
            "effects": {k: v for k, v in effects.items()
                        if v is not None and (it.get("effects") or k != "DamageReduction")},
            "tags": ["Craftable"],
            "from": [base[c] for c in comps],
        }
    items = build_items(extra)
    for key in items:
        api = "DA_" + key
        icon = next((i["icon"] for i in cdragon_items if i["apiName"] == api), None)
        if icon:
            items[key]["icon"] = ("https://raw.communitydragon.org/latest/game/"
                                  + icon.lower().replace(".tex", ".png"))
    return items


ROLE_LABEL = {
    "ADCarry": "AD Carry", "ADCaster": "AD Caster", "ADFighter": "AD Fighter",
    "ADReaper": "AD Reaper", "ADSpecialist": "AD Specialist", "ADTank": "AD Tank",
    "APCarry": "AP Carry", "APCaster": "AP Caster", "APFighter": "AP Fighter",
    "APReaper": "AP Reaper", "APTank": "AP Tank", "HFighter": "Hybrid Fighter",
}

ROLE_COLOR = {
    "AD": "#c0392b", "AP": "#8e44ad", "H": "#27ae60",
}

def role_tag(role):
    label = ROLE_LABEL.get(role, role)
    prefix = role[:2] if role else ""
    color = ROLE_COLOR.get(prefix, "#666")
    return {"label": label, "color": color}


def clean_ability_html(html, keep_conditional=False):
    """Strip XML tags, collapse whitespace, keep readable text.
    <scaleLevel> blocks are conditional (trait-gated) — strip unless keep_conditional=True.
    """
    if not keep_conditional:
        # Remove scaleLevel blocks (conditional trait upgrades)
        html = re.sub(r'<scaleLevel[^>]*>.*?</scaleLevel>', '', html, flags=re.DOTALL | re.IGNORECASE)
    else:
        # Just unwrap the tag, keep content
        html = re.sub(r'</?scaleLevel[^>]*>', '', html, flags=re.IGNORECASE)
    text = re.sub(r'<br\s*/?>', '\n', html, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Collapse extra spaces
    text = re.sub(r'[ \t]{2,}', ' ', text)
    return text.strip()


def clean_label_html(html):
    """Clean a detail-row label: strip HTML, unwrap scaleLevel to preserve icon tokens,
    and remove numeric formula clutter (e.g. '735 = 645 + 90'), leaving just the
    label name and scaling icons like %i:scaleAD%.
    """
    # Unwrap scaleLevel so icon tokens inside are preserved
    html = re.sub(r'</?scaleLevel[^>]*>', '', html, flags=re.IGNORECASE)
    # Strip all other HTML tags
    text = re.sub(r'<[^>]+>', '', html)
    text = re.sub(r'&nbsp;', ' ', text)
    # Remove standalone numbers (formula values like 735, 645, 90)
    text = re.sub(r'\b\d+(?:\.\d+)?\b', '', text)
    # Remove formula operators and punctuation: = + - ( )
    text = re.sub(r'[=()+\-]', ' ', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    # Deduplicate identical consecutive %i:xxx% icon tokens
    seen: list = []
    def dedup(m):
        tok = m.group(0)
        if tok in seen:
            return ''
        seen.append(tok)
        return tok
    text = re.sub(r'%i:[^%]+%', dedup, text)
    return re.sub(r'\s+', ' ', text).strip()


def build_units(tactics_units, cdragon_champs, en_locale):
    """Merge base stats (tactics.tools) with cost+traits+ability (cdragon+en)."""
    cd_by_api = {c["apiName"]: c for c in cdragon_champs}
    # Set 18: cdragon uses "DA_18_Ahri" while tactics.tools/Riot use "TFT18_Ahri",
    # so fall back to matching on normalized display name ("Lux (Lunar)" → "luxlunar")
    norm = lambda s: re.sub(r"[^a-z]", "", s.lower())
    cd_by_name = {norm(c["name"]): c for c in cdragon_champs if c.get("traits")}

    units = {}
    for api_name, tu in tactics_units.items():
        key_name = norm(re.sub(r"^TFT\d+_", "", api_name))
        cd = (cd_by_api.get(api_name) or cd_by_name.get(key_name)
              or cd_by_name.get(norm(tu["name"])) or {})
        base = tu["stats"]
        role = cd.get("role", "") or ""
        # Locale is keyed by the cdragon apiName in Set 18 ("DA_18_Ahri_desc")
        loc_key = api_name if f"{api_name}_desc" in en_locale else cd.get("apiName", api_name)

        # Ability info
        cd_ab = cd.get("ability", {})
        ab_name = en_locale.get(f"{loc_key}_ability") or cd_ab.get("name", "")
        raw_desc = en_locale.get(f"{loc_key}_desc") or cd_ab.get("desc", "")
        ab_desc = clean_ability_html(raw_desc)
        # Store the conditional (scaleLevel) block separately if it exists
        cond_match = re.search(r'<scaleLevel[^>]*>(.*?)</scaleLevel>', raw_desc, re.DOTALL | re.IGNORECASE)
        ab_desc_cond = clean_ability_html(cond_match.group(1), keep_conditional=True) if cond_match else None

        # Detail rows: label + [1★, 2★, 3★] values from tactics details array
        details = []
        tu_details = tu.get("ability", {}).get("details", [])
        for i, vals in enumerate(tu_details):
            if vals is None:
                continue
            label_html = en_locale.get(f"{loc_key}_details_{i}", "")
            label = clean_label_html(label_html) if label_html else f"Value {i+1}"
            details.append({"label": label, "values": vals})

        units[api_name] = {
            "name": tu["name"],
            "cost": cd.get("cost", 0),
            "traits": cd.get("traits", []),
            "cdId": cd.get("apiName", api_name),  # Riot match data uses this ID in Set 18
            "role": role,
            "roleTag": role_tag(role),
            "stats": {
                "hp": base["hp"],
                "ad": base["damage"],
                "armor": base["armor"],
                "mr": base["magicResist"],
                "as": base["attackSpeed"],
                "mana": base["mana"],
                "initialMana": base["initialMana"],
                "range": int(base["range"]),
                "critChance": base["critChance"],
                "critMultiplier": base["critMultiplier"],
            },
            "starMult": STAR_MULT,
            "ability": {
                "name": ab_name,
                "desc": ab_desc,
                "descCond": ab_desc_cond,   # only shown when trait capstone active
                "mana": f"{int(base['initialMana'])}/{int(base['mana'])}",
                "details": details,
            },
        }
    return units


STAT_ICON_TEXT = {"scaleAS": "Attack Speed", "scaleAP": "AP", "scaleAD": "AD", "scaleHealth": "Health",
                  "scaleArmor": "Armor", "scaleMR": "MR", "scaleMana": "Mana", "scaleCrit": "Crit"}


def render_trait_desc(cd):
    """Plain-text trait description with @Var@ placeholders filled per breakpoint.
    Each <row> lines up with one entry in cd["effects"]; unknown variables become "X"
    (cdragon hashes some names, e.g. {0f90e7a4})."""
    effects = cd.get("effects") or []

    def fill(text, vars_, min_units):
        def sub(m):
            name, mult = m.group(1), m.group(2)
            if name == "MinUnits":
                return str(min_units) if min_units is not None else "X"
            val = vars_.get(name)
            if val is None:
                return "X"
            val = val * float(mult) if mult else val
            return f"{val:.0f}" if abs(val - round(val)) < 0.05 else f"{val:.1f}"
        return re.sub(r"@([A-Za-z0-9_]+)(?:\*(\d+(?:\.\d+)?))?@", sub, text)

    desc = cd.get("desc") or ""
    rows = re.findall(r"<row>(.*?)</row>", desc, re.DOTALL)
    header = re.sub(r"<row>.*?</row>", "", desc, flags=re.DOTALL)
    first_vars = effects[0].get("variables", {}) if effects else {}
    parts = [fill(header, first_vars, None)]
    for i, row in enumerate(rows):
        eff = effects[i] if i < len(effects) else {}
        parts.append(fill(row, eff.get("variables", {}), eff.get("minUnits")))
    text = " ".join(parts)
    text = re.sub(r"%i:([A-Za-z]+)%", lambda m: STAT_ICON_TEXT.get(m.group(1), ""), text)
    text = re.sub(r"<br\s*/?>", " ", text)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\s+", " ", text).strip()


def build_traits(tactics_traits, cdragon_traits):
    """Build trait breakpoints from Community Dragon (more complete)."""
    # cdragon apiName → tactics name mapping
    cd_by_api = {t["apiName"]: t for t in cdragon_traits}

    traits = {}
    for api_name in tactics_traits:
        cd = cd_by_api.get(api_name)
        if not cd:
            continue

        breakpoints = []
        for effect in cd.get("effects", []):
            bp = {
                "minUnits": effect["minUnits"],
                "maxUnits": effect["maxUnits"],
                "style": effect.get("style", 1),
                "bonuses": {},
            }
            vars_ = effect.get("variables", {})

            # Map known stat variables
            # TeamwideResists is a flat bonus ALL units (including this unit) receive
            teamwide = vars_.get("TeamwideResists", 0)
            if "BonusArmor" in vars_:
                bp["bonuses"]["armor"] = vars_["BonusArmor"] + teamwide
            if "BonusMR" in vars_:
                bp["bonuses"]["mr"] = vars_["BonusMR"] + teamwide
            # If trait only has teamwide resists (no per-unit bonus keys)
            if teamwide and "BonusArmor" not in vars_ and "BonusMR" not in vars_:
                bp["bonuses"]["armor"] = teamwide
                bp["bonuses"]["mr"] = teamwide
            if "BonusAD" in vars_ or "AD" in vars_:
                bp["bonuses"]["ad"] = vars_.get("BonusAD", vars_.get("AD", 0))
            if "BonusAP" in vars_ or "AP" in vars_:
                raw_ap = vars_.get("BonusAP", vars_.get("AP", 0))
                ad_val = bp["bonuses"].get("ad", 0)
                # AP stored as whole-number % when AD is already decimal (e.g. AP=12, AD=0.12)
                if ad_val and 0 < ad_val < 1 and round(ad_val * 100) == round(raw_ap):
                    raw_ap = raw_ap / 100
                bp["bonuses"]["ap"] = raw_ap
            if "BonusHealth" in vars_ or "Health" in vars_:
                bp["bonuses"]["hp"] = vars_.get("BonusHealth", vars_.get("Health", 0))
            if "BonusAS" in vars_ or "AttackSpeed" in vars_:
                bp["bonuses"]["as"] = vars_.get("BonusAS", vars_.get("AttackSpeed", 0))

            # Store all raw variables for display
            bp["variables"] = vars_
            breakpoints.append(bp)

        traits[api_name] = {
            "name": cd["name"],
            "apiName": api_name,
            "desc": render_trait_desc(cd),
            "breakpoints": breakpoints,
        }
    return traits


def build_items(tactics_items):
    """Clean item data — map effect keys to stat names."""
    items = {}
    for key, item in tactics_items.items():
        effects = item.get("effects", {})
        stat_bonuses = {}
        raw_effects = {}

        for eff_key, val in effects.items():
            mapped = STAT_KEY_MAP.get(eff_key)
            if mapped:
                stat_bonuses[mapped] = stat_bonuses.get(mapped, 0) + val
            # Skip hash keys like {1543aa48}
            if not eff_key.startswith("{"):
                raw_effects[eff_key] = val

        # Adaptive: item grants both AD% and flat AP where AP == AD%*100
        ad_val = stat_bonuses.get("ad", 0)
        ap_val = stat_bonuses.get("ap", 0)
        is_adaptive = (0 < ad_val < 1 and ap_val > 0 and round(ad_val * 100) == round(ap_val))

        items[key] = {
            "name": item["name"],
            "id": item.get("id"),
            "tags": item.get("tags", []),
            "from": item.get("from", []),
            "isAdaptive": is_adaptive,
            "statBonuses": stat_bonuses,
            "allEffects": raw_effects,
        }
    return items


def main():
    print("Fetching tactics.tools data...")
    tactics = fetch_tactics_data()

    print("Fetching Community Dragon data...")
    cdragon = fetch_cdragon_data()

    print("Fetching en locale...")
    en_locale = fetch_en_locale()

    print("Building calculator data...")
    units = build_units(tactics["units"], cdragon["champions"], en_locale)
    traits = build_traits(tactics["traits"], cdragon["traits"])
    items = build_items(tactics["items"])
    # Drop leftovers from older sets ("17AstronautEmblemItem") and add this set's emblems
    set_num = str(cdragon["number"])
    items = {k: v for k, v in items.items()
             if not (re.match(r"\d\d\D", k) and k[:2] != set_num)}
    items.update(build_emblems(cdragon["allItems"], set_num))
    items.update(build_cdragon_craftables(cdragon["allItems"], items))

    out = {"units": units, "traits": traits, "items": items}
    path = OUTPUT_DIR / "calculator_data.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(f"Saved {len(units)} units, {len(traits)} traits, {len(items)} items")
    print(f"Output: {path}")

    print("Injecting into calculator.html...")
    import subprocess
    subprocess.run(["python", str(Path(__file__).parent / "build_calculator.py")], check=True)


if __name__ == "__main__":
    main()
