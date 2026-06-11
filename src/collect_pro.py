"""
Collect TFT match data from Challenger/GM players via Riot Match API.
Saves raw JSON to data/raw/matches/. Safe to re-run — skips already-fetched matches.
"""

import json
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()

API_KEY = os.getenv("RIOT_API_KEY")
if not API_KEY:
    raise RuntimeError("RIOT_API_KEY not set in .env")

RAW_DIR = Path(__file__).parent.parent / "data" / "raw" / "matches"
RAW_DIR.mkdir(parents=True, exist_ok=True)

# Regional routing: use AMERICAS for NA, EUROPE for EUW, ASIA for KR
REGIONAL_HOST = "https://americas.api.riotgames.com"
PLATFORM_HOST = "https://na1.api.riotgames.com"


def _get(url: str, params: dict = None, retries: int = 5) -> dict:
    """GET with exponential backoff on 429 and 5xx."""
    headers = {"X-Riot-Token": API_KEY}
    for attempt in range(retries):
        r = requests.get(url, headers=headers, params=params, timeout=10)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:
            retry_after = int(r.headers.get("Retry-After", 2 ** attempt))
            print(f"  Rate limited — sleeping {retry_after}s")
            time.sleep(retry_after)
        elif r.status_code in (500, 502, 503, 504):
            time.sleep(2 ** attempt)
        else:
            r.raise_for_status()
    raise RuntimeError(f"Failed after {retries} retries: {url}")


def get_tier_puuids(tier: str = "challenger") -> list[str]:
    """Return all PUUIDs for a given tier (challenger, grandmaster, master)."""
    url = f"{PLATFORM_HOST}/tft/league/v1/{tier}"
    data = _get(url)
    entries = data.get("entries", [])
    puuids = [e["puuid"] for e in entries if "puuid" in e]
    print(f"  {tier.capitalize()}: {len(puuids)} players")
    return puuids


TFT_SET = 17  # Only collect matches from this set

def get_match_ids(puuid: str, count: int = 20) -> list[str]:
    """Return up to `count` recent ranked TFT match IDs for a PUUID."""
    url = f"{REGIONAL_HOST}/tft/match/v1/matches/by-puuid/{puuid}/ids"
    return _get(url, params={"count": count, "queue": 1100})


def get_match(match_id: str) -> dict:
    """Fetch and return a match detail object."""
    url = f"{REGIONAL_HOST}/tft/match/v1/matches/{match_id}"
    return _get(url)


def fetch_match_cached(match_id: str) -> dict | None:
    """Return cached match if it exists, otherwise fetch and cache it.
    Skips and returns None for matches not from TFT_SET."""
    path = RAW_DIR / f"{match_id}.json"
    if path.exists():
        data = json.loads(path.read_text())
        if data.get("info", {}).get("tft_set_number") != TFT_SET:
            return None  # cached but wrong set — ignore
        return data
    try:
        data = get_match(match_id)
        if data.get("info", {}).get("tft_set_number") != TFT_SET:
            return None  # wrong set — don't cache, don't count
        path.write_text(json.dumps(data))
        return data
    except Exception as e:
        print(f"  Error fetching {match_id}: {e}")
        return None


def collect(
    tiers: list[str] = ("challenger", "grandmaster"),
    matches_per_player: int = 20,
    max_players: int = None,
) -> None:
    """
    Main collection loop. Fetches matches from top-tier players and saves to disk.

    Args:
        tiers: Which tiers to pull from.
        matches_per_player: How many recent matches per player.
        max_players: Cap on players sampled per tier. None = no cap (use all players).
                     Challenger typically ~200-250 players, GM ~400-500, Master ~1000+.
    """
    all_puuids: list[str] = []
    for tier in tiers:
        puuids = get_tier_puuids(tier)
        all_puuids.extend(puuids if max_players is None else puuids[:max_players])

    # Deduplicate
    all_puuids = list(set(all_puuids))
    print(f"\nTotal unique players: {len(all_puuids)}")

    # Collect match IDs
    match_ids: set[str] = set()
    print("Fetching match ID lists...")
    for puuid in tqdm(all_puuids):
        try:
            ids = get_match_ids(puuid, count=matches_per_player)
            match_ids.update(ids)
            time.sleep(0.05)  # stay well under rate limit
        except Exception as e:
            print(f"  Skipping {puuid[:12]}…: {e}")

    # Filter already-fetched
    new_ids = [m for m in match_ids if not (RAW_DIR / f"{m}.json").exists()]
    print(f"\nTotal unique matches: {len(match_ids)} ({len(new_ids)} new to fetch)")

    # Fetch match details
    fetched = 0
    print("Fetching match details...")
    for match_id in tqdm(new_ids):
        result = fetch_match_cached(match_id)
        if result:
            fetched += 1
        time.sleep(0.05)

    total = len(list(RAW_DIR.glob("*.json")))
    print(f"\nDone. Fetched {fetched} new matches. Total on disk: {total}")


if __name__ == "__main__":
    collect(matches_per_player=30)
