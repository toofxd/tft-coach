"""
query_tftacademy.py — reads TFT Academy's local SQLite DB and returns a structured
round-by-round game summary as JSON.

Usage:
    python src/query_tftacademy.py --match_id NA1_5569226353
    python src/query_tftacademy.py --match_ids NA1_XXX,NA1_YYY   # aggregate summary

DB path: reads TFTACADEMY_DB env var, then falls back to the default Windows location.
"""

import sqlite3
import json
import sys
import os
import re
import argparse
from pathlib import Path


def get_db_path():
    env = os.environ.get("TFTACADEMY_DB")
    if env:
        return env
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        return str(Path(appdata) / "TFTAcademy" / "tft-events.db")
    # Last resort: known absolute path
    return r"C:\Users\Tiffany\AppData\Roaming\TFTAcademy\tft-events.db"


def open_db():
    path = get_db_path()
    if not os.path.exists(path):
        return None
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def fmt_name(raw):
    """TFT17_Augment_TourOfTheGalaxy → Tour Of The Galaxy"""
    name = re.sub(r"^TFT\d*_Augment_", "", raw)
    # Strip trailing tier digit (GroupHug1 → GroupHug)
    name = re.sub(r"\d+$", "", name)
    # Split camelCase
    name = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", name)
    return name.strip()


def is_augment(raw):
    """Only include actual augments, not ChampionItem, Emblem, etc."""
    return bool(re.match(r"TFT\d*_Augment_", raw))


def fmt_unit(raw):
    """TFT17_Caitlyn → Caitlyn"""
    return re.sub(r"^TFT\d+_", "", raw)


def parse_int(val):
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def query_game(conn, match_id):
    cur = conn.cursor()
    cur.execute(
        "SELECT id, final_placement FROM games WHERE match_id=?", (match_id,)
    )
    row = cur.fetchone()
    if not row:
        return None
    game_id, placement = row

    cur.execute(
        """
        SELECT event_type, round, key, data, timestamp
        FROM events
        WHERE game_id=?
        ORDER BY timestamp
        """,
        (game_id,),
    )
    events = cur.fetchall()

    # --- Collect raw data -----------------------------------------------
    gold_by_round = {}      # round -> list[int]
    xp_events = []          # (round, level)
    health_by_round = {}    # round -> list[int]
    augment_history = []    # list of (round, {slot: name})
    board_by_round = {}     # round -> [unit_name, ...]

    for etype, rnd, key, data_str, ts in events:
        try:
            data = json.loads(data_str) if data_str else None
        except Exception:
            data = data_str

        if etype == "me":
            if key == "gold" and rnd:
                v = parse_int(data)
                if v is not None:
                    gold_by_round.setdefault(rnd, []).append(v)

            elif key == "xp" and rnd and isinstance(data, dict):
                lvl = parse_int(data.get("level"))
                if lvl:
                    xp_events.append((rnd, lvl))

            elif key == "health" and rnd:
                v = parse_int(data)
                if v is not None:
                    health_by_round.setdefault(rnd, []).append(v)

            elif key == "picked_augment" and rnd and isinstance(data, dict):
                slots = {
                    slot: v["name"]
                    for slot, v in data.items()
                    if isinstance(v, dict) and v.get("name") and is_augment(v["name"])
                }
                augment_history.append((rnd, slots))

        elif etype == "board" and key == "board_pieces" and rnd and isinstance(data, dict):
            units = [
                fmt_unit(v["name"])
                for v in data.values()
                if isinstance(v, dict) and v.get("name")
            ]
            board_by_round[rnd] = units

    # --- Level-up events (deduplicated) ---------------------------------
    seen_levels = {}
    for rnd, lvl in xp_events:
        if lvl not in seen_levels:
            seen_levels[lvl] = rnd
    levels = [{"level": lvl, "round": rnd} for lvl, rnd in sorted(seen_levels.items())]

    # --- Gold: max per round (what you had before spending) -------------
    gold_summary = {}
    for rnd, vals in gold_by_round.items():
        if vals:
            gold_summary[rnd] = {"max": max(vals), "min": min(vals)}

    # --- Health: first reading per round --------------------------------
    health_snapshots = []
    seen_hp_rounds = set()
    for rnd, vals in sorted(health_by_round.items()):
        if rnd not in seen_hp_rounds and vals:
            health_snapshots.append({"round": rnd, "hp": vals[0]})
            seen_hp_rounds.add(rnd)

    # --- Augments: extract what was newly added at each augment round ---
    augments = []
    prev_slots = {}
    for rnd, slots in augment_history:
        for slot, name in slots.items():
            if name and slots.get(slot) != prev_slots.get(slot):
                augments.append({"round": rnd, "name": fmt_name(name), "raw": name})
        prev_slots = slots
    # Deduplicate: keep only unique (round, name) pairs
    seen_aug = set()
    deduped = []
    for a in augments:
        key = (a["round"], a["name"])
        if key not in seen_aug:
            seen_aug.add(key)
            deduped.append(a)
    augments = deduped

    # --- Board snapshots at key rounds ----------------------------------
    KEY_ROUNDS = {"2-1", "3-1", "3-2", "4-1", "4-2", "5-1"}
    board_snapshots = {
        rnd: units
        for rnd, units in board_by_round.items()
        if rnd in KEY_ROUNDS and units
    }

    return {
        "match_id": match_id,
        "placement": placement,
        "levels": levels,
        "gold_by_round": gold_summary,
        "augments": augments,
        "health_snapshots": health_snapshots,
        "board_snapshots": board_snapshots,
    }


def aggregate_games(conn, match_ids):
    """Summarise TFT Academy data across multiple games for aggregate coaching."""
    games = [g for mid in match_ids if (g := query_game(conn, mid)) is not None]
    if not games:
        return None

    # Level timing: when does each level typically get hit?
    level_rounds = {}
    for g in games:
        for le in g["levels"]:
            level_rounds.setdefault(le["level"], []).append(le["round"])

    # Gold extremes: average max gold held per round
    rolling_games = []
    for g in games:
        gold = g["gold_by_round"]
        heavy_roll_rounds = [
            rnd for rnd, v in gold.items()
            if v["max"] - v["min"] >= 20
        ]
        if heavy_roll_rounds:
            rolling_games.append({"match_id": g["match_id"], "rounds": heavy_roll_rounds})

    # Augments across games
    all_augments = []
    for g in games:
        all_augments.extend(g["augments"])

    # Health: games where HP dropped below 40 before stage 4
    early_bleed = [
        g["match_id"]
        for g in games
        if any(
            s["hp"] < 40 and s["round"].startswith(("2-", "3-"))
            for s in g["health_snapshots"]
        )
    ]

    return {
        "games_found": len(games),
        "match_ids": [g["match_id"] for g in games],
        "level_timing": {
            str(lvl): rounds for lvl, rounds in sorted(level_rounds.items())
        },
        "heavy_roll_rounds": rolling_games,
        "augments": all_augments,
        "early_bleed_games": early_bleed,
        "placements": [g["placement"] for g in games if g["placement"]],
    }


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--match_id", help="Single match ID")
    group.add_argument("--match_ids", help="Comma-separated match IDs for aggregate")
    args = parser.parse_args()

    conn = open_db()
    if not conn:
        print("null")
        sys.exit(0)

    try:
        if args.match_id:
            result = query_game(conn, args.match_id)
        else:
            ids = [m.strip() for m in args.match_ids.split(",") if m.strip()]
            result = aggregate_games(conn, ids)

        print(json.dumps(result) if result else "null")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
