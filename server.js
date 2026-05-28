require("dotenv").config();
const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 30002;

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Redirect root to the main app
app.get("/", (req, res) => {
  res.redirect("/calculator.html");
});

// ---------------------------------------------------------------------------
// Name mappings from Community Dragon (loaded at startup)
// ---------------------------------------------------------------------------

let champNames = {};  // { "TFT17_Galio": "The Mighty Mech", ... }
let itemNames = {};   // { "TFT17_Item_AstronautEmblemItem": "Meeple Emblem", ... }
let traitNames = {};  // { "TFT17_Astronaut": "Astronaut", ... }

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

function champName(id) { return champNames[id] || id.replace(/TFT\d+_/, ""); }
function itemName(id) { return itemNames[id] || id.replace(/TFT_Item_|TFT\d+_Item_/, "").replace(/([A-Z])/g, " $1").trim(); }
function traitName(id) { return traitNames[id] || id.replace(/TFT\d+_/, ""); }

// ---------------------------------------------------------------------------
// Load processed CSV data at startup
// ---------------------------------------------------------------------------

function loadCsv(filename) {
  const filepath = path.join(__dirname, "data", "processed", filename);
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, "utf8");
  return parse(content, { columns: true, skip_empty_lines: true });
}

// Use slim CSV on Railway (full file is 116MB, over GitHub's limit)
const matchFeatureFile = process.env.RAILWAY_ENVIRONMENT ? "match_features_slim.csv" : "match_features.csv";
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

// Load calculator_data.json — authoritative Set 17 champion/trait/item data
// Used to ground AI prompts with accurate costs, traits, and roles.
const calcData = (() => {
  const p = path.join(__dirname, "data", "static", "calculator_data.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
})();

// Compact champion sheet: one line per champion, for AI system prompts
const champSheet = calcData
  ? Object.values(calcData.units)
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(u => `${u.name} (${u.cost}g) | ${u.traits.join(", ")} | ${u.roleTag?.label || u.role}`)
      .join("\n")
  : null;

// Compact trait sheet: name + valid breakpoints only. Deduplicate by name (keep the entry
// with the most breakpoints when there are multiple under the same display name).
const traitSheet = calcData
  ? (() => {
      const seen = {};
      for (const t of Object.values(calcData.traits)) {
        if (!t.breakpoints.length) continue; // skip empty (e.g. Choose Trait)
        if (!seen[t.name] || t.breakpoints.length > seen[t.name].breakpoints.length) {
          seen[t.name] = t;
        }
      }
      return Object.values(seen)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(t => `${t.name} (${t.breakpoints.map(b => b.minUnits).join("/")}`)
        .join("), ") + ")";
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
function loadTacticsToolsItems() {
  const p = path.join(__dirname, "data", "processed", "tactics_tools_items.json");
  if (!fs.existsSync(p)) return { items: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
let ttItems = loadTacticsToolsItems();
// Build lookup: itemId → stats
const ttItemMap = {};
for (const item of ttItems.items) ttItemMap[item.itemId] = item;
console.log(`Loaded ${ttItems.items.length} tactics.tools items (updated ${new Date(ttItems.lastUpdated * 1000).toLocaleDateString()})`);

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

async function getMatchDetails(matchId) {
  return riotGet("americas.api.riotgames.com", `/tft/match/v1/matches/${matchId}`);
}

async function getRecentMatches(puuid, count = 5, start = 0) {
  const params = `count=${Math.min(count, 200)}&start=${start}&queue=1100`;
  return riotGet("americas.api.riotgames.com", `/tft/match/v1/matches/by-puuid/${puuid}/ids?${params}`);
}

// Fetch match details in small batches to stay within Riot dev-key rate limits
// (20 req/sec, 100 req/2min — a burst of 200 simultaneous calls kills almost all of them)
async function batchMatchDetails(matchIds, batchSize = 10, delayMs = 1100) {
  const results = [];
  for (let i = 0; i < matchIds.length; i += batchSize) {
    const batch = matchIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(id => getMatchDetails(id).catch(e => {
        console.warn(`Match detail fetch failed (${id}):`, e.message);
        return null;
      }))
    );
    results.push(...batchResults);
    if (i + batchSize < matchIds.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
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
      .filter((r) => r.unit_id === unitId)
      .sort((a, b) => parseFloat(b.top4_rate) - parseFloat(a.top4_rate));
    if (!unitRows.length) continue;

    const userCombo = JSON.stringify([...items].sort());
    const userRow = unitRows.find((r) => {
      try { return JSON.stringify(JSON.parse(r.item_combo).sort()) === userCombo; }
      catch { return false; }
    });
    const best = unitRows[0];
    const userRate = userRow ? parseFloat(userRow.top4_rate) : null;
    const bestRate = parseFloat(best.top4_rate);

    if (!userRate || bestRate > userRate + 0.08) {
      const userStr = userRate !== null ? `${(userRate * 100).toFixed(0)}% top-4` : "no pro data";
      issues.push(
        `${unitId}: your items had ${userStr}. ` +
        `Top Challenger build ${best.item_combo} reaches ${(bestRate * 100).toFixed(0)}% top-4 (n=${best.games}).`
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

// Returns top item combos for a unit from the Challenger dataset, formatted for AI prompts.
function proUnitStats(unitId) {
  if (!unitId || !itemWinrates.length) return null;
  const isJunk = id => !ttItemMap[id.replace(/TFT\d*_Item_/, "")];
  const rows = itemWinrates
    .filter(r => {
      if (r.unit_id !== unitId || parseInt(r.games) < 5) return false;
      try {
        const m = r.item_combo.match(/'([^']+)'/g);
        if (!m) return false;
        return !m.map(s => s.replace(/'/g, "")).some(isJunk);
      } catch { return false; }
    })
    .sort((a, b) => parseFloat(b.top4_rate) - parseFloat(a.top4_rate))
    .slice(0, 4);
  if (!rows.length) return null;
  return rows.map(r => {
    let items = [];
    try {
      const m = r.item_combo.match(/'([^']+)'/g);
      if (m) items = m.map(s => s.replace(/'/g, "").replace(/TFT_Item_|TFT\d*_Item_/, "").replace(/([A-Z])/g, " $1").trim());
    } catch {}
    const pct = (parseFloat(r.top4_rate) * 100).toFixed(0);
    return `  • ${items.join(" + ")}: ${pct}% top-4 (${r.games} games)`;
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
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return resolve(text);
            // Log the full response so we can see what Gemini actually returned
            const reason = json.candidates?.[0]?.finishReason || "unknown";
            const blocked = json.promptFeedback?.blockReason;
            console.error("Gemini empty response — finishReason:", reason, "| blockReason:", blocked, "| raw:", JSON.stringify(json).slice(0, 400));
            resolve(`(Gemini returned no text — reason: ${blocked || reason})`);
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
            const reason = json.candidates?.[0]?.finishReason || "unknown";
            const blocked = json.promptFeedback?.blockReason;
            console.error("Gemini+Search empty response — finishReason:", reason, "| blockReason:", blocked, "| raw:", JSON.stringify(json).slice(0, 400));
            resolve(`(Gemini returned no text — reason: ${blocked || reason})`);
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
      max_tokens: maxTokens,
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
  // Try Gemini first if configured
  if (GEMINI_API_KEY) {
    try {
      const result = await callGemini(prompt);
      // callGemini resolves with "(Gemini returned no text..." on failure — detect that
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

  try {
    const puuid = await getPuuid(gameName, tagLine);

    // League rank info
    let rankInfo = null;
    try { rankInfo = await getRankInfo(puuid); } catch {}

    // Fetch enough matches for all-Set-17 banner (capped at 50 to respect dev key rate limits)
    // Promise.all with 200+ simultaneous Riot API calls causes most to 429-fail silently.
    const count = Math.min(parseInt(req.query.count) || 20, 20);
    const allCount = 50;
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
      return {
        matchId: m.metadata.match_id,
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
      };
    };

    const allGames = allMatchesForSet.map(buildGame).filter(Boolean);
    const recentGames = allGames.slice(0, count);

    // Compute separate stat sets
    const allStats = computeStats(allGames);
    const recentStats = computeStats(recentGames);

    // Backwards-compat top-level fields (recent games, for coaching endpoint)
    const { avgPlacement, top4Count, wins, avgLevel, avgGoldLeft, avgLevelEff, goldWastedGames, avgBot4LevelEff, topComps, synergies } = recentStats;

    res.json({
      puuid, rankInfo,
      games: recentGames,
      // all-set-17 aggregates (for top banner)
      allStats,
      // recent-games aggregates (for bottom banner + coaching)
      recentStats,
      // backwards compat flat fields
      avgPlacement, top4Count, wins, total: recentGames.length,
      synergies, avgLevel, avgGoldLeft, avgLevelEff, topComps, goldWastedGames, avgBot4LevelEff
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/puuid?handle=toofxd%23NA1 — resolve Riot ID to PUUID
// POST /api/coaching — generate aggregate coaching from profile stats (called separately so UI can show stats first)
app.post("/api/coaching", async (req, res) => {
  const { avgPlacement, top4Count, wins, total, avgLevel, avgGoldLeft, avgLevelEff, goldWastedGames, avgBot4LevelEff, topComps, synergies, matchIds } = req.body;

  const top4Rate = total ? (top4Count / total * 100).toFixed(0) : 0;
  const winRate  = total ? (wins / total * 100).toFixed(0) : 0;
  const compSummary = (topComps || []).map(c => `${c.name} (${c.games}g, avg #${c.avgPlace}, ${c.top4Pct}% top-4)`).join(", ");
  const synSummary  = (synergies || []).slice(0, 3).map(s => `${s.name} (avg #${s.avgPlacement})`).join(", ");

  const bench = challengerBench;
  const benchBlock = bench
    ? `\nChallenger/GM benchmarks (${bench.games.toLocaleString()} pro games):\n- Avg level efficiency: ${bench.avgLevelEff.toFixed(2)}\n- Avg gold left unspent: ${bench.avgGoldLeft.toFixed(1)}\n- Avg final level: ${bench.avgLevel.toFixed(1)}\n- Overall top-4 rate: ${(bench.top4Rate * 100).toFixed(0)}%`
    : "";

  // Query TFT Academy for aggregate patterns across recent games
  const taAgg = matchIds?.length ? await getTftAcademyData(matchIds) : null;
  const taBlock = fmtAcademyAggregate(taAgg);

  const prompt = `You are a TFT (Teamfight Tactics) coaching assistant analyzing a player's last ${total} games.

Player stats:
- Average placement: ${avgPlacement}
- Top-4 rate: ${top4Rate}% (${top4Count}/${total} games)
- Win rate: ${winRate}% (${wins} wins)
- Average level at end: ${avgLevel}
- Average level efficiency (level/round): ${avgLevelEff}
- Average gold left unspent: ${avgGoldLeft}
- Games with >10 gold left unspent: ${goldWastedGames}/${total}
- Average level efficiency in bottom-4 games: ${avgBot4LevelEff ?? "N/A"}

Most-played comps: ${compSummary || "N/A"}
Best synergies by avg placement: ${synSummary || "N/A"}
${benchBlock}
${taBlock ? `\n${taBlock}` : ""}
Based on these ${total} games, give 4–6 specific, actionable coaching tips. Where the player's numbers differ from the Challenger/GM benchmarks above, call that out explicitly. Where TFT Academy round-by-round data is available, reference specific patterns (level timing, rolling habits, augment choices). Focus on patterns across all games — not a single game. Be direct and concise. Use TFT terminology.`;

  if (!GEMINI_API_KEY && !GROQ_API_KEY) return res.json({ coaching: "(No AI API keys configured)" });
  try {
    const coaching = await callAI(prompt, 600);
    res.json({ coaching });
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
app.get("/api/items", (req, res) => {
  res.json({
    lastUpdated: ttItems.lastUpdated,
    totalEntries: ttItems.totalEntries,
    items: ttItems.items,
  });
});

// GET /api/item-recs?unitId=TFT17_Caitlyn
// Extracts individual items from pro CSV combos, scores each by weighted avg top-4 rate.
app.get("/api/item-recs", (req, res) => {
  const { unitId } = req.query;
  if (!unitId) return res.status(400).json({ error: "unitId required" });

  // Whitelist: only items present in the tactics.tools craftable set
  const isJunk = id => {
    const key = id.replace(/TFT\d*_Item_/, '');
    return !ttItemMap[key];
  };

  // Parse all valid combos for this unit
  const combos = itemWinrates
    .filter(r => r.unit_id === unitId)
    .map(r => {
      let items = [];
      try {
        const match = r.item_combo.match(/'([^']+)'/g);
        if (match) items = match.map(s => s.replace(/'/g, ""));
      } catch {}
      return { items, top4Rate: parseFloat(r.top4_rate), games: parseInt(r.games) };
    })
    .filter(r => r.items.length > 0 && r.games >= 3 && !r.items.some(isJunk));

  // Total unique games for this unit = sum of all combo games (denominator for play rate)
  const totalUnitGames = combos.reduce((s, c) => s + c.games, 0);

  // Aggregate per individual item: weighted avg top-4 rate and total game appearances
  // Use Set to deduplicate items within a combo (e.g. 2× Deathblade counts as one appearance)
  const itemMap = {};
  for (const combo of combos) {
    for (const id of new Set(combo.items)) {
      if (!itemMap[id]) itemMap[id] = { weightedSum: 0, totalGames: 0 };
      itemMap[id].weightedSum += combo.top4Rate * combo.games;
      itemMap[id].totalGames += combo.games;
    }
  }

  const recs = Object.entries(itemMap)
    .map(([id, s]) => ({
      itemId: id,
      top4Rate: s.weightedSum / s.totalGames,
      games: s.totalGames,
      playRate: totalUnitGames > 0 ? parseFloat((s.totalGames / totalUnitGames * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.top4Rate - a.top4Rate)
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

    // Query TFT Academy for round-by-round data (non-blocking, falls back to null)
    const ta = await getTftAcademyData(matchId);
    const taBlock = fmtAcademyGame(ta);

    // Build Gemini prompt
    const bench = challengerBench;
    const prompt = `You are a TFT (Teamfight Tactics) coaching assistant. A player just finished a game.
Here is their performance compared to Challenger/GM-level players (dataset: ${bench ? bench.games.toLocaleString() : "N/A"} pro games):

Comp: ${feats.topTrait}
Final placement: ${feats.placement}
Level: ${feats.level} | Gold left: ${feats.goldLeft} | Eliminated round: ${feats.lastRound}
Level efficiency: ${feats.levelEfficiency.toFixed(2)} ${pro ? `(Challenger avg for this comp: ${pro.avgLevelEff.toFixed(2)}, overall Challenger avg: ${bench ? bench.avgLevelEff.toFixed(2) : "N/A"})` : bench ? `(overall Challenger avg: ${bench.avgLevelEff.toFixed(2)})` : ""}
Gold left: ${feats.goldLeft} ${pro ? `(Challenger avg for this comp: ${pro.avgGoldLeft.toFixed(1)}, overall Challenger avg: ${bench ? bench.avgGoldLeft.toFixed(1) : "N/A"})` : bench ? `(overall Challenger avg: ${bench.avgGoldLeft.toFixed(1)})` : ""}
${pro ? `This comp has ${(pro.top4Rate * 100).toFixed(0)}% top-4 rate in Challenger across ${pro.games} games.` : ""}

Item issues (based on Challenger item win rates):
${itemIssues.length ? itemIssues.join("\n") : "None detected."}
${taBlock ? `\nRound-by-round data from TFT Academy (your actual in-game decisions):\n${taBlock}` : ""}
Write 3–5 concise, specific coaching suggestions. Be direct and actionable. Use TFT terminology naturally. Where round-by-round data is available, reference specific rounds and decisions. Do not repeat raw numbers — synthesize them into advice.`;

    let coachingText = "(No AI API keys configured)";
    if (GEMINI_API_KEY || GROQ_API_KEY) {
      coachingText = await callAI(prompt, 500);
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
app.get("/api/champion-tips", async (req, res) => {
  const { name, cost, traits, traitBreakpoints, role, abilityName, abilityDesc, topItems, unitId } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });

  const proItemStats = proUnitStats(unitId);
  const proItemBlock = proItemStats
    ? `\nTop item combos from our Challenger/GM dataset (${matchFeatures.length.toLocaleString()} pro games):\n${proItemStats}`
    : "";

  const prompt = `You are a TFT Set 17 expert coach on patch 16.10.

CHAMPION: ${name}
Cost: ${cost}g | Role: ${role}
Traits: ${traitBreakpoints || traits}
Ability: ${abilityName} — ${abilityDesc}
Top items from Challenger data: ${topItems || "none provided"}${proItemBlock}

STRICT RULES — you must follow these exactly:
- Only reference real TFT Set 17 items. TFT items are crafted from components (B.F. Sword, Recurve Bow, Chain Vest, Negatron Cloak, Needlessly Large Rod, Tear of the Goddess, Giant's Belt, Sparring Gloves, Spatula). Examples of valid items: Deathblade, Guinsoo's Rageblade, Kraken Slayer, Giant Slayer, Bloodthirster, Sterak's Gage, Edge of Night, Titan's Resolve, Warmog's Armor, Sunfire Cape, Gargoyle Stoneplate, Rabadon's Deathcap, Jeweled Gauntlet, Spear of Shojin, Blue Buff, Nashor's Tooth, Hextech Gunblade, Red Buff, Last Whisper, Bramble Vest, Ionic Spark. Do NOT invent items.
- Only reference trait breakpoints that were provided above. Do not make up breakpoint numbers.
- If topItems are provided, prioritize recommending those.
- Be specific and concise. No filler. 1-2 sentences per section.
- For Best Items: format the first sentence exactly as "[Name] benefits from [Item A] for [reason A], [Item B] for [reason B], and [Item C] for [reason C]." Reasons should be short (2-5 words). If the champion already has strong base AD, AP, or survivability from their ability/traits, note that they need to improve something else (e.g. shred, burn, wound) or stack their primary stat further. Mention sunder/armor shred (Last Whisper), burn (Sunfire Cape / Red Buff), or grievous wounds (Morellonomicon / Red Buff) when relevant to this champion's damage type or the current meta.

Respond with exactly these 3 sections. No intro, no outro:

**Best Items:** First sentence must follow the "[Name] benefits from A for X, B for Y, and C for Z" format. One follow-up sentence max.
**When to Play:** What board state, augment, or condition makes this champion worth building around.
**Key Trait:** Name the most impactful trait breakpoint from the list above and what it gives.`;

  if (!GROQ_API_KEY) return res.json({ tips: "(Groq API key not configured)" });
  try {
    const tips = await callGroq(prompt, 400);
    res.json({ tips });
  } catch (e) {
    console.error("Groq champion-tips error:", e.message);
    res.json({ tips: "(Error fetching tips)" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ask — free-form TFT question answered by Groq
// ---------------------------------------------------------------------------
app.post("/api/ask", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });

  const groundingBlock = [
    champSheet  && `Set 17 champions (authoritative — name | cost | traits | role):\n${champSheet}`,
    traitSheet  && `Set 17 trait breakpoints (authoritative — only these breakpoints are real):\n${traitSheet}`,
    itemSheet   && `Set 17 craftable items (authoritative — only these items exist):\n${itemSheet}`,
  ].filter(Boolean).join("\n\n");

  const prompt = `You are an expert TFT (Teamfight Tactics) coach specializing in Set 17 patch 16.10. Answer the following question clearly and concisely. Stay strictly on the topic of TFT — if the question is not related to TFT, politely redirect the user to ask a TFT question instead.

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
  if (GEMINI_API_KEY) {
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

// Bind to 0.0.0.0 on Railway (required); localhost only in local dev
const host = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
loadNameMappings().then(() => {
  app.listen(PORT, host, () => {
    console.log(`TFT Coach running at http://${host}:${PORT}`);
  });
});
