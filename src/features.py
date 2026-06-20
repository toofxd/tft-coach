"""
Feature engineering for TFT match data.

Two sources:
  - build_match_features(): end-of-game data from Riot Match API
  - build_live_features(): per-round sequences from live_capture.py sessions
"""

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

RAW_DIR = Path(__file__).parent.parent / "data" / "raw" / "matches"
LIVE_DIR = Path(__file__).parent.parent / "data" / "live"
PROCESSED_DIR = Path(__file__).parent.parent / "data" / "processed"
PUBLIC_DIR = Path(__file__).parent.parent / "public"
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

# NOTE: Riot stripped augment data from TFT Set 17 match responses, so all
# augment-related fields have been removed from this pipeline. If augments
# return in a future set, restore from git history.


def _gini(values: list[float]) -> float:
    """Gini coefficient — 0 = perfectly equal, 1 = one unit has everything."""
    if not values or sum(values) == 0:
        return 0.0
    arr = sorted(values)
    n = len(arr)
    cumsum = np.cumsum(arr)
    return (2 * sum((i + 1) * v for i, v in enumerate(arr)) / (n * cumsum[-1])) - (n + 1) / n


def _top_trait(traits: list[dict]) -> str:
    """Return the name of the trait with the highest style value."""
    if not traits:
        return "unknown"
    active = [t for t in traits if t.get("style", 0) > 0]
    if not active:
        return "unknown"
    return max(active, key=lambda t: t.get("style", 0))["name"]


def _item_counts_per_unit(units: list[dict]) -> list[int]:
    """Return list of item counts for each unit (for Gini / concentration)."""
    return [len(u.get("itemNames", u.get("items", []))) for u in units]


def _unit_items_map(units: list[dict]) -> dict[str, list[str]]:
    """Return {character_id: [item_names]} for item recommender."""
    return {u["character_id"]: u.get("itemNames", u.get("items", [])) for u in units}


def _avg_unit_tier(units: list[dict]) -> float:
    return float(np.mean([u.get("tier", 1) for u in units])) if units else 1.0


def _active_trait_count(traits: list[dict]) -> int:
    return sum(1 for t in traits if t.get("style", 0) > 0)


def extract_participant_features(p: dict) -> dict:
    """
    Extract a flat feature dict from one match participant record.
    `p` is a ParticipantDto from the Riot TFT Match API.
    """
    level = p.get("level", 1)
    gold_left = p.get("gold_left", 0)
    last_round = p.get("last_round", 1)
    placement = p.get("placement", 8)
    traits = p.get("traits", [])
    units = p.get("units", [])

    level_efficiency = level / max(last_round, 1)
    item_counts = _item_counts_per_unit(units)
    item_concentration = _gini(item_counts)

    return {
        # Target
        "placement": placement,
        "top4": int(placement <= 4),
        # Economy proxies
        "level": level,
        "gold_left": gold_left,
        "last_round": last_round,
        "level_efficiency": level_efficiency,
        # Comp
        "top_trait": _top_trait(traits),
        "active_trait_count": _active_trait_count(traits),
        "unit_star_avg": _avg_unit_tier(units),
        "unit_count": len(units),
        "item_concentration": item_concentration,
        # Combat
        "damage_to_players": p.get("total_damage_to_players", 0),
        "players_eliminated": p.get("players_eliminated", 0),
        # Raw blobs for item recommender (stored as JSON strings)
        "_unit_items": json.dumps(_unit_items_map(units)),
        "_traits_raw": json.dumps([{"name": t["name"], "style": t.get("style", 0)} for t in traits]),
    }


def build_match_features(save: bool = True) -> pd.DataFrame:
    """
    Load all raw match JSON files and return a DataFrame of participant features.
    One row per participant (8 rows per match).
    """
    rows = []
    files = list(RAW_DIR.glob("*.json"))
    print(f"Loading {len(files)} match files...")

    for path in files:
        try:
            match = json.loads(path.read_text())
        except Exception:
            continue

        # Skip matches from other sets
        if match.get("info", {}).get("tft_set_number") != 17:
            continue

        match_id = match.get("metadata", {}).get("match_id", path.stem)
        game_version = match.get("info", {}).get("game_version", "")
        participants = match.get("info", {}).get("participants", [])

        for p in participants:
            feats = extract_participant_features(p)
            feats["match_id"] = match_id
            feats["game_version"] = game_version
            feats["puuid"] = p.get("puuid", "")
            rows.append(feats)

    df = pd.DataFrame(rows)
    print(f"Built feature table: {df.shape[0]} rows × {df.shape[1]} columns")

    if save:
        out = PROCESSED_DIR / "match_features.csv"
        df.to_csv(out, index=False)
        print(f"Saved to {out}")

    return df


# ---------------------------------------------------------------------------
# Item win-rate table (for recommender)
# ---------------------------------------------------------------------------

def build_item_winrates(df: pd.DataFrame) -> pd.DataFrame:
    """
    For each (unit, item) pair, compute top-4 rate across all games where
    that unit carried that item — regardless of what other items were equipped.
    Each game is counted once per unique item on the unit.
    """
    records = []
    for _, row in df.iterrows():
        unit_items = json.loads(row["_unit_items"])
        for unit_id, items in unit_items.items():
            for item_id in set(items):  # deduplicate doubled items within one game
                records.append({
                    "unit_id": unit_id,
                    "item_id": item_id,
                    "top4": row["top4"],
                    "placement": row["placement"],
                })

    item_df = pd.DataFrame(records, columns=["unit_id", "item_id", "top4", "placement"])
    if item_df.empty:
        print("No item data found — skipping item win-rate table.")
        return item_df
    result = (
        item_df.groupby(["unit_id", "item_id"])
        .agg(
            games=("top4", "count"),
            top4_rate=("top4", "mean"),
            avg_placement=("placement", "mean"),
        )
        .reset_index()
        .query("games >= 5")
        .sort_values(["unit_id", "top4_rate"], ascending=[True, False])
    )

    out = PROCESSED_DIR / "item_winrates.csv"
    result.to_csv(out, index=False)
    print(f"Item win-rate table: {result.shape[0]} rows -> {out}")
    return result


# ---------------------------------------------------------------------------
# Live session features (per-round sequences)
# ---------------------------------------------------------------------------

def build_live_features(session_path: Path) -> list[dict]:
    """
    Load a live capture session JSON and return a list of per-round feature dicts.
    Each dict represents one 30s snapshot during a game.
    """
    snapshots = json.loads(session_path.read_text())
    features = []
    prev_gold = None

    for snap in snapshots:
        gold = snap.get("gold", 0)
        roll_delta = max(0, (prev_gold or gold) - gold) if prev_gold is not None else 0
        prev_gold = gold

        features.append({
            "round_str": snap.get("round", ""),
            "gold": gold,
            "level": snap.get("level", 1),
            "units_on_board": snap.get("units_on_board", 0),
            "roll_delta": roll_delta,
            "timestamp": snap.get("timestamp", 0),
        })

    return features


MY_MATCHES_DIR = Path(__file__).parent.parent / "data" / "my_matches"


def build_my_features(save: bool = True) -> pd.DataFrame:
    """
    Build feature CSV from personal match files in data/my_matches/.
    Same schema as match_features.csv but only your games, with a source column.
    """
    files = list(MY_MATCHES_DIR.glob("*.json"))
    print(f"Loading {len(files)} personal match files...")
    rows = []
    MY_PUUID = __import__("os").getenv("MY_PUUID", "")

    for path in files:
        try:
            match = json.loads(path.read_text())
        except Exception:
            continue

        match_id = match.get("metadata", {}).get("match_id", path.stem)
        game_version = match.get("info", {}).get("game_version", "")
        game_datetime = match.get("info", {}).get("game_datetime", 0)
        participants = match.get("info", {}).get("participants", [])

        # Include all participants but flag which one is you
        for p in participants:
            feats = extract_participant_features(p)
            feats["match_id"] = match_id
            feats["game_version"] = game_version
            feats["game_datetime"] = game_datetime
            feats["puuid"] = p.get("puuid", "")
            feats["is_me"] = int(p.get("puuid", "") == MY_PUUID)
            rows.append(feats)

    df = pd.DataFrame(rows)
    print(f"Personal feature table: {df.shape[0]} rows × {df.shape[1]} columns ({df['is_me'].sum()} are your games)")

    if save and not df.empty:
        out = PROCESSED_DIR / "my_features.csv"
        df.to_csv(out, index=False)
        print(f"Saved to {out}")

    return df


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()

    # Training data
    df = build_match_features()
    if not df.empty:
        build_item_winrates(df)

        # Write dataset_info.json for the About page
        count_k = f"~{round(len(df) / 1000)}k"
        d = date.today()
        updated = f"{d.day} {d.strftime('%B %Y')}"
        info = {"matchCount": len(df), "matchCountLabel": count_k, "updatedDate": updated}
        info_path = PUBLIC_DIR / "dataset_info.json"
        info_path.write_text(json.dumps(info))
        print(f"Dataset info written: {count_k} matches, {updated}")

    # Personal data
    build_my_features()
