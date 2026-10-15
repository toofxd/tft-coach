require("dotenv").config();
const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { spawn } = require("child_process");
const placementModel = require("./src/placement_model");
const archetypes = require("./src/archetypes");

const app = express();
const PORT = process.env.PORT || 30002;

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "openai/gpt-oss-120b";  // llama-3.3-70b-versatile was retired by Groq (Oct 2026)

app.use(express.json());
// Set 17 pages moved to /17/ when Set 18 launched — keep old links working
app.get("/gods.html", (_req, res) => res.redirect(301, "/17/gods.html"));
app.use(express.static(path.join(__dirname, "public")));

// Name mappings load asynchronously at startup (CommunityDragon fetch). On
// serverless cold starts the exported app handles requests immediately, so gate
// /api until they're ready — otherwise AI prompts would use fallback IDs instead
// of real champion/trait names. In local dev this resolves before listen(), so
// there's no added latency.
const namesReady = loadNameMappings();
app.use("/api", (req, _res, next) => { namesReady.then(() => next()); });

app.get("/coach",      (_, res) => res.redirect(301, "/calculator.html#coach"));
app.get("/calculator", (_, res) => res.redirect(301, "/calculator.html"));

// Redirect root to the main app
app.get("/", (req, res) => {
  res.redirect("/about.html");
});

// ---------------------------------------------------------------------------
// Name mappings from Community Dragon (loaded at startup)
// ---------------------------------------------------------------------------

let champNames = {};  // { "DA_18_Ahri": "Ahri", ... }  (Set 18 Riot match IDs)
let itemNames = {};   // { "DA_EdgeOfNight": "Edge of Night", ... }
let traitNames = {};  // { "DA_18_Elderwood": "Elderwood", ... }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function loadNameMappings() {
  try {
    const raw = await httpsGet("https://raw.communitydragon.org/latest/cdragon/tft/en_us.json");
    const data = JSON.parse(raw);
    const sets = Object.keys(data.sets || {}).map(Number);
    const latestSet = Math.max(...sets).toString();
    const setData = data.sets[latestSet] || {};

    for (const champ of setData.champions || []) {
      if (champ.characterName && champ.name) champNames[champ.characterName] = champ.name;
    }
    for (const trait of setData.traits || []) {
      if (trait.apiName && trait.name) traitNames[trait.apiName] = trait.name;
    }
    for (const item of data.items || []) {
      if (item.apiName && item.name) itemNames[item.apiName] = item.name;
    }
    console.log(`Name mappings loaded: ${Object.keys(champNames).length} champs, ${Object.keys(itemNames).length} items, ${Object.keys(traitNames).length} traits`);
  } catch (e) {
    console.warn("Could not load name mappings:", e.message);
  }
}

// Fallbacks strip set prefixes: "TFT17_Galio", "DA_18_Ahri", "DA_Vi18"
function champName(id) { return champNames[id] || id.replace(/^TFT\d+_|^DA_(\d+_)?/, "").replace(/\d*(_A[DP])?$/, ""); }
function itemName(id) { return itemNames[id] || id.replace(/^DA_|TFT_Item_|TFT\d+_Item_/, "").replace(/([A-Z])/g, " $1").trim(); }
function traitName(id) { return traitNames[id] || id.replace(/^TFT\d+_|^DA_(\d+_)?/, "").replace(/\d+$/, ""); }

// ---------------------------------------------------------------------------
// Load processed CSV data at startup
// ---------------------------------------------------------------------------

function loadCsv(filename) {
  const filepath = path.join(__dirname, "data", "processed", filename);
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, "utf8");
  return parse(content, { columns: true, skip_empty_lines: true });
}

// Use slim CSV on hosted platforms (full file is 335MB — over GitHub's limit and
// over Vercel's serverless bundle limit). Full file is local-dev only.
const useSlimCsv = process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL;
const matchFeatureFile = useSlimCsv ? "match_features_slim.csv" : "match_features.csv";
const matchFeatures = loadCsv(matchFeatureFile);
const itemWinrates = loadCsv("item_winrates.csv");
console.log(`Loaded: ${matchFeatures.length} pro records, ${itemWinrates.length} item rows`);

// Pre-compute Challenger/GM benchmark averages once at startup.
// Efficiency/economy stats use top-4 games only — we want to model what winning looks like,
// not dilute it with losing patterns.
const challengerBench = (() => {
  const all = matchFeatures;
  if (!all.length) return null;
  const winners = all.filter(r => parseInt(r.top4) === 1);
  const w = winners.length;
  const avgLevelEff = winners.reduce((s, r) => s + parseFloat(r.level_efficiency || 0), 0) / w;
  const avgGoldLeft = winners.reduce((s, r) => s + parseFloat(r.gold_left || 0), 0) / w;
  const avgLevel    = winners.reduce((s, r) => s + parseFloat(r.level || 0), 0) / w;
  const top4Rate    = w / all.length;
  return { avgLevelEff, avgGoldLeft, avgLevel, top4Rate, games: all.length, winnerGames: w };
})();

// Placement MLP (src/train.py → models/mlp_weights.json) for counterfactual coaching.
// Missing file → coaching falls back to the static FOCUS AREAS.
const mlp = placementModel.loadModel();
console.log(mlp ? `Placement model: ${mlp.trained_on} games, val MAE ${mlp.val_mae}` : "Placement model: not found (run python src/train.py mlp)");

// Comp archetypes (src/train.py kmeans → models/archetypes.json): reroll / flex / fast 9,
// each with its own Challenger top-4 benchmarks.
const archetypeModel = archetypes.loadArchetypes();
console.log(archetypeModel ? `Archetypes: ${archetypeModel.archetypes.map(a => a.label).join(" / ")}` : "Archetypes: not found (run python src/train.py kmeans)");

// Pre-compute meta insights from the full Challenger/GM dataset.
// Used by /api/meta-insights — no Riot API dependency.
const metaInsights = (() => {
  const all = matchFeatures;
  if (!all.length) return null;

  // Group rows by top_trait
  const traitMap = {};
  for (const r of all) {
    const t = r.top_trait;
    if (!t) continue;
    if (!traitMap[t]) traitMap[t] = { games: 0, top4: 0, placementSum: 0 };
    traitMap[t].games++;
    if (parseInt(r.top4) === 1) traitMap[t].top4++;
    traitMap[t].placementSum += parseFloat(r.placement);
  }

  // Top comps sorted by top4 rate (min 100 games for significance; skip malformed/unknown traits)
  const topComps = Object.entries(traitMap)
    .filter(([trait, v]) => v.games >= 100 && trait && trait !== 'unknown' && /^(TFT|DA_)/.test(trait))
    .map(([trait, v]) => ({
      trait,
      games: v.games,
      top4Rate: v.top4 / v.games,
      avgPlacement: v.placementSum / v.games,
    }))
    .sort((a, b) => b.top4Rate - a.top4Rate)
    .slice(0, 8);

  // Helper averages
  const avg = (arr, key) => arr.reduce((s, r) => s + parseFloat(r[key] || 0), 0) / arr.length;

  const top1 = all.filter(r => parseInt(r.placement) === 1);
  const top4 = all.filter(r => parseInt(r.top4) === 1);
  const bot4 = all.filter(r => parseInt(r.top4) === 0);

  return {
    totalGames: all.length,
    topComps,
    benchmarks: {
      avgLevel:     { top4: avg(top4, 'level'),            bot4: avg(bot4, 'level') },
      avgGoldLeft:  { first: avg(top1, 'gold_left'),       top4: avg(top4, 'gold_left'),  bot4: avg(bot4, 'gold_left') },
      avgLevelEff:  { top4: avg(top4, 'level_efficiency'), bot4: avg(bot4, 'level_efficiency') },
      avgUnitStars: { top4: avg(top4, 'unit_star_avg'),    bot4: avg(bot4, 'unit_star_avg') },
    },
  };
})();

// Load calculator_data.json — authoritative Set 18 champion/trait/item data
// Used to ground AI prompts with accurate costs, traits, and roles.
const calcData = (() => {
  const p = path.join(__dirname, "data", "static", "calculator_data.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
})();

// Set 18 match data names units "DA_18_Ahri" while the calculator uses "TFT18_Ahri".
// Rewrite item_winrates.csv rows to calculator keys so /api/item-recs and
// proUnitStats() can keep filtering on the ID the page sends.
const cdToKey = {};
if (calcData) {
  for (const [key, u] of Object.entries(calcData.units)) if (u.cdId) cdToKey[u.cdId] = key;
  for (const r of itemWinrates) if (cdToKey[r.unit_id]) r.unit_id = cdToKey[r.unit_id];
}

// Variants with no rows of their own share a sibling's stats by display name —
// Riot records every Lux form (TFT18_Lux_Lunar, _Solar, ...) as base Lux.
const unitAlias = (() => {
  const alias = {};
  if (!calcData) return alias;
  const withRows = new Set(itemWinrates.map(r => r.unit_id));
  const byName = {};
  const base = n => n.replace(/ \(.*\)$/, "");  // "Lux (Lunar)" → "Lux"
  for (const [key, u] of Object.entries(calcData.units)) if (withRows.has(key)) byName[base(u.name)] = key;
  for (const [key, u] of Object.entries(calcData.units)) {
    if (!withRows.has(key) && byName[base(u.name)]) alias[key] = byName[base(u.name)];
  }
  return alias;
})();
// Accepts a calculator key ("TFT18_Lux_Lunar") or a Riot match ID ("DA_18_Ahri")
function resolveUnitId(id) {
  const key = cdToKey[id] || id;
  return unitAlias[key] || key;
}

// ---------------------------------------------------------------------------
// Archived sets — frozen data behind the /17/ pages (data/archive/<set>/).
// Endpoints take ?set=17; anything else means the current set.
// ---------------------------------------------------------------------------
const CURRENT_SET = 18;
// Patch label for AI prompts — TFT patches are numbered by set (18.4), not the LoL client version
const SET_PATCH = { 18: "patch 18.4", 17: "the final Set 17 patch" };
const archive = {};
for (const s of [17]) {
  const dir = path.join(__dirname, "data", "archive", String(s));
  const csvPath = path.join(dir, "item_winrates.csv");
  const dataPath = path.join(dir, "calculator_data.json");
  archive[s] = {
    itemWinrates: fs.existsSync(csvPath)
      ? parse(fs.readFileSync(csvPath, "utf8"), { columns: true, skip_empty_lines: true }) : [],
    calcData: fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, "utf8")) : null,
  };
  console.log(`Loaded Set ${s} archive: ${archive[s].itemWinrates.length} item rows`);
}
function setFrom(req) {
  const s = parseInt(req.query.set, 10);
  return archive[s] ? s : CURRENT_SET;
}
function winratesFor(set) { return set === CURRENT_SET ? itemWinrates : archive[set].itemWinrates; }
function calcDataFor(set) { return set === CURRENT_SET ? calcData : archive[set].calcData; }

// Compact champion sheet: one line per champion, for AI system prompts
const champSheet = calcData
  ? Object.values(calcData.units)
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(u => `${u.name} (${u.cost}g) | ${u.traits.join(", ")} | ${u.roleTag?.label || u.role}`)
      .join("\n")
  : null;

// Hidden traits: no champion carries them and they have no unit-count breakpoints, so the
// sheet below can't express how to unlock them. Update per set (hand-maintained).
const HIDDEN_TRAITS = {
  Eclipse: "hidden trait, no champion has it — turns on automatically with 3 Solar + 3 Lunar champions on the board; after 8 seconds of combat it kills the lowest-HP enemy, repeating about every 3.5 seconds",
};

// Compact trait sheet: name + valid breakpoints only. Deduplicate by name (keep the entry
// with the most breakpoints when there are multiple under the same display name).
const traitSheet = calcData
  ? (() => {
      const seen = {};
      for (const t of Object.values(calcData.traits)) {
        const bps = t.breakpoints.map(b => b.minUnits).filter(n => n != null);
        if (!bps.length) continue; // skip empty (e.g. Choose Trait) and hidden traits (listed below)
        if (!seen[t.name] || bps.length > seen[t.name].bps.length) seen[t.name] = { name: t.name, bps };
      }
      const sheet = Object.values(seen)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(t => `${t.name} (${t.bps.join("/")})`)
        .join(", ");
      const hidden = Object.entries(HIDDEN_TRAITS).map(([n, how]) => `${n}: ${how}`).join("; ");
      return hidden ? `${sheet}
Hidden traits — ${hidden}` : sheet;
    })()
  : null;

// Compact item sheet: craftable items with primary stat bonuses only.
// Whitelist avoids leaking raw engine variables (AS multipliers, dmgReduction, etc.).
const ITEM_STAT_LABELS = { hp: "HP", ad: "% AD", ap: "AP", armor: "armor", mr: "MR", manaRegen: "mana/s" };
const itemSheet = calcData
  ? Object.entries(calcData.items)
      .filter(([, v]) => v.tags?.includes("Craftable"))
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([, v]) => {
        const bonuses = Object.entries(v.statBonuses || {})
          .filter(([stat]) => stat in ITEM_STAT_LABELS)
          .map(([stat, val]) => {
            const label = ITEM_STAT_LABELS[stat];
            const display = stat === "ad" ? `+${Math.round(val * 100)}${label}` : `+${val} ${label}`;
            return display;
          }).join(", ");
        return `${v.name}${bonuses ? ` | ${bonuses}` : ""}`;
      })
      .join("\n")
  : null;

console.log(`Loaded calculator data: ${calcData ? Object.keys(calcData.units).length : 0} champions, ${calcData ? Object.values(calcData.traits).length : 0} traits, ${calcData ? Object.entries(calcData.items).filter(([,v]) => v.tags?.includes("Craftable")).length : 0} craftable items`);

// Load tactics.tools scraped item stats (Diamond+ ranked, 3M+ games)
// Wilson score lower bound — ranks items by statistically conservative win rate.
// Prevents items with 5 games at 1.00 from outranking items with 1000 games at 0.72.
// z=1.96 → 95% confidence interval lower bound.
function wilsonLower(p, n, z = 1.96) {
  if (n === 0) return 0;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

// Returns true if an item ID should be excluded from recommendations.
// Allows: the set's craftable items (from its calculator_data) + emblems.
// Rejects: components, consumables, test items, etc.
// Set 18 match data uses "DA_EdgeOfNight"; Set 17 used "TFT_Item_EdgeOfNight".
function isJunkItem(id, set = CURRENT_SET) {
  if (id.includes('Component')) return true;  // "DA_Component_Spatula" is a component, not an item
  if (id.includes('Emblem') || id.includes('Spat')) return false;
  const key = id.replace(/^DA_|TFT\d*_Item_/, '');
  return !calcDataFor(set)?.items?.[key]?.tags?.includes('Craftable');
}

// ---------------------------------------------------------------------------
// Riot API helpers
// ---------------------------------------------------------------------------

function riotGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      headers: { "X-Riot-Token": RIOT_API_KEY },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Riot API ${res.statusCode}: ${data}`));
        resolve(JSON.parse(data));
      });
    }).on("error", reject);
  });
}

// Finished matches never change, so cache them: repeat analyses (same player, or friends
// who shared lobbies) cost no Riot requests. Locally, also reuse collect_pro.py's file cache.
const matchCache = new Map();
const MATCH_CACHE_MAX = 2000;
async function getMatchDetails(matchId) {
  if (matchCache.has(matchId)) return matchCache.get(matchId);
  let match = null;
  if (!process.env.VERCEL) {
    const f = path.join(__dirname, "data", "raw", "matches", `${path.basename(matchId)}.json`);
    if (fs.existsSync(f)) { try { match = JSON.parse(fs.readFileSync(f, "utf8")); } catch {} }
  }
  if (!match) match = await riotGet("americas.api.riotgames.com", `/tft/match/v1/matches/${matchId}`);
  if (matchCache.size >= MATCH_CACHE_MAX) matchCache.delete(matchCache.keys().next().value);
  matchCache.set(matchId, match);
  return match;
}

const isRateLimit = e => /Riot API 429/.test(e?.message || "");
const RATE_LIMIT_MSG = "Riot's API limit was hit (dev keys allow 100 requests per 2 minutes). Wait 2 minutes and try again.";

async function getRecentMatches(puuid, count = 5, start = 0) {
  const params = `count=${Math.min(count, 200)}&start=${start}&queue=1100`;
  return riotGet("americas.api.riotgames.com", `/tft/match/v1/matches/by-puuid/${puuid}/ids?${params}`);
}

// Fetch match details in small batches to stay within Riot dev-key rate limits
// (20 req/sec, 100 req/2min — a burst of 200 simultaneous calls kills almost all of them)
async function batchMatchDetails(matchIds, batchSize = 10, delayMs = 1100) {
  const results = [];
  let rateLimited = 0;
  for (let i = 0; i < matchIds.length; i += batchSize) {
    const batch = matchIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(id => getMatchDetails(id).catch(e => {
        if (isRateLimit(e)) rateLimited++;
        console.warn(`Match detail fetch failed (${id}):`, e.message);
        return null;
      }))
    );
    results.push(...batchResults);
    if (i + batchSize < matchIds.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  // Mostly rate-limited → surface it instead of silently analyzing almost no games
  if (rateLimited && rateLimited >= matchIds.length / 2) {
    const err = new Error("Riot API 429: too many match fetches were rate limited");
    throw err;
  }
  return results;
}

async function getPuuid(gameName, tagLine) {
  const data = await riotGet(
    "americas.api.riotgames.com",
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
  );
  return data.puuid;
}

async function getRankInfo(puuid) {
  // Note: Riot removed summonerId from summoner responses and has no PUUID-based
  // league endpoint in TFT. Rank lookup is not available on development API keys.
  return null;
}

// ---------------------------------------------------------------------------
// Feature extraction (mirrors features.py logic)
// ---------------------------------------------------------------------------

function topTrait(traits) {
  const active = traits.filter((t) => (t.style || 0) > 0);
  if (!active.length) return "unknown";
  return active.sort((a, b) => (b.style || 0) - (a.style || 0))[0].name;
}

function gini(values) {
  if (!values.length || values.every((v) => v === 0)) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0);
  const weightedSum = sorted.reduce((s, v, i) => s + (i + 1) * v, 0);
  return (2 * weightedSum) / (n * total) - (n + 1) / n;
}

function extractFeatures(participant) {
  const units = participant.units || [];
  const traits = participant.traits || [];

  const level = participant.level || 1;
  const lastRound = participant.last_round || 1;
  const goldLeft = participant.gold_left || 0;
  const placement = participant.placement || 8;

  const unitItems = {};
  for (const u of units) {
    unitItems[u.character_id] = u.itemNames || [];
  }

  return {
    placement,
    top4: placement <= 4,
    level,
    goldLeft,
    lastRound,
    levelEfficiency: level / Math.max(lastRound, 1),
    topTrait: topTrait(traits),
    activeTraitCount: traits.filter((t) => (t.style || 0) > 0).length,
    unitStarAvg: units.length ? units.reduce((s, u) => s + (u.tier || 1), 0) / units.length : 1,
    itemConcentration: gini(units.map((u) => (u.itemNames || []).length)),
    unitItems,
    damageToPlayers: participant.total_damage_to_players || 0,
  };
}

// ---------------------------------------------------------------------------
// Aggregate stats helper
// ---------------------------------------------------------------------------

function computeStats(games) {
  if (!games.length) return { total: 0, avgPlacement: null, top4Count: 0, wins: 0, avgLevel: null, avgGoldLeft: null, avgLevelEff: null, goldWastedGames: 0, avgBot4LevelEff: null, topComps: [], synergies: [] };

  const top4Count = games.filter(g => g.placement <= 4).length;
  const wins = games.filter(g => g.placement === 1).length;
  const avgPlacement = (games.reduce((s, g) => s + g.placement, 0) / games.length).toFixed(2);
  const avgLevel = (games.reduce((s, g) => s + g.level, 0) / games.length).toFixed(1);
  const avgGoldLeft = (games.reduce((s, g) => s + g.goldLeft, 0) / games.length).toFixed(1);
  const avgLevelEff = (games.reduce((s, g) => s + g.levelEfficiency, 0) / games.length).toFixed(3);
  const goldWastedGames = games.filter(g => g.goldLeft > 10).length;
  const bot4 = games.filter(g => g.placement > 4);
  const avgBot4LevelEff = bot4.length ? (bot4.reduce((s, g) => s + g.levelEfficiency, 0) / bot4.length).toFixed(3) : null;

  const compMap = {};
  for (const g of games) {
    const k = g.topTrait || "Unknown";
    if (!compMap[k]) compMap[k] = { games: 0, placementSum: 0, top4: 0 };
    compMap[k].games++;
    compMap[k].placementSum += g.placement;
    if (g.placement <= 4) compMap[k].top4++;
  }
  const topComps = Object.entries(compMap)
    .map(([name, s]) => ({ name, games: s.games, avgPlace: (s.placementSum / s.games).toFixed(1), top4Pct: (s.top4 / s.games * 100).toFixed(0) }))
    .sort((a, b) => parseFloat(a.avgPlace) - parseFloat(b.avgPlace))
    .slice(0, 5);

  const synergyMap = {};
  for (const g of games) {
    for (const t of g.traits) {
      if (!synergyMap[t.name]) synergyMap[t.name] = { games: 0, placementSum: 0, top4: 0 };
      synergyMap[t.name].games++;
      synergyMap[t.name].placementSum += g.placement;
      if (g.placement <= 4) synergyMap[t.name].top4++;
    }
  }
  const synergies = Object.entries(synergyMap)
    .map(([name, s]) => ({ name, games: s.games, avgPlacement: (s.placementSum / s.games).toFixed(2), top4Rate: (s.top4 / s.games * 100).toFixed(0) + "%" }))
    .filter(s => s.games >= 2)
    .sort((a, b) => parseFloat(a.avgPlacement) - parseFloat(b.avgPlacement))
    .slice(0, 8);

  return { total: games.length, avgPlacement, top4Count, wins, avgLevel, avgGoldLeft, avgLevelEff, goldWastedGames, avgBot4LevelEff, topComps, synergies };
}

// ---------------------------------------------------------------------------
// Coaching analysis
// ---------------------------------------------------------------------------

// NOTE: Augment analysis was removed in May 2026 — Riot stripped augment data
// from Set 17 match responses. Restore from git history if augments return.

function analyzeItems(feats) {
  const issues = [];
  if (!itemWinrates.length) return issues;

  for (const [unitId, items] of Object.entries(feats.unitItems)) {
    if (!items.length) continue;
    const unitRows = itemWinrates
      .filter((r) => r.unit_id === resolveUnitId(unitId))
      .sort((a, b) => parseFloat(b.top4_rate) - parseFloat(a.top4_rate));
    if (!unitRows.length) continue;

    // Score the user's build as the average top4_rate of their items
    const userRates = items
      .map(id => unitRows.find(r => r.item_id === id))
      .filter(Boolean)
      .map(r => parseFloat(r.top4_rate));
    const userRate = userRates.length ? userRates.reduce((a, b) => a + b, 0) / userRates.length : null;
    const best = unitRows[0];
    const bestRate = parseFloat(best.top4_rate);

    if (!userRate || bestRate > userRate + 0.08) {
      const userStr = userRate !== null ? `${(userRate * 100).toFixed(0)}% top-4 (avg across items)` : "no pro data";
      const bestName = itemName(best.item_id);
      issues.push(
        `${unitId}: your items had ${userStr}. ` +
        `Top Challenger item ${bestName} reaches ${(bestRate * 100).toFixed(0)}% top-4 (n=${best.games}).`
      );
    }
  }
  return issues.slice(0, 4);
}

function proStats(topTrait) {
  const compRows = matchFeatures.filter((r) => r.top_trait === topTrait);
  if (!compRows.length) return null;
  // Efficiency/economy stats from top-4 games only — model what winning looks like for this comp
  const winners = compRows.filter((r) => parseInt(r.top4) === 1);
  if (!winners.length) return null;
  const avgLevelEff = winners.reduce((s, r) => s + parseFloat(r.level_efficiency || 0), 0) / winners.length;
  const avgGoldLeft = winners.reduce((s, r) => s + parseFloat(r.gold_left || 0), 0) / winners.length;
  const top4Rate = winners.length / compRows.length;
  return { avgLevelEff, avgGoldLeft, top4Rate, games: compRows.length };
}

// Returns top items for a unit from the Challenger dataset, formatted for AI prompts.
function proUnitStats(unitId, set = CURRENT_SET) {
  const winrates = winratesFor(set);
  if (!unitId || !winrates.length) return null;
  const rows = winrates
    .filter(r => r.unit_id === resolveUnitId(unitId) && parseInt(r.games) >= 10 && !isJunkItem(r.item_id, set))
    .sort((a, b) =>
      wilsonLower(parseFloat(b.top4_rate), parseInt(b.games)) -
      wilsonLower(parseFloat(a.top4_rate), parseInt(a.games))
    )
    .slice(0, 4);
  if (!rows.length) return null;
  return rows.map(r => {
    const name = itemName(r.item_id);
    const pct = (parseFloat(r.top4_rate) * 100).toFixed(0);
    return `  • ${name}: ${pct}% top-4 (${r.games} games)`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// TFT Academy local DB query
// ---------------------------------------------------------------------------

function getTftAcademyData(matchIdOrIds) {
  return new Promise((resolve) => {
    const isArray = Array.isArray(matchIdOrIds);
    const args = isArray
      ? ["src/query_tftacademy.py", "--match_ids", matchIdOrIds.join(",")]
      : ["src/query_tftacademy.py", "--match_id", matchIdOrIds];

    const proc = spawn("python3", args);
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => console.error("TFTAcademy query stderr:", d.toString().trim()));
    proc.on("close", () => {
      try { resolve(JSON.parse(out.trim())); }
      catch { resolve(null); }
    });
    proc.on("error", (e) => {
      console.error("TFTAcademy query error:", e.message);
      resolve(null);
    });
    // 5s timeout — don't let a slow DB stall the request
    setTimeout(() => { proc.kill(); resolve(null); }, 5000);
  });
}

// Formats TFT Academy single-game data into a concise prompt block.
function fmtAcademyGame(ta) {
  if (!ta) return null;
  const lines = [];

  // Level timing
  const lvlStr = ta.levels
    .filter(l => l.level >= 4)
    .map(l => `L${l.level}@${l.round}`)
    .join(" → ");
  if (lvlStr) lines.push(`Leveling: ${lvlStr}`);

  // Gold at key rounds — max (before spending) and min (after) to show rolling
  const KEY = ["2-1","2-2","3-1","3-2","3-5","4-1","4-2","4-5","5-1"];
  const goldStr = KEY
    .filter(r => ta.gold_by_round[r])
    .map(r => {
      const { max, min } = ta.gold_by_round[r];
      const rolled = max - min >= 20 ? ` (rolled ${max - min}g)` : "";
      return `${r}: ${max}g${rolled}`;
    }).join(", ");
  if (goldStr) lines.push(`Gold at key rounds: ${goldStr}`);

  // Augments
  if (ta.augments.length) {
    const augStr = ta.augments.map(a => `${a.round}: ${a.name}`).join(" | ");
    lines.push(`Augments: ${augStr}`);
  }

  // Health
  const hpStr = ta.health_snapshots.map(s => `${s.round}: ${s.hp}hp`).join(", ");
  if (hpStr) lines.push(`Health: ${hpStr}`);

  // Board at key rounds
  for (const [rnd, units] of Object.entries(ta.board_snapshots)) {
    lines.push(`Board at ${rnd}: ${units.join(", ")}`);
  }

  return lines.join("\n");
}

// Formats TFT Academy aggregate data (multiple games) into a prompt block.
function fmtAcademyAggregate(ta) {
  if (!ta || !ta.games_found) return null;
  const lines = [`TFT Academy data found for ${ta.games_found} of your recent games:`];

  // Level timing patterns
  for (const [lvl, rounds] of Object.entries(ta.level_timing)) {
    if (parseInt(lvl) < 6) continue; // only meaningful from L6+
    lines.push(`  L${lvl} reached at rounds: ${rounds.join(", ")}`);
  }

  // Heavy rolling rounds
  if (ta.heavy_roll_rounds.length) {
    const rollStr = ta.heavy_roll_rounds
      .map(g => `${g.match_id.split("_")[1]}: rounds ${g.rounds.join(", ")}`)
      .join("; ");
    lines.push(`  Heavy rolling (≥20g spent in one round): ${rollStr}`);
  }

  // Augments across games
  const augCounts = {};
  for (const a of ta.augments) augCounts[a.name] = (augCounts[a.name] || 0) + 1;
  const topAugs = Object.entries(augCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (topAugs.length) {
    lines.push(`  Most-taken augments: ${topAugs.map(([n, c]) => `${n} (×${c})`).join(", ")}`);
  }

  // Early bleed
  if (ta.early_bleed_games.length) {
    lines.push(`  Games with HP < 40 before stage 4: ${ta.early_bleed_games.length}/${ta.games_found}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------

// Gemini failures (billing/quota/outage) reject with the real error so callers fall back
// to Groq. After a billing or quota error, skip Gemini for 10 min instead of paying the
// round-trip on every request.
let geminiDownUntil = 0;
const geminiAvailable = () => GEMINI_API_KEY && Date.now() >= geminiDownUntil;
function geminiFailure(json, label) {
  const err = json.error;
  if (err) {
    if ([402, 403, 429].includes(err.code) || err.status === "RESOURCE_EXHAUSTED") {
      geminiDownUntil = Date.now() + 10 * 60 * 1000;
    }
    console.error(`${label} error ${err.code} ${err.status}: ${(err.message || "").slice(0, 200)}`);
    return new Error(`Gemini ${err.code}: ${err.message || err.status}`);
  }
  const reason = json.candidates?.[0]?.finishReason || "unknown";
  const blocked = json.promptFeedback?.blockReason;
  console.error(`${label} empty response — finishReason:`, reason, "| blockReason:", blocked, "| raw:", JSON.stringify(json).slice(0, 400));
  return new Error(`Gemini returned no text — reason: ${blocked || reason}`);
}

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    });
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            // gemini-2.5-flash includes thinking parts (thought:true) before the answer —
            // find the first non-thought part to get the actual response text
            const parts = json.candidates?.[0]?.content?.parts || [];
            const text = parts.find(p => !p.thought && p.text)?.text;
            if (text) return resolve(text);
            reject(geminiFailure(json, "Gemini"));
          } catch (e) { reject(new Error("Failed to parse Gemini response: " + e.message)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Gemini API call with Google Search grounding — used only for /api/ask
// Gemini automatically decides when to search; billed per prompt (not per search).
// Free quota: 5,000 grounded prompts/month.
// ---------------------------------------------------------------------------

function callGeminiWithSearch(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    });
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            // Grounded responses may split text across multiple parts — join them all
            const parts = json.candidates?.[0]?.content?.parts || [];
            const text = parts.map(p => p.text || "").join("").trim();
            if (text) return resolve(text);
            reject(geminiFailure(json, "Gemini+Search"));
          } catch (e) { reject(new Error("Failed to parse Gemini+Search response: " + e.message)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Groq API call (OpenAI-compatible)
// ---------------------------------------------------------------------------

function callGroq(prompt, maxTokens = 400) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      // gpt-oss is a reasoning model: reasoning tokens count against the cap, so
      // keep effort low and leave headroom so the visible answer isn't cut off
      max_completion_tokens: maxTokens + 1024,
      reasoning_effort: "low",
      include_reasoning: false,
      temperature: 0.5,
    });
    const req = https.request(
      {
        hostname: "api.groq.com",
        path: "/openai/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices?.[0]?.message?.content;
            if (text) return resolve(text.trim());
            console.error("Groq empty response:", JSON.stringify(json).slice(0, 300));
            resolve("(No response from Groq)");
          } catch (e) { reject(new Error("Failed to parse Groq response: " + e.message)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// AI dispatcher: try Gemini first, fall back to Groq if it 503s / rate-limits
// ---------------------------------------------------------------------------

async function callAI(prompt, maxTokens = 600) {
  // Try Gemini first if configured (and not in a billing/quota cool-down)
  if (geminiAvailable()) {
    try {
      const result = await callGemini(prompt);
      // Defensive: older code paths returned "(Gemini …)" strings instead of rejecting
      if (result && !result.startsWith("(Gemini")) return result;
      console.warn("Gemini empty/error response — falling back to Groq");
    } catch (e) {
      console.warn("Gemini threw — falling back to Groq:", e.message);
    }
  }
  // Fall back to Groq
  if (GROQ_API_KEY) {
    try {
      const result = await callGroq(prompt, maxTokens);
      if (result && !result.startsWith("(No response")) return result;
    } catch (e) {
      console.error("Groq also failed:", e.message);
    }
  }
  return "(AI services temporarily unavailable — please try again in a minute.)";
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// GET /api/profile?handle=toofxd%23NA1 — full dashboard data
app.get("/api/profile", async (req, res) => {
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: "handle required" });
  const [gameName, tagLine] = handle.split("#");
  if (!gameName || !tagLine) return res.status(400).json({ error: "Format must be Name#TAG" });

  console.log(`[SEARCH] ${new Date().toISOString()} ${handle}`);
  if (!process.env.VERCEL) {
    fs.appendFile(
      path.join(__dirname, "logs", "searches.log"),
      `${new Date().toISOString()}\t${handle}\n`,
      () => {}
    );
  }

  try {
    const puuid = await getPuuid(gameName, tagLine);

    // League rank info
    let rankInfo = null;
    try { rankInfo = await getRankInfo(puuid); } catch {}

    // Fetch enough matches for the all-set banner. Capped at 30: one analysis then costs
    // ~33 Riot requests, so a dev key (100 per 2 min) handles ~3 fresh analyses per window.
    const count = Math.min(parseInt(req.query.count) || 20, 20);
    const allCount = 30;
    const fetchCount = Math.max(count, allCount);
    const matchIds = await getRecentMatches(puuid, fetchCount);
    // Fetch in batches of 10 with ~1s gaps to stay within 20 req/sec dev-key limit
    const matches = await batchMatchDetails(matchIds);
    const currentSet = matches.filter(Boolean).map(m => m.info?.tft_set_number).filter(Boolean);
    const latestSet = currentSet.length ? Math.max(...currentSet) : null;

    // Build all games list (all matches in current set)
    const allMatchesForSet = matches.filter(m => m && (!latestSet || m.info?.tft_set_number === latestSet));
    const buildGame = (m) => {
      const p = m.info.participants.find(p => p.puuid === puuid);
      if (!p) return null;
      const feats = extractFeatures(p);
      const traits = (p.traits || [])
        .filter(t => (t.style || 0) > 0)
        .sort((a, b) => (b.style || 0) - (a.style || 0))
        .slice(0, 5)
        .map(t => ({ name: traitName(t.name), tier_current: t.tier_current, style: t.style }));
      const units = (p.units || [])
        .sort((a, b) => (b.tier || 0) - (a.tier || 0))
        .map(u => ({ id: champName(u.character_id), tier: u.tier, items: (u.itemNames || []).map(itemName) }));
      const arch = archetypeModel && archetypes.classify(archetypeModel, {
        avg_unit_cost: archetypes.avgUnitCost(archetypeModel, p.units), unit_star_avg: feats.unitStarAvg,
      });
      return {
        matchId: m.metadata.match_id,
        archetype: arch ? arch.key : null,
        archetypeLabel: arch ? arch.label : null,
        unitStarAvg: +feats.unitStarAvg.toFixed(2),
        placement: p.placement,
        lastRound: p.last_round,
        gameLength: Math.round(m.info.game_length || 0),
        datetime: m.info.game_datetime,
        level: p.level,
        goldLeft: p.gold_left,
        topTrait: traitName(feats.topTrait),
        traits,
        units,
        levelEfficiency: feats.levelEfficiency,
        // Same columns as match_features.csv — input to the placement MLP, stripped before responding
        modelFeatures: {
          level: p.level || 1,
          gold_left: p.gold_left || 0,
          active_trait_count: feats.activeTraitCount,
          unit_star_avg: feats.unitStarAvg,
          unit_count: units.length,
          item_concentration: feats.itemConcentration,
          top_trait: feats.topTrait,
        },
      };
    };

    const allGames = allMatchesForSet.map(buildGame).filter(Boolean);
    if (!allGames.length) {
      return res.status(404).json({ error: "No ranked TFT games found for this Riot ID. Only ranked games are analyzed — play a ranked game this set, then try again." });
    }
    const recentGames = allGames.slice(0, count);

    // Counterfactual weaknesses: re-predict each game with one habit fixed to the
    // Challenger value; the biggest predicted-placement gain is the biggest weakness.
    // Targets come from the game's own archetype, so reroll games aren't pushed to level 9.
    let modelWeaknesses = null;
    if (mlp) {
      const targetsFor = i => {
        const a = archetypeModel?.byKey[recentGames[i].archetype];
        return a ? { level: a.benchmarks.level, unit_star_avg: a.benchmarks.unit_star_avg, gold_left: a.benchmarks.gold_left } : {};
      };
      const { predicted, weaknesses } = placementModel.counterfactuals(mlp, recentGames.map(g => g.modelFeatures), targetsFor);
      recentGames.forEach((g, i) => { g.predictedPlacement = predicted[i]; });
      modelWeaknesses = weaknesses;
    }
    allGames.forEach(g => { delete g.modelFeatures; });
    const archetypeSummary = archetypeModel ? archetypes.summarize(archetypeModel, recentGames.filter(g => g.archetype)) : null;

    // Compute separate stat sets
    const allStats = computeStats(allGames);
    const recentStats = computeStats(recentGames);

    // Backwards-compat top-level fields (recent games, for coaching endpoint)
    const { avgPlacement, top4Count, wins, avgLevel, avgGoldLeft, avgLevelEff, goldWastedGames, avgBot4LevelEff, topComps, synergies } = recentStats;

    res.json({
      puuid, rankInfo,
      games: recentGames,
      // all-games-this-set aggregates (for top banner)
      allStats,
      // recent-games aggregates (for bottom banner + coaching)
      recentStats,
      // backwards compat flat fields
      avgPlacement, top4Count, wins, total: recentGames.length,
      synergies, avgLevel, avgGoldLeft, avgLevelEff, topComps, goldWastedGames, avgBot4LevelEff,
      modelWeaknesses, archetypeSummary,
    });
  } catch (e) {
    if (isRateLimit(e)) return res.status(429).json({ error: RATE_LIMIT_MSG });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/puuid?handle=toofxd%23NA1 — resolve Riot ID to PUUID
// POST /api/coaching — generate aggregate coaching from profile stats (called separately so UI can show stats first)
app.post("/api/coaching", async (req, res) => {
  const { avgPlacement, top4Count, wins, total, avgLevel, avgGoldLeft, avgLevelEff, goldWastedGames, avgBot4LevelEff, topComps, synergies, matchIds, puuid, handle } = req.body;

  const top4Rate = total ? (top4Count / total * 100).toFixed(0) : 0;
  const winRate  = total ? (wins / total * 100).toFixed(0) : 0;
  const compSummary = (topComps || []).map(c => `${c.name} (${c.games}g, avg #${c.avgPlace}, ${c.top4Pct}% top-4)`).join(", ");
  const synSummary  = (synergies || []).slice(0, 3).map(s => `${s.name} (avg #${s.avgPlacement})`).join(", ");

  const bench = challengerBench;
  const mi = metaInsights?.benchmarks;

  // Build a rich benchmark block with interpretations baked in
  const benchBlock = bench ? `
Challenger/GM benchmarks (${bench.games.toLocaleString()} games, top-4 data only unless noted):
- Avg final level: ${bench.avgLevel.toFixed(1)} (top-4 winners)
- Avg gold left unspent: ${bench.avgGoldLeft.toFixed(1)}g (top-4 winners) | ${mi ? mi.avgGoldLeft.first.toFixed(1) + "g" : "n/a"} (1st place only)
- Avg level efficiency (level ÷ rounds played): ${bench.avgLevelEff.toFixed(3)} (top-4 winners) vs ${mi ? mi.avgLevelEff.bot4.toFixed(3) : "n/a"} (bottom-4)
- Overall top-4 rate across all pros: ${(bench.top4Rate * 100).toFixed(0)}%

HOW TO READ THESE METRICS:
• Gold left: Challenger winners average ${bench.avgGoldLeft.toFixed(1)}g unspent — not zero, because level-9 players naturally accumulate interest gold they can't fully spend. If a player consistently has 0–2g left, they're likely over-rolling too early or panic-spending. If they routinely leave 15g+, they may be hoarding and missing rolls or leveling opportunities.
• Level efficiency (= final level ÷ rounds survived): Lower is better — it means you reached a high level AND survived many rounds. Challenger top-4 players average ${bench.avgLevelEff.toFixed(3)}. If this number is above 0.30, the player is reaching a low level relative to rounds played, which typically means dying in mid-game before fully leveling up. High efficiency in losing games (avgBot4LevelEff) is a red flag: it means even in bad games, the player levels quickly but still can't survive.
` : "";

  // Bandit (per-user focus-area learning) disabled — it required persistent
  // per-user disk writes, which don't work on serverless. Coaching now uses the
  // static FOCUS AREAS listed in the prompt below.
  const banditFocus = "";
  const banditArm = null;
  const banditLabel = null;

  // Model-ranked weaknesses from /api/profile. Client-supplied, so keep only known
  // features with finite numbers and rebuild the wording server-side.
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const weaknesses = (Array.isArray(req.body.modelWeaknesses) ? req.body.modelWeaknesses : [])
    .filter(w => w && placementModel.FEATURE_LABELS[w.feature])
    .map(w => ({ ...placementModel.FEATURE_LABELS[w.feature], playerAvg: num(w.playerAvg), target: num(w.target),
                 placesPerGame: num(w.placesPerGame), gamesAffected: num(w.gamesAffected), games: num(w.games) }))
    .filter(w => w.playerAvg !== null && w.target !== null && w.placesPerGame !== null)
    // Drop fixes the model says don't help. Gold left usually lands here: removing gold
    // without buying anything with it doesn't improve a board — its real cost shows up
    // as the level and star upgrades the player didn't buy.
    .filter(w => w.placesPerGame >= 0.05)
    .slice(0, 3);

  // Player's games grouped by comp archetype. Only the player's own numbers come from the
  // client; pro benchmarks are looked up server-side by archetype key.
  const archRows = (Array.isArray(req.body.archetypeSummary) ? req.body.archetypeSummary : [])
    .map(r => {
      const a = archetypeModel?.byKey[r?.key];
      if (!a || !num(r.games)) return null;
      return { a, games: num(r.games), avgPlacement: num(r.avgPlacement),
               level: num(r.you?.level), stars: num(r.you?.unitStarAvg), gold: num(r.you?.goldLeft) };
    })
    .filter(Boolean);
  const archBlock = archRows.length ? `
BY COMP ARCHETYPE — each of the player's games was classified from its final board (avg unit cost + star level). Judge each group against pros playing the SAME archetype (their top-4 boards), not the overall Challenger averages above, which mix all styles — e.g. never tell a reroll player to hit level 9.
${archRows.map(r => `- ${r.a.label} (${r.a.description}): ${r.games} game${r.games === 1 ? "" : "s"}, avg #${r.avgPlacement} | player median level ${r.level}, ${r.stars}★ avg, median ${r.gold}g left | pro top-4: level ${r.a.benchmarks.level}, ${r.a.benchmarks.unit_star_avg}★, ${r.a.benchmarks.gold_left}g left`).join("\n")}
` : "";
  const focusBlock = weaknesses.length ? `MODEL-RANKED WEAKNESSES — a placement model trained on ${mlp ? mlp.trained_on.toLocaleString() : "thousands of"} Challenger/GM games predicted each of this player's games, then re-predicted with one habit fixed to the top-4 value for that game's comp archetype. Estimated placements gained per game, biggest first:
${weaknesses.map((w, i) => `${i + 1}. ${w.label}: player avg ${w.playerAvg}${w.unit} vs Challenger ${w.target}${w.unit} (archetype-matched avg) → ~${w.placesPerGame.toFixed(1)} places per game${w.gamesAffected !== null && w.games ? ` (fix applies in ${w.gamesAffected}/${w.games} games)` : ""}`).join("\n")}

FOCUS — build the coaching around this ranking:
- Insight 1 must address weakness #1 with concrete in-game actions, and say roughly how many placements it is costing them. Name timings in TFT stage-round notation (e.g. "level to 8 at 4-1"), never "round 7".
- Give each weakness attention in proportion to its estimated cost. A weakness worth under 0.1 places is not worth more than a sentence.
- These are model estimates from end-of-game state: say "about" or "roughly", never present them as exact.
- Also cover current patch context: use search to check what comps/augments/items are strong right now and whether this player's tendencies align or fight the meta.` : `FOCUS AREAS — address at least two of these if the data supports it:
- Gold economy: Is this player hoarding (too much gold left) or panic-spending (too little)? What should they do at specific round intervals?
- Leveling: Their level efficiency vs Challenger/GM tells a story. What is that story and what should change?
- Comp consistency and when to pivot vs commit.
- Current patch context: use search to check what comps/augments/items are strong right now and whether this player's tendencies align or fight the meta.`;

  const prompt = `You are an expert TFT (Teamfight Tactics) coach. Below is a player's data for their last ${total} games. Use it to write 4–6 coaching insights.

FORMAT RULES — follow exactly:
- Number each insight (1. 2. 3. etc.)
- Each insight is 2–4 sentences of flowing prose. No sub-bullets, no stat tables, no headers.
- Do NOT repeat the player's raw numbers back. Instead, interpret what those numbers mean in plain English and say what to do differently.
- Start insight 1 immediately — no intro paragraph, no "Here is your coaching:" preamble.

PLAYER DATA (last ${total} games, for your reference only — do not echo these back):
- Placement: avg #${avgPlacement}, top-4 ${top4Rate}%, wins ${winRate}%
- Avg final level: ${avgLevel} | Avg gold left: ${avgGoldLeft}g | Games ending with >10g unspent: ${goldWastedGames}/${total}
- Level efficiency (final level ÷ rounds played): ${avgLevelEff} | Same stat in losing games only: ${avgBot4LevelEff ?? "N/A"}
- Most-played comps: ${compSummary || "N/A"}
- Best comps by placement: ${synSummary || "N/A"}
${benchBlock}${archBlock}
${banditFocus ? banditFocus + "\n\n" : ""}${focusBlock}`;

  if (!GEMINI_API_KEY && !GROQ_API_KEY) return res.json({ coaching: "(No AI API keys configured)" });
  try {
    // Use Gemini with Google Search grounding for patch-aware coaching, fall back to Groq
    const coaching = GEMINI_API_KEY
      ? await (geminiAvailable() ? callGeminiWithSearch(prompt) : Promise.reject()).catch(() => callAI(prompt, 700))
      : await callAI(prompt, 700);
    res.json({ coaching, banditArm, banditLabel, modelFocus: weaknesses[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/puuid", async (req, res) => {
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: "handle required" });
  const [gameName, tagLine] = handle.split("#");
  if (!gameName || !tagLine) return res.status(400).json({ error: "Format must be Name#TAG" });
  try {
    const puuid = await getPuuid(gameName, tagLine);
    res.json({ puuid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/matches?puuid=... — return recent match IDs
app.get("/api/matches", async (req, res) => {
  const { puuid } = req.query;
  if (!puuid) return res.status(400).json({ error: "puuid required" });
  try {
    const ids = await getRecentMatches(puuid, 5);
    res.json({ matchIds: ids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/items — overall item rankings from tactics.tools (Diamond+ data)
// GET /api/meta-insights — Challenger/GM takeaways derived from the local CSV dataset.
// No Riot API dependency — always available regardless of key expiry.
app.get("/api/meta-insights", (req, res) => {
  if (!metaInsights) return res.status(503).json({ error: "No match data loaded." });
  res.json({
    totalGames: metaInsights.totalGames,
    benchmarks: metaInsights.benchmarks,
    topComps: metaInsights.topComps.map(c => ({
      ...c,
      name: traitName(c.trait),
    })),
  });
});

// GET /api/trait-stats — every current-set trait with its units, breakpoints, description,
// and how often pros finished top 4 when it was their main (top_trait) trait.
// Built once at startup from calculator_data.json + the pro match CSV.
const COMPONENT_KEYS = { 1: "BFSword", 2: "RecurveBow", 3: "NeedlesslyLargeRod", 4: "TearOfTheGoddess",
  5: "ChainVest", 6: "NegatronCloak", 7: "GiantsBelt", 8: "SparringGloves", 9: "Spatula", 10: "FryingPan" };
// Components aren't in calculator_data, so name them here
const COMPONENT_NAMES = { BFSword: "B.F. Sword", RecurveBow: "Recurve Bow", NeedlesslyLargeRod: "Rod",
  TearOfTheGoddess: "Tear", ChainVest: "Chain Vest", NegatronCloak: "Negatron Cloak", GiantsBelt: "Giant's Belt",
  SparringGloves: "Sparring Gloves", Spatula: "Spatula", FryingPan: "Frying Pan" };
const itemIcon = key => calcData?.items?.[key]?.icon || `https://ap.tft.tools/img/items_s14/${key}.png`;

const traitStats = (() => {
  if (!calcData) return [];
  const byTrait = {};
  for (const r of matchFeatures) {
    const t = byTrait[r.top_trait] || (byTrait[r.top_trait] = { games: 0, top4: 0 });
    t.games++; t.top4 += parseInt(r.top4) === 1 ? 1 : 0;
  }
  // Lux forms are one champion; list base Lux only
  const units = Object.entries(calcData.units)
    .filter(([k, u]) => u.cost > 0 && u.traits?.length && !(/_Lux_/.test(k) && !k.endsWith("_Lux_Base")));
  const emblems = {};
  for (const [key, it] of Object.entries(calcData.items)) {
    if ((it.tags || []).some(t => t === "Emblem" || t === "CraftableEmblem")) emblems[it.name] = { key, ...it };
  }
  return Object.entries(calcData.traits).map(([apiName, t]) => {
    const s = byTrait[apiName] || { games: 0, top4: 0 };
    const em = emblems[`${t.name} Emblem`];
    return {
      apiName,
      name: t.name,
      icon: t.icon || null,
      desc: t.desc || "",
      breakpoints: t.breakpoints.map(b => b.minUnits).filter(n => n != null),
      units: units.filter(([, u]) => u.traits.includes(t.name))
        .map(([key, u]) => ({ key, name: u.name, cost: u.cost, icon: u.icon || null }))
        .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name)),
      emblem: em ? {
        name: em.name,
        icon: em.icon || null,
        craftable: (em.tags || []).includes("CraftableEmblem"),
        from: (em.from || []).map(n => COMPONENT_KEYS[n]).filter(Boolean)
          .map(k => ({ key: k, name: COMPONENT_NAMES[k] || k, icon: itemIcon(k) })),
      } : null,
      games: s.games,
      top4Rate: s.games ? s.top4 / s.games : null,
      // 95% lower bound — ranks a 76% rate over 300 games below a 62% rate over 3,000
      score: s.games ? wilsonLower(s.top4 / s.games, s.games) : null,
    };
  });
})();

// Lux's forms (Avatar): which trait each form carries
const avatarForms = calcData
  ? Object.entries(calcData.units).filter(([k]) => /_Lux_/.test(k) && !k.endsWith("_Lux_Base"))
      .map(([, u]) => u.traits.find(t => t !== "Avatar")).filter(Boolean)
  : [];

app.get("/api/trait-stats", (_req, res) => {
  res.json({ set: CURRENT_SET, totalGames: matchFeatures.length, traits: traitStats, avatarForms });
});

// GET /api/item-recs?unitId=TFT18_Caitlyn
// Per-item top-4 rate: each game counts once per unique item the unit carried.
// Scored by Wilson lower bound (95% CI) to penalise small samples.
app.get("/api/item-recs", (req, res) => {
  const { unitId } = req.query;
  if (!unitId) return res.status(400).json({ error: "unitId required" });

  const set = setFrom(req);
  const allRows = winratesFor(set)
    .filter(r => r.unit_id === resolveUnitId(unitId) && !isJunkItem(r.item_id, set))
    .map(r => ({ itemId: r.item_id, top4Rate: parseFloat(r.top4_rate), games: parseInt(r.games) }));

  // Approximate total unit appearances from the most-seen item
  const totalUnitGames = allRows.length ? Math.max(...allRows.map(r => r.games)) : 0;

  // Scaled floor: 5% of total unit games, with a minimum of 50
  const minGames = Math.max(50, totalUnitGames * 0.05);

  const recs = allRows
    .filter(r => r.games >= minGames)
    .map(r => ({
      ...r,
      playRate: totalUnitGames > 0 ? parseFloat((r.games / totalUnitGames * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => wilsonLower(b.top4Rate, b.games) - wilsonLower(a.top4Rate, a.games))
    .slice(0, 10);

  res.json({ recommendations: recs, totalUnitGames });
});

// POST /api/coach — analyze a match
app.post("/api/coach", async (req, res) => {
  const { matchId, puuid } = req.body;
  if (!matchId || !puuid) return res.status(400).json({ error: "matchId and puuid required" });

  try {
    const match = await getMatchDetails(matchId);
    const participants = match?.info?.participants || [];
    const me = participants.find((p) => p.puuid === puuid);
    if (!me) return res.status(404).json({ error: "Your PUUID not found in this match." });

    const feats = extractFeatures(me);
    const pro = proStats(feats.topTrait);
    const itemIssues = analyzeItems(feats);
    const arch = archetypeModel && archetypes.classify(archetypeModel, {
      avg_unit_cost: archetypes.avgUnitCost(archetypeModel, me.units), unit_star_avg: feats.unitStarAvg,
    });
    const ab = arch?.benchmarks;

    // Build Gemini prompt
    const bench = challengerBench;
    const prompt = `You are a TFT (Teamfight Tactics) coaching assistant. A player just finished a game.
Here is their performance compared to Challenger/GM-level players (dataset: ${bench ? bench.games.toLocaleString() : "N/A"} pro games):

Comp: ${traitName(feats.topTrait)}
Final placement: ${feats.placement}
Level: ${feats.level} | Gold left: ${feats.goldLeft} | Eliminated round: ${feats.lastRound}
Level efficiency: ${feats.levelEfficiency.toFixed(2)} ${pro ? `(Challenger avg for this comp: ${pro.avgLevelEff.toFixed(2)}, overall Challenger avg: ${bench ? bench.avgLevelEff.toFixed(2) : "N/A"})` : bench ? `(overall Challenger avg: ${bench.avgLevelEff.toFixed(2)})` : ""}
Gold left: ${feats.goldLeft} ${pro ? `(Challenger avg for this comp: ${pro.avgGoldLeft.toFixed(1)}, overall Challenger avg: ${bench ? bench.avgGoldLeft.toFixed(1) : "N/A"})` : bench ? `(overall Challenger avg: ${bench.avgGoldLeft.toFixed(1)})` : ""}
${pro ? `This comp has ${(pro.top4Rate * 100).toFixed(0)}% top-4 rate in Challenger across ${pro.games} games.` : ""}
${arch ? `Comp archetype: ${arch.label} (${arch.description}). Challenger top-4 ${arch.label} boards: level ${ab.level}, ${ab.unit_star_avg}★ avg, ${ab.gold_left}g left (player: level ${feats.level}, ${feats.unitStarAvg.toFixed(2)}★). Judge leveling and economy against these archetype numbers, not the overall averages.` : ""}

Item issues (based on Challenger item win rates):
${itemIssues.length ? itemIssues.join("\n") : "None detected."}

Write 3–5 concise, specific coaching suggestions. Be direct and actionable. Use TFT terminology naturally. Do not repeat raw numbers — synthesize them into advice.`;

    let coachingText = "(No AI API keys configured)";
    if (GEMINI_API_KEY || GROQ_API_KEY) {
      coachingText = GEMINI_API_KEY
        ? await (geminiAvailable() ? callGeminiWithSearch(prompt) : Promise.reject()).catch(() => callAI(prompt, 500))
        : await callAI(prompt, 500);
    }

    res.json({
      placement: feats.placement,
      topTrait: feats.topTrait,
      level: feats.level,
      goldLeft: feats.goldLeft,
      lastRound: feats.lastRound,
      levelEfficiency: feats.levelEfficiency.toFixed(2),
      proLevelEfficiency: pro ? pro.avgLevelEff.toFixed(2) : null,
      proTop4Rate: pro ? (pro.top4Rate * 100).toFixed(0) + "%" : null,
      archetype: arch ? arch.key : null,
      itemIssues,
      coaching: coachingText,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/champion-tips — Groq-powered tips for a specific champion
// ---------------------------------------------------------------------------
// Craftable item + emblem names and trait names for a set — the only ones tips may mention
function setVocabulary(set) {
  const data = calcDataFor(set);
  if (!data) return { items: [], traits: [] };
  // Keys like "17AstronautEmblemItem" carry a set prefix; drop ones from other sets
  const otherSet = k => { const m = k.match(/^(\d\d)\D/); return m && m[1] !== String(set); };
  const items = [...new Set(Object.entries(data.items)
    .filter(([k, v]) => v.name && !otherSet(k)
      && (v.tags || []).some(t => t === "Craftable" || t === "CraftableEmblem"))
    .map(([, v]) => v.name))].sort();
  const traits = [...new Set(Object.values(data.traits).map(t => t.name).filter(Boolean))].sort();
  return { items, traits };
}

// True when tips have all 3 sections and Best Items opens "<Name> benefits from"
function tipsWellFormed(text, name) {
  const best = text.match(/\*\*Best Items:\*\*\s*(.*)/i);
  return !!best && /\*\*When to Play:\*\*/i.test(text) && /\*\*Key Trait:\*\*/i.test(text)
    && best[1].replace(/\*/g, "").trim().toLowerCase().startsWith(`${name.toLowerCase()} benefits from`);
}

app.get("/api/champion-tips", async (req, res) => {
  const { name, cost, traits, traitBreakpoints, role, abilityName, abilityDesc, topItems, unitId } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });
  const set = setFrom(req);
  const vocab = setVocabulary(set);

  const proItemStats = proUnitStats(unitId, set);
  const proItemBlock = proItemStats
    ? `\nTop items on ${name} in our Challenger/GM dataset (ranked by top-4 rate):\n${proItemStats}`
    : "";
  const validItems = vocab.items.length ? vocab.items.join(", ") : "(not available)";
  const validTraits = vocab.traits.length ? vocab.traits.join(", ") : "(not available)";

  // What this champion's traits actually do — stops the model guessing trait effects
  const traitInfo = Object.values(calcDataFor(set)?.traits || {});
  const traitDescs = (traits || "").split(",").map(n => n.trim()).filter(Boolean)
    .map(n => traitInfo.find(t => t.name === n))
    .filter(t => t && t.desc)
    .map(t => `- ${t.name}: ${t.desc}`)
    .join("\n");
  const traitDescBlock = traitDescs
    ? `\nWHAT ${name.toUpperCase()}'S TRAITS DO (authoritative; "X" = amount not published — never invent a number for it):\n${traitDescs}\n`
    : "";

  // Trait-language example built from this champion's own first breakpoint, e.g. "3 Elderwood"
  const bp = (traitBreakpoints || "").match(/([^,(]+)\((\d+)/);
  const traitExample = bp ? `${bp[2]} ${bp[1].trim()}` : "3 of a trait";

  const prompt = `You are a TFT Set ${set} expert coach as of ${SET_PATCH[set]}.

CHAMPION: ${name}
Cost: ${cost}g | Role: ${role}
Traits (with valid breakpoints): ${traitBreakpoints || traits}
Ability: ${abilityName} — ${abilityDesc}
Top items from Challenger data: ${topItems || "none provided"}${proItemBlock}

VALID SET ${set} ITEMS (mention no other items): ${validItems}
VALID SET ${set} TRAITS (mention no other traits): ${validTraits}
${traitDescBlock}
STRICT RULES — you must follow these exactly:
- Only mention items from the VALID ITEMS list and traits from the VALID TRAITS list. Never mention traits, items, or mechanics from other sets.
- Recommend items from the Challenger data first — they are what actually wins on this champion. Only add others if fewer than 3 are given.
- Only reference this champion's trait breakpoints listed above. Do not make up breakpoint numbers.
- Describe what a trait does ONLY using the trait descriptions above. If no description is given, name the trait level without explaining its effect.
- Match items to the champion's role. Tanks and supports want durability items, not damage-carry items.
- Be specific and concise. No filler. 1-2 sentences per section.
- Use natural trait language: write "${traitExample}", never "the ${bp ? bp[1].trim() : "X"} ${bp ? bp[2] : "N"} breakpoint". Always put the number before the trait name.

Respond with exactly these 3 sections and nothing else:

**Best Items:** ${name} benefits from [Item A] for [reason A], [Item B] for [reason B], and [Item C] for [reason C]. (Reasons 2-5 words. Optional second sentence: if ${name} already has strong base AD/AP/survivability, say what gap to cover — shred, burn, or wounds — or which primary stat to stack.)
**When to Play:** What board state or condition makes ${name} worth building around.
**Key Trait:** The most impactful trait level from the list above and what it gives.`;

  if (!GROQ_API_KEY) return res.json({ tips: "(Groq API key not configured)" });
  try {
    const draft = await callGroq(prompt, 400);

    const checkPrompt = `You are a TFT Set ${set} fact-checker. Correct any errors in these champion tips and return ONLY the corrected tips — no commentary.

CHAMPION: ${name} | Role: ${role}
Traits (with valid breakpoints): ${traitBreakpoints || traits}
VALID SET ${set} ITEMS: ${validItems}
VALID SET ${set} TRAITS: ${validTraits}
${traitDescBlock}
TIPS TO REVIEW:
${draft}

CHECK FOR AND FIX:
- Any item not in VALID ITEMS, or any trait not in VALID TRAITS — replace with a valid one
- Any claim about what a trait does that contradicts or goes beyond the trait descriptions — rewrite it to match the description
- Damage-carry items recommended for a tank or support — replace with durability items
- Trait language like "the X Y breakpoint" — rewrite as "${traitExample}"
- Output must be exactly 3 sections: **Best Items:**, **When to Play:**, **Key Trait:**
- **Best Items:** must start with exactly "${name} benefits from"`;

    const clean = t => t.replace(/^(CHAMPION:.*|Traits \(with.*|VALID SET.*|WHAT .*TRAITS DO.*|TIPS TO REVIEW:\s*)\n?/gim, "").trim();
    let tips = clean(await callGroq(checkPrompt, 400).catch(() => draft));
    // Fact-checker occasionally drops the required opening — fall back to the draft if it was right
    if (!tipsWellFormed(tips, name) && tipsWellFormed(draft, name)) tips = clean(draft);
    if (!tipsWellFormed(tips, name)) console.warn(`[tips] format drift for ${name} (set ${set})`);
    res.json({ tips });
  } catch (e) {
    console.error("champion-tips error:", e.message);
    res.json({ tips: "(Error fetching tips)" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ask — free-form TFT question answered by Groq
// ---------------------------------------------------------------------------
app.post("/api/ask", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });

  console.log(`[ASK] ${new Date().toISOString()} ${question}`);
  if (!process.env.VERCEL) {
    fs.appendFile(
      path.join(__dirname, "logs", "searches.log"),
      `${new Date().toISOString()}\t[ASK]\t${question}\n`,
      () => {}
    );
  }

  const groundingBlock = [
    champSheet  && `Set 18 champions (authoritative — name | cost | traits | role):\n${champSheet}`,
    traitSheet  && `Set 18 trait breakpoints (authoritative — only these breakpoints are real):\n${traitSheet}`,
    itemSheet   && `Set 18 craftable items (authoritative — only these items exist):\n${itemSheet}`,
  ].filter(Boolean).join("\n\n");

  const prompt = `You are an expert TFT (Teamfight Tactics) coach specializing in Set ${CURRENT_SET} as of ${SET_PATCH[CURRENT_SET]}. Answer the following question clearly and concisely. Stay strictly on the topic of TFT — if the question is not related to TFT, politely redirect the user to ask a TFT question instead.

${groundingBlock}

Rules:
- For champion costs, traits, and roles: use only the values from the champion roster above — do not guess.
- For trait breakpoints: use only the breakpoints listed above — do not invent breakpoints.
- For items: only reference items from the craftable items list above — do not invent items.
- For augments, patch-specific numbers, or anything not covered by the data above: answer based on your training data but explicitly flag it as "based on my training data, which may be outdated."
- Be direct and actionable.

Question: ${question}`;

  if (!GEMINI_API_KEY && !GROQ_API_KEY) return res.json({ answer: "(No AI API keys configured)" });

  // Try Gemini with Google Search grounding first — verifies answers against live web results
  if (geminiAvailable()) {
    try {
      const answer = await callGeminiWithSearch(prompt);
      if (answer && !answer.startsWith("(Gemini")) return res.json({ answer });
      console.warn("Gemini+Search empty/error — falling back to Groq for /api/ask");
    } catch (e) {
      console.warn("Gemini+Search threw — falling back to Groq:", e.message);
    }
  }

  // Fall back to Groq (no web search, but still grounded via injected data)
  if (GROQ_API_KEY) {
    try {
      const answer = await callGroq(prompt, 500);
      return res.json({ answer });
    } catch (e) {
      console.error("Groq ask error:", e.message);
    }
  }

  res.json({ answer: "(AI services temporarily unavailable — please try again in a minute.)" });
});

// ---------------------------------------------------------------------------
// Game Plan tree (public/gameplan.html): opener → comp → augments at 2-1/3-2/4-2
// + roll/level timing. Data from src/build_gameplan_data.py (bunnymuffins.lol
// guides + tactics.tools augment list) and gameplan_notes.json (distilled from
// coaching video transcripts). The guide text grounds the AI only — the page gets
// structured facts.
// ---------------------------------------------------------------------------

const readStaticJson = (name) => {
  const p = path.join(__dirname, "data", "static", name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const gameplanData = readStaticJson("gameplan_data.json");
const gameplanNotes = readStaticJson("gameplan_notes.json");
const GP_STAGES = ["2-1", "3-2", "4-2"];
const gpKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9+]/g, "");
const gpAugByName = new Map(
  Object.values(gameplanData?.augments || {}).map(a => [gpKey(a.name), a])
);

// Hidden page (public/plan-*/ has a noindex meta): keep its data API out of search engines too
app.use(["/api/gameplan", "/api/gameplan-augments"], (_req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});

app.get("/api/gameplan", (_req, res) => {
  if (!gameplanData) return res.status(503).json({ error: "Game plan data not built — run src/build_gameplan_data.py" });
  const comps = gameplanData.comps.map(c => ({
    id: c.id, name: c.name, short: c.short.trim(), tier: c.tier, style: c.style, strategy: c.strategy,
    difficulty: c.difficulty, mainChampion: c.mainChampion, traits: c.traits, augments: c.augments, augmentTypes: c.augmentTypes,
    itemPriority: c.itemPriority, earlyComp: c.earlyComp, finalComp: c.finalComp, url: c.url,
    carries: c.carries, tanks: c.tanks, support: c.support, lean: c.lean, wants: c.wants,
    leveling: c.leveling, levelingNotes: c.levelingNotes,
    bm: c.bm && { name: c.bm.name, conditions: c.bm.conditions, itemHolders: c.bm.itemHolders, bis: c.bm.augments?.bis || [],
                  teamCode: c.bm.teamCode, builderUrl: c.bm.builderUrl },
  }));
  const augments = Object.values(gameplanData.augments)
    .filter(a => a.stages.length)
    .map(a => ({ name: a.name, tier: a.tier, stages: a.stages, desc: a.desc, icon: a.icon, tags: a.tags, traits: a.traits }));
  res.json({
    patch: gameplanData.patch, updated: gameplanData.updated, comps, augments,
    bmCompToTfta: gameplanData.bmCompToTfta,
    openerRules: gameplanData.openerGuide.rules, hardForce: gameplanData.openerGuide.hardForce,
  });
});

// Simple per-IP limiter: each call can hit Gemini+Search (5,000 free/month)
const gpHits = new Map();
function gpRateLimited(ip, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const hits = (gpHits.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  gpHits.set(ip, hits);
  return hits.length > limit;
}

const gpCache = new Map(); // key → { at, body }
const GP_CACHE_MS = 6 * 60 * 60 * 1000;

// Shortlist the augments worth showing the AI — Groq's free tier caps a request at
// 8k tokens, and 150+ augments with descriptions blow past that.
const GP_STRAT_WORDS = {
  fast9: /fast 9|fast 8\/9|level 9|econ|5 cost/i, fast8: /fast 8|fast 8\/9|econ|4 cost/i,
  reroll1: /reroll|1 cost|1-cost|1-3 cost/i, reroll2: /reroll|2 cost|1\/2 cost/i, reroll3: /reroll|3 cost|1-3 cost/i,
};
const GP_TYPE_WORDS = { Econ: /econ|gold|interest|xp/i, Items: /item|component|anvil|forge/i,
  Combat: /combat|tank|carry|frontline/i, Emblems: /emblem|trait/i, Trait: /emblem|trait/i, Reroll: /reroll/i };
function gpShortlist(comp, candidates, max = 40) {
  const recommended = new Set(comp.augments.map(gpKey));
  (comp.bm?.augments?.bis || []).forEach(a => recommended.add(gpKey(a)));
  const words = comp.short.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const stratRe = GP_STRAT_WORDS[comp.strategy];
  const types = comp.augmentTypes.map(t => GP_TYPE_WORDS[t]).filter(Boolean);
  const score = (a) => {
    const g = `${a.guide || ""} ${a.name}`;
    let s = recommended.has(gpKey(a.name)) ? 20 : 0;
    if (stratRe?.test(g)) s += 4;
    if (words.some(w => g.toLowerCase().includes(w))) s += 4;
    types.forEach((re, i) => { if (re.test(g)) s += 3 - i; });
    if (/generic/i.test(g)) s += 1;
    if (!a.guide) s -= 1;
    return s;
  };
  return candidates.map(a => [score(a), a]).sort((x, y) => y[0] - x[0]).slice(0, max).map(x => x[1]);
}

function gpNotesFor(comp, stage, candidateNames) {
  const n = gameplanNotes;
  if (!n) return "";
  const lower = new Set(candidateNames.map(gpKey));
  const words = comp.short.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !/reroll|fast|flex/.test(w));
  const list = (arr, max) => (arr || []).slice(0, max).map(s => `- ${s}`).join("\n");
  return [
    stage === "2-1" && `Early game:\n${list(n.earlyGame, 8)}`,
    `Augment principles:\n${list(n.augmentPrinciples, 8)}`,
    `Augment notes:\n${(n.augmentSpecific || [])
      .filter(a => lower.has(gpKey(a.augment || "")))
      .slice(0, 10).map(a => `- ${a.augment}: ${a.advice}`).join("\n")}`,
    `Leveling/rolling:\n${list([...(n.levelingRolling?.[comp.strategy] || []), ...(n.levelingRolling?.general || []).slice(0, 4)], 10)}`,
    `Comp notes:\n${(n.comps || [])
      .filter(c => words.some(w => (c.comp || "").toLowerCase().includes(w)))
      .slice(0, 3).map(c => `- ${c.comp}: ${c.advice}`).join("\n")}`,
  ].filter(s => s && !/:\n$/.test(s)).join("\n");
}

function gpParseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// POST /api/gameplan-augments
// { compId, stage: "2-1"|"3-2"|"4-2", chosen: [augment names], offered?: [3 names],
//   streak?: "win"|"lose"|"mixed", hp?: number }
// Off until the if-then tree is settled — set GAMEPLAN_AI=1 to enable
app.post("/api/gameplan-augments", async (req, res) => {
  if (process.env.GAMEPLAN_AI !== "1") return res.status(404).json({ error: "Not found" });
  if (!gameplanData) return res.status(503).json({ error: "Game plan data not built" });
  if (gpRateLimited(req.ip)) return res.status(429).json({ error: "Too many requests — wait a minute." });

  const { compId, stage } = req.body || {};
  const comp = gameplanData.comps.find(c => c.id === compId);
  if (!comp) return res.status(400).json({ error: "Unknown comp" });
  if (!GP_STAGES.includes(stage)) return res.status(400).json({ error: "stage must be 2-1, 3-2 or 4-2" });
  const toAugs = (arr, max) => (Array.isArray(arr) ? arr : []).slice(0, max)
    .map(s => gpAugByName.get(gpKey(s))).filter(Boolean);
  const chosen = toAugs(req.body.chosen, 2);
  const offered = toAugs(req.body.offered, 4).filter(a => a.stages.includes(stage));
  const streak = ["win", "lose", "mixed"].includes(req.body.streak) ? req.body.streak : null;
  const hp = Number.isFinite(+req.body.hp) && +req.body.hp > 0 ? Math.min(100, Math.round(+req.body.hp)) : null;

  const key = JSON.stringify([comp.id, stage, chosen.map(a => a.name), offered.map(a => a.name).sort(), streak, hp && Math.round(hp / 20)]);
  const hit = gpCache.get(key);
  if (hit && Date.now() - hit.at < GP_CACHE_MS) return res.json({ ...hit.body, cached: true });

  const taken = new Set(chosen.map(a => a.name));
  const candidates = offered.length ? offered
    : gpShortlist(comp, Object.values(gameplanData.augments).filter(a => a.stages.includes(stage) && !taken.has(a.name)));
  const augLine = (a) => `${a.name} [${a.tier || "?"}]: ${a.guide || (a.desc || "").slice(0, 90)}`;
  const stageNo = stage[0];
  const tips = comp.tips.filter(t => (t.stage || "").includes(stageNo) || (stage === "4-2" && /5|late/i.test(t.stage || "")));
  const bm = comp.bm;
  const bmStage = bm?.plan?.[{ "2-1": "stage2", "3-2": "stage3", "4-2": "stage4" }[stage]];
  const nextStage = GP_STAGES[GP_STAGES.indexOf(stage) + 1];
  const table = comp.leveling.map(r => `${r.label}: ${r.steps.map(s => `${s.round}→L${s.level}`).join(", ")}`).join("\n");

  const prompt = `You are a Challenger TFT coach for Set ${CURRENT_SET} (patch ${gameplanData.patch || SET_PATCH[CURRENT_SET]}). The player is weak at early game and augment choice. Recommend augments for the ${stage} augment round.

COMP: ${comp.name} — ${comp.style}, tier ${comp.tier}, carry ${comp.mainChampion}
Final board: ${comp.finalComp.map(u => `${u.name}${u.stars > 1 ? ` ${u.stars}*` : ""}${u.items.length ? ` (${u.items.join(", ")})` : ""}`).join("; ")}
TFT Academy recommended augments: ${comp.augments.join(", ")}
Augment type priority: ${comp.augmentTypes.join(" > ")}${comp.augmentsTip ? `\nAugment tip: ${comp.augmentsTip}` : ""}
${tips.map(t => `${t.stage}: ${t.tip}`).join("\n")}${bm ? `\nPlay it if: ${bm.conditions.join("; ")}${bmStage ? `\nThis stage: ${bmStage}` : ""}` : ""}
Leveling: ${table || comp.levelingNotes.slice(0, 3).join(" ")}

PLAYER: taken so far: ${chosen.length ? chosen.map(a => a.name).join(", ") : "none"}${streak ? `; ${streak} streak` : ""}${hp ? `; ${hp} HP` : ""}
${(gameplanData.augmentPrinciples || []).join(" ")}
${gpNotesFor(comp, stage, candidates.map(a => a.name))}

${offered.length ? "OFFERED (rank all of them):" : `CHOICES at ${stage} (only these are valid):`}
${candidates.map(augLine).join("\n")}

Rules: name only augments from the list above, spelled exactly. Account for augments already taken and what the comp needs at ${nextStage || "the end of the game"}. Use search only to check whether an augment is over/under-performing this patch. Each "why" is one concrete sentence, max 20 words.
Reply with ONLY this JSON:
{"picks":[{"name":"","why":""}],"avoid":[{"name":"","why":""}],"roll":"1-2 sentences: what to do with gold and levels from ${stage} to ${nextStage || "the end"}${streak ? ` on a ${streak} streak` : ""}","nextStage":"${nextStage ? `1 sentence: what kind of augment to want at ${nextStage}` : ""}"}
${offered.length ? "picks = every offered augment, best first." : "picks = 6 best, best first; avoid = up to 3 tempting traps for this comp."}`;

  console.log(`[gameplan] ${comp.id} ${stage} — prompt ${prompt.length} chars`);
  let raw = null, model = null;
  if (geminiAvailable()) {
    try { raw = await callGeminiWithSearch(prompt); model = "gemini"; }
    catch (e) { console.warn("gameplan Gemini failed — falling back to Groq:", e.message); }
  }
  let parsed = raw && gpParseJson(raw);
  if (!parsed && GROQ_API_KEY) {
    try { raw = await callGroq(prompt, 700); model = "groq"; parsed = gpParseJson(raw); }
    catch (e) { console.error("gameplan Groq failed:", e.message); }
  }
  if (!parsed) return res.status(502).json({ error: "AI services unavailable — try again in a minute." });

  // Keep only real, stage-legal augments
  const legal = new Map(candidates.map(a => [gpKey(a.name), a]));
  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map(p => ({ aug: legal.get(gpKey(p?.name || "")), why: String(p?.why || "").slice(0, 200) }))
    .filter(p => p.aug)
    .map(p => ({ name: p.aug.name, tier: p.aug.tier, icon: p.aug.icon, desc: p.aug.desc, why: p.why }));
  const body = {
    picks: clean(parsed.picks).slice(0, offered.length || 6),
    avoid: clean(parsed.avoid).slice(0, 3),
    roll: String(parsed.roll || "").slice(0, 400),
    nextStage: String(parsed.nextStage || "").slice(0, 300),
    model,
  };
  if (!body.picks.length) return res.status(502).json({ error: "AI returned no valid augments — try again." });
  gpCache.set(key, { at: Date.now(), body });
  res.json(body);
});

// ---------------------------------------------------------------------------
// /api/local-coach — reads TFTAcademy's local SQLite DB and coaches on your
// actual games (item redundancy, augment decisions, missed synergies).
// Only works when the server is running on the same machine as TFTAcademy.
// ---------------------------------------------------------------------------

// Matched by display name, not ID: Riot reuses legacy IDs across sets
// ("TFT_Item_StatikkShiv" is Void Staff in Set 18) and Set 18 uses "DA_*" IDs.
const UNIQUE_ITEMS = new Set([
  "Gargoyle Stoneplate", "Sunfire Cape", "Protector's Vow", "Spirit Visage",
]);

const CONFLICT_PAIRS = [
  ["Giant Slayer", "Kraken's Fury",
   "both are anti-tank damage — one source is usually enough"],
  ["Infinity Edge", "Jeweled Gauntlet",
   "both scale with crit — Infinity Edge alone makes crits shine"],
  ["Spear of Shojin", "Blue Buff",
   "both funnel mana — one is enough unless the ability cost is extreme"],
];

function lcReadable(apiName) {
  // Use CommunityDragon names if loaded, else strip prefix + split CamelCase
  if (itemNames[apiName]) return itemNames[apiName];
  if (champNames[apiName]) return champNames[apiName];
  let s = apiName
    .replace(/^TFT\d*_Item_Artifact_/, "[Artifact] ")
    .replace(/^TFT\d*_Item_|^DA_/, "")
    .replace(/^TFT\d*_Augment_/, "")
    .replace(/^TFT\d+_/, "")
    .replace(/^TFT_/, "");
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

function lcParseBoards(events) {
  const timeline = {};
  for (const { event_type, round, data } of events) {
    if (event_type !== "board" || !data) continue;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }
    const units = {};
    for (const [, unit] of Object.entries(obj)) {
      const name = unit.name || "";
      if (!name || name.includes("PVE")) continue;
      const items = [unit.item_1, unit.item_2, unit.item_3]
        .filter(i => i && !i.includes("EmptyBag"));
      units[name] = { stars: unit.level || "1", items };
    }
    if (Object.keys(units).length) timeline[round] = units;
  }
  return timeline;
}

function lcFinalBoard(timeline) {
  const rounds = Object.keys(timeline);
  if (!rounds.length) return {};
  rounds.sort((a, b) => {
    const [as, ar] = a.split("-").map(Number);
    const [bs, br] = b.split("-").map(Number);
    return as !== bs ? as - bs : ar - br;
  });
  return timeline[rounds[rounds.length - 1]];
}

function lcParseAugments(events) {
  const offers = {};   // round -> Set of option names
  const chosen = [];   // [{round, picked:[]}]
  let prevEquipped = new Set();

  for (const { event_type, round, data } of events) {
    if (event_type !== "me" || !data) continue;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }
    if (typeof obj !== "object") continue;

    // Offer screen (augment_1/2/3 keys)
    if (obj.augment_1 !== undefined) {
      const opts = [obj.augment_1, obj.augment_2, obj.augment_3]
        .filter(v => v?.name).map(v => v.name);
      if (opts.length) {
        if (!offers[round]) offers[round] = new Set();
        opts.forEach(o => offers[round].add(o));
      }
    }

    // Chosen augments (slot_1/2/3/4 keys)
    if (obj.slot_1 !== undefined) {
      const equipped = new Set(
        Object.entries(obj)
          .filter(([k, v]) => k.startsWith("slot_") && v?.name)
          .map(([, v]) => v.name)
      );
      const newPicks = [...equipped].filter(a => !prevEquipped.has(a));
      if (newPicks.length) chosen.push({ round, picked: newPicks });
      prevEquipped = equipped;
    }
  }
  return { chosen, offers };
}

function lcDetectIssues(board) {
  const issues = [];
  for (const [name, info] of Object.entries(board)) {
    const unit = lcReadable(name);
    const items = info.items;

    // Duplicate items
    const counts = {};
    for (const item of items) counts[item] = (counts[item] || 0) + 1;
    for (const [item, n] of Object.entries(counts)) {
      if (n > 1) issues.push(`${unit} has ${n}× ${lcReadable(item)} — duplicate item wastes a slot`);
    }

    // Unique-passive items equipped twice
    for (const item of items) {
      if (UNIQUE_ITEMS.has(lcReadable(item)) && items.filter(i => i === item).length > 1) {
        issues.push(`${unit}: ${lcReadable(item)} has a unique passive — second copy gives no extra benefit`);
      }
    }

    // Conflicting pairs
    const names = items.map(lcReadable);
    for (const [a, b, reason] of CONFLICT_PAIRS) {
      if (names.includes(a) && names.includes(b)) {
        issues.push(`${unit}: ${a} + ${b} — ${reason}`);
      }
    }
  }
  return issues;
}

function lcFormatBoard(board) {
  return Object.entries(board)
    .map(([name, info]) => {
      const items = info.items.map(lcReadable).join(", ") || "no items";
      return `  ${lcReadable(name)} (${info.stars}*): ${items}`;
    })
    .join("\n") || "  (empty)";
}

function lcFormatAugments(chosen, offers) {
  return chosen.map(({ round, picked }) => {
    const pickedNames = picked.map(lcReadable).join(", ");
    const allOffered = offers[round] ? [...offers[round]] : [];
    const skipped = allOffered.filter(o => !picked.includes(o)).map(lcReadable).join(", ");
    return `  Round ${round}: chose → ${pickedNames}` +
           (skipped ? `\n             skipped → ${skipped}` : "");
  }).join("\n") || "  (no augment data)";
}

app.post("/api/local-coach", async (req, res) => {
  // Block this endpoint on hosted platforms — only works locally, and node:sqlite
  // is experimental so we require it lazily to avoid crashing serverless cold starts.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL) {
    return res.status(403).json({ error: "This endpoint only works when running the server locally." });
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (e) {
    return res.status(500).json({ error: `node:sqlite unavailable: ${e.message}` });
  }

  const { dbPath, numGames = 3 } = req.body;
  if (!dbPath || typeof dbPath !== "string") {
    return res.status(400).json({ error: "dbPath is required." });
  }

  // Reject path traversal attempts
  const resolved = path.resolve(dbPath);
  if (!resolved.endsWith(".db") && !resolved.endsWith(".sqlite")) {
    return res.status(400).json({ error: "dbPath must point to a .db or .sqlite file." });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: `Database not found at: ${resolved}` });
  }

  let db;
  try {
    db = new DatabaseSync(resolved, { open: true });
  } catch (e) {
    return res.status(500).json({ error: `Could not open database: ${e.message}` });
  }

  try {
    const games = db.prepare(`
      SELECT id, final_placement, started_at
      FROM games
      WHERE final_placement IS NOT NULL
      ORDER BY started_at DESC
      LIMIT ?
    `).all(Math.min(parseInt(numGames) || 3, 10));

    if (!games.length) {
      db.close();
      return res.json({ results: [], message: "No completed games found in this database." });
    }

    const results = [];

    for (const game of games) {
      const events = db.prepare(`
        SELECT event_type, round, data
        FROM events
        WHERE game_id = ? AND event_type IN ('board','me')
        ORDER BY id
      `).all(game.id);

      if (!events.length) {
        results.push({ placement: game.placement || game.final_placement, tips: null, noData: true });
        continue;
      }

      const placement = game.placement || game.final_placement;
      const timeline = lcParseBoards(events);
      const board = lcFinalBoard(timeline);
      if (!Object.keys(board).length) {
        results.push({ placement, tips: null, noData: true });
        continue;
      }

      const { chosen, offers } = lcParseAugments(events);
      const issues = lcDetectIssues(board);

      const boardText = lcFormatBoard(board);
      const augText = lcFormatAugments(chosen, offers);
      const issueText = issues.length
        ? issues.map(i => `  • ${i}`).join("\n")
        : "  (none detected)";

      const prompt = `You are an expert TFT Set 18 coach. A player finished ${placement}th in a game. Analyze their decisions and give specific coaching feedback.

FINAL BOARD:
${boardText}

AUGMENT CHOICES (chose → / skipped →):
${augText}

AUTOMATICALLY DETECTED ITEM ISSUES:
${issueText}

Give coaching in exactly three sections:

**Item Efficiency**
Flag any redundant, conflicting, or role-mismatched items. Name the unit and the specific items. Suggest a replacement if there's a clearly better option.

**Augment Decisions**
For each augment pick, was it correct given the board? If a skipped augment would have been stronger, explain concisely why.

**Top 2 Improvements**
The two highest-impact changes for future games. Be direct — one sentence each.

Keep every bullet to 1–2 sentences. Name specific units, items, and augments.`;

      let tips;
      try {
        tips = await callAI(prompt, 600);   // Gemini → Groq fallback
      } catch (e) {
        tips = `(AI error: ${e.message})`;
      }

      results.push({ placement, board: boardText, tips, issues });
    }

    db.close();
    res.json({ results });
  } catch (e) {
    try { db.close(); } catch {}
    console.error("local-coach error:", e);
    res.status(500).json({ error: e.message });
  }
});

// On Vercel (serverless), export the app — the platform invokes it per request.
// Name mappings load in the background; the /api gate above waits on them.
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // Bind to 0.0.0.0 on Railway (required); localhost only in local dev
  const host = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
  namesReady.then(() => {
    app.listen(PORT, host, () => {
      console.log(`TFT Coach running at http://${host}:${PORT}`);
    });
  });
}
