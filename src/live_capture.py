"""
Live per-round data capture using the Riot Live Client API.
Run this script BEFORE/during a TFT game on your machine.
Polls https://127.0.0.1:2999/liveclientdata/allgamedata every 30 seconds
and saves snapshots to data/live/session_{timestamp}.json.

Usage:
    python src/live_capture.py

Stop it with Ctrl+C when your game ends. The session file is written on exit.
"""

import json
import os
import ssl
import time
import urllib.request
from datetime import datetime
from pathlib import Path

LIVE_DIR = Path(__file__).parent.parent / "data" / "live"
LIVE_DIR.mkdir(parents=True, exist_ok=True)

LIVE_API = "https://127.0.0.1:2999/liveclientdata/allgamedata"
POLL_INTERVAL = 30  # seconds between snapshots

# The Live Client uses a self-signed cert — disable verification for localhost only
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


def _fetch_live() -> dict | None:
    """Fetch the current game state from the local Live Client API."""
    try:
        with urllib.request.urlopen(LIVE_API, context=_ssl_ctx, timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _parse_snapshot(raw: dict, timestamp: float) -> dict | None:
    """
    Extract the TFT-relevant fields from a Live Client response.
    Returns None if this doesn't look like an active TFT game.
    """
    game_data = raw.get("gameData", {})
    game_mode = game_data.get("gameMode", "")

    # Live Client uses "TFT" as the game mode string
    if "TFT" not in game_mode.upper() and game_mode != "":
        return None

    active_player = raw.get("activePlayer", {})
    all_players = raw.get("allPlayers", [])

    # Best-effort extraction — field names can vary by patch
    gold = active_player.get("currentGold", 0)
    level = active_player.get("level", 1)
    round_str = game_data.get("gameTime", 0)  # seconds elapsed; convert below

    # Find our player in allPlayers to get board units
    summoner_name = active_player.get("summonerName", "")
    our_player = next(
        (p for p in all_players if p.get("summonerName") == summoner_name),
        {},
    )
    units_on_board = len(our_player.get("items", []))  # proxy for board size

    return {
        "timestamp": timestamp,
        "game_time_s": round_str,
        "round": _game_time_to_round(round_str),
        "gold": gold,
        "level": level,
        "units_on_board": units_on_board,
        "xp": active_player.get("experience", {}).get("currentXP", 0),
        "xp_to_next": active_player.get("experience", {}).get("xpToNextLevel", 0),
    }


def _game_time_to_round(seconds: float) -> str:
    """
    Approximate TFT round from game time. TFT rounds are ~35s each.
    Stage 1 starts at 0s; each stage has 3–7 rounds.
    This is a best-effort approximation — live events would be more accurate.
    """
    if seconds <= 0:
        return "1-1"
    # Each round is roughly 35s; stages have varying round counts
    round_num = int(seconds // 35) + 1
    stage = max(1, round_num // 4)
    within_stage = (round_num % 4) + 1
    return f"{stage}-{within_stage}"


def capture(poll_interval: int = POLL_INTERVAL) -> None:
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = LIVE_DIR / f"session_{session_id}.json"
    snapshots: list[dict] = []

    print(f"Live capture started. Session: {session_id}")
    print(f"Polling every {poll_interval}s. Press Ctrl+C to stop.\n")
    print("Waiting for TFT game to start...")

    try:
        while True:
            raw = _fetch_live()
            if raw is None:
                print("  No active game detected — retrying...")
                time.sleep(poll_interval)
                continue

            snap = _parse_snapshot(raw, time.time())
            if snap is None:
                print("  Game detected but not TFT — retrying...")
                time.sleep(poll_interval)
                continue

            snapshots.append(snap)
            print(
                f"  [{snap['round']}] gold={snap['gold']}  "
                f"level={snap['level']}  units={snap['units_on_board']}"
            )
            time.sleep(poll_interval)

    except KeyboardInterrupt:
        print("\nCapture stopped.")

    finally:
        if snapshots:
            out_path.write_text(json.dumps(snapshots, indent=2))
            print(f"Saved {len(snapshots)} snapshots to {out_path}")
        else:
            print("No snapshots captured — nothing saved.")


if __name__ == "__main__":
    capture()
