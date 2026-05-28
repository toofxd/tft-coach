# TFT Coach — How It Works

A plain-English walkthrough of every moving part. Read top-to-bottom and you'll
understand the whole system.

---

## The 60-second pitch

You play Teamfight Tactics. After a game you want to know: *did I make good
decisions, or did I throw?* This app pulls real Challenger/Grandmaster games
from the Riot API, computes "what good players do," and compares your games
against that baseline. It also has a stat calculator for the current set (you
pick a champion + items + traits, it tells you the resulting stats).

There are two main UIs:
- **`/calculator.html`** — the stat calculator + coach (the primary app today)
- **`/index.html`** — an older per-match coaching dashboard

And a Node.js server (`server.js`) that powers both.

---

## High-level flow

```
                    ┌──────────────────────────────────────────┐
                    │            Daily / on-demand             │
                    │                                          │
   Riot API ──► collect_pro.py ──► data/raw/matches/*.json    │
                                       │                       │
                                       ▼                       │
                                 features.py                   │
                                       │                       │
                          data/processed/match_features.csv    │
                          data/processed/item_winrates.csv     │
                                       │                       │
                                       ▼                       │
                                  train.py                     │
                                       │                       │
                                  models/*.pt, *.pkl           │
                    └──────────────────────────────────────────┘
                                       │
                                       ▼                            ┌────────────┐
   Browser  ──HTTP──►  server.js (Express, port 30002)  ◄──HTTP──►  │  Riot API  │
       ▲                       │                                    │   Gemini   │
       │                       │                                    │    Groq    │
       │                       ▼                                    │ tactics.tools│
       └──── serves /public/calculator.html ─────                   │ Community  │
                                                                    │   Dragon   │
                                                                    └────────────┘
```

Three independent things happen here:
1. **Data collection** (offline, scheduled): scrape Riot API → CSV
2. **Model training** (offline, after collection): CSV → PyTorch + sklearn models
3. **Serving** (always on): Node.js reads the CSVs + calls APIs in real time

---

## Component-by-component

### 1. Data collection — `src/collect_pro.py`

Calls the Riot API to download recent ranked TFT matches played by Challenger
and Grandmaster players on NA.

- **Step 1:** Hit `/tft/league/v1/challenger` and `.../grandmaster` to get the
  PUUIDs of every player in those tiers (~700 players total).
- **Step 2:** For each player, hit `/tft/match/v1/matches/by-puuid/{puuid}/ids`
  to get their last 20 ranked match IDs.
- **Step 3:** Deduplicate (top players play each other → lots of overlap).
- **Step 4:** For each *new* match ID, hit `/tft/match/v1/matches/{id}` to
  download the full game details (8 players × all units/items/traits).
- **Step 5:** Save each match as a JSON file in `data/raw/matches/`.

Safe to re-run — it skips matches already on disk.

Runs daily at 3 AM via Windows Task Scheduler (`TFT-Coach-DailyCollect`).

### 2. Feature engineering — `src/features.py`

Takes the ~10,000 raw match JSON files and turns them into a single CSV table
where each row is one player's outcome in one game (so ~80,000 rows).

For each player in each match it extracts:
- **Target:** `placement` (1–8), `top4` (boolean)
- **Economy:** `level`, `gold_left`, `last_round`, `level_efficiency` (level/round)
- **Comp:** `top_trait` (their highest-styled trait), `active_trait_count`, `unit_star_avg`
- **Items:** a JSON blob of `{champion_id: [item_ids]}` for the item win-rate table

It also builds two derived tables:
- `item_winrates.csv` — for each (champion, item_combo) pair, what % of games
  end in top-4. This powers the item recommendation API.
- `augment_winrates.csv` — same idea for augments. **Empty in Set 17** because
  Riot's match API doesn't include augments for this set.

### 3. Model training — `src/train.py`

Trains three models, but only one is actually used in the live app right now:

| Model | What it does | Used? |
|---|---|---|
| **MLP** (placement predictor) | Takes a player's features → predicts placement | Trained, not wired into UI |
| **K-Means** (comp clustering) | Groups games into 12 archetypes by trait+stats | Trained, not used |
| **LSTM** (economy sequence) | Predicts placement from per-round live capture | Untrained (need labeled sessions) |

The training output exists in `models/` but the live server doesn't load any of
them — coaching is currently driven by CSV lookups + AI prompts, not the
trained models. (See AUDIT.md → "Trained models unused.")

### 4. The web server — `server.js`

A Node.js Express server. Three things at startup:
1. Loads name mappings from Community Dragon (champion names, item names, trait names)
2. Loads `match_features.csv`, `item_winrates.csv`, and `tactics_tools_items.json` into memory
3. Starts listening on `127.0.0.1:30002` (or `0.0.0.0` on Railway)

Then it serves `/public/*` as static files (calculator.html, index.html) and
exposes ~10 API routes.

### 5. The UI — `public/calculator.html`

A single ~1,400-line HTML file with two tabs:

**Stat Calculator tab.** Pick a champion → pick items → pick trait breakpoints
→ see their resulting HP, AD, AS, etc. Powered entirely by
`calculator_data.json` (which is built from tactics.tools + Community Dragon).
Also shows the top item recommendations for that champion from our pro data, and
champion tips from Groq.

**Coach tab.** Type your Riot ID → loads your match history → shows banner
stats (avg placement, top-4 rate, wins) + AI coaching commentary from Gemini +
a free-form "Ask AI" box that hits Groq.

---

## The API surface

| Route | Purpose | Data source |
|---|---|---|
| `GET /api/profile?handle=Name%23TAG` | Your match history + stats banner | Riot API (live) |
| `POST /api/coaching` | Aggregate coaching text from Gemini | Gemini, fed your stats |
| `POST /api/coach` | Per-match coaching | Gemini + pro CSV |
| `GET /api/item-recs?unitId=X` | Top items for a champion | `item_winrates.csv` |
| `GET /api/items` | Overall item rankings | `tactics_tools_items.json` |
| `GET /api/champion-tips?...` | Champion-specific tips | Groq, fed item recs |
| `POST /api/ask` | Free-form Q&A | Groq |
| `GET /api/puuid?handle=...` | Resolve Riot ID → PUUID | Riot API |
| `GET /api/matches?puuid=...` | List recent match IDs | Riot API |

### Request lifecycle (example: loading the coach tab)

1. User types `toofxd#NA1` and hits search
2. UI calls `GET /api/profile?handle=toofxd%23NA1`
3. Server resolves the Riot ID → PUUID
4. Server fetches last 50 match IDs from Riot
5. Server fetches each match detail (in batches of 10 with 1.1s gaps to avoid rate limits)
6. Server filters to Set 17 only, extracts features, computes stats
7. Server returns `{ allStats, recentStats, games, topComps, synergies, ... }`
8. UI fills in the banner numbers
9. UI separately calls `POST /api/coaching` with the computed stats
10. Server builds a Gemini prompt with those numbers, gets back coaching text
11. UI renders the coaching text

---

## AI provider strategy — Gemini vs. Groq

The app talks to **two different LLM providers**, on purpose. The split isn't
random — each is used where its strengths fit.

| Endpoint | Provider | Model | Why |
|---|---|---|---|
| `/api/coaching` (aggregate) | Gemini | gemini-2.5-flash | Reasoning depth |
| `/api/coach` (per-match) | Gemini | gemini-2.5-flash | Reasoning depth |
| `/api/champion-tips` | Groq | llama-3.3-70b-versatile | Speed |
| `/api/ask` (free-form) | Groq | llama-3.3-70b-versatile | Speed |

### The principle

**Gemini → analytical tasks where output quality matters more than latency.**
The coaching endpoints feed in a lot of structured data (placement averages,
top-4 rate, gold left, comp-by-comp breakdowns, pro comparisons, item issues)
and need to synthesize prioritized, multi-point advice. That's multi-variable
reasoning — Gemini 2.5 Flash handles it noticeably better than LLaMA. Takes
3–8 seconds; users tolerate it because coaching is a "submit and wait" action.

**Groq → fast user-triggered actions where latency is the UX.**
Champion tips fire on every champion click in the calculator. If they took
five seconds the UX would feel broken. Groq runs LLaMA on custom inference
hardware (LPUs) and is genuinely ~10× faster than typical LLM endpoints — most
responses come back in under a second. The Ask AI box benefits from the same
snappiness.

### Why not consolidate to one provider?

You could, but each option has a cost:

- **All Gemini** — consistent voice, but champion tips become slow (3+ sec) and
  rate limits start hurting on heavy clicking sessions.
- **All Groq** — instant everything, but coaching loses depth. LLaMA 3.3 is a
  strong model, just not as good as Gemini at "find the meta-pattern across 20
  games of mixed data."
- **Current split** — best UX, no single point of failure, but two slightly
  different "voices" in the app (Gemini is more measured; LLaMA is more casual).

### Free-tier rate limits — practical implications

| Provider | Requests/min | Requests/day |
|---|---|---|
| Gemini (free) | ~15 | ~1,500 |
| Groq (free) | ~30 | ~14,400 |

Groq's higher ceiling matters because champion tips fire on every click — a
single calculator session can easily generate 20+ tip requests. Coaching only
fires on profile load, so 1,500/day is plenty for personal use.

### Redundancy benefit

The two-provider split also means the app degrades gracefully. If Gemini is
rate-limited or down, the calculator's item recs + tips + Ask AI all still
work via Groq. Only the coaching tab breaks. Vice versa for Groq outages.

---

## Build pipeline (data file → UI)

The stat calculator's static data (champions, items, traits) comes from two
sources merged together by `src/build_calculator_data.py`:

- `ap.tft.tools/static/s17/data.js` — base stats, costs, item effects
- `raw.communitydragon.org/.../en_us.json` — ability text, trait breakpoints,
  champion-to-trait mappings

The script merges them into `data/static/calculator_data.json`, then
`src/build_calculator.py` injects that JSON into `calculator.html`.

⚠️ **The injection uses string split, not regex.** Regex `re.sub` corrupts the
`\n` escape sequences in the JSON and breaks the JavaScript. Don't change that.

⚠️ **There are two `calculator.html` files.** The one in `/public` is the live
served file. The one at the project root is the source template (older copy).
All UI edits go to `/public/calculator.html`.

---

## External dependencies

| Service | What for | Cost |
|---|---|---|
| **Riot Games API** | Match data, your match history | Free (dev key, 24h rotating) |
| **Google Gemini** | AI coaching analysis | Free tier |
| **Groq (LLaMA 3.3 70B)** | Champion tips + free-form Q&A | Free tier |
| **Community Dragon** | Champion/item/trait names + abilities | Free, public CDN |
| **tactics.tools** | Set 17 base stats + item win rates | Free, scraped from public CDN |

Riot dev keys expire every 24 hours — when API calls return 401/403, renew at
developer.riotgames.com and update `.env`.

---

## Where the data lives

```
data/
├── raw/matches/              ~10,000 JSON files, one per match. Don't delete — the cache.
├── processed/
│   ├── match_features.csv    ~80k rows. Main training input + comp-level lookups.
│   ├── item_winrates.csv     Per-(champion, item_combo) top-4 rate. Powers item recs.
│   ├── augment_winrates.csv  Empty for Set 17 (augments not in API response).
│   └── tactics_tools_items.json  Diamond+ item rankings scraped from tactics.tools.
├── static/
│   └── calculator_data.json  Injected into calculator.html at build time.
├── live/                     LSTM training data (empty — feature not used).
└── my_matches/               Personal match dumps for `my_features.csv` (dead path).

models/                       PyTorch + sklearn pickles. Trained but not loaded by server.
public/                       What the server serves.
src/                          All Python scripts.
logs/                         Daily collection logs.
```

---

## When something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Profile load fails with 401/403 | Riot dev key expired | Renew at developer.riotgames.com, update `.env` |
| Coaching says "no text" | Gemini hit rate limit | Wait, or fall back to Groq |
| Item recs are stale | New patch, haven't re-collected | Run daily collection task |
| Calculator shows wrong stats | `calculator_data.json` out of date | Re-run `build_calculator_data.py` |
| Calculator UI looks unchanged after edit | Edited root `calculator.html` instead of `public/calculator.html` | Edit `public/calculator.html` |
