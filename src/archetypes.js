/**
 * Comp archetypes (reroll / flex / fast 9) from the K-Means in src/train.py,
 * exported to models/archetypes.json.
 *
 * A game is classified by its final board's average shop cost and average star
 * level — nearest centroid in the scaler's space. Each archetype carries its own
 * Challenger/GM top-4 benchmarks, so a reroll game is judged against winning reroll
 * boards (level 8, ~2.3★) instead of the overall field (level 9, ~1.9★).
 */

const fs   = require("fs");
const path = require("path");

const ARCHETYPES_PATH = path.join(__dirname, "../models/archetypes.json");

function loadArchetypes(p = ARCHETYPES_PATH) {
  if (!fs.existsSync(p)) return null;
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  a.byKey = Object.fromEntries(a.archetypes.map(x => [x.key, x]));
  return a;
}

/** Average shop cost of a Riot participant's units; summons/unknown units are skipped. */
function avgUnitCost(model, units) {
  const known = (units || []).map(u => model.unit_costs[u.character_id]).filter(c => c != null);
  return known.length ? known.reduce((s, c) => s + c, 0) / known.length : null;
}

/** @returns archetype object, or null when the board has no costed units */
function classify(model, { avg_unit_cost, unit_star_avg }) {
  if (avg_unit_cost == null || unit_star_avg == null) return null;
  const vals = { avg_unit_cost, unit_star_avg };
  const x = model.features.map((f, i) => (vals[f] - model.scaler_mean[i]) / model.scaler_scale[i]);
  let best = null, bestD = Infinity;
  for (const a of model.archetypes) {
    const d = a.centroid.reduce((s, c, i) => s + (c - x[i]) ** 2, 0);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/**
 * Per-archetype summary of a player's games vs the pros in the same archetype.
 * @param games [{ archetype, placement, level, goldLeft, unitStarAvg }]
 */
function summarize(model, games) {
  const median = arr => {
    const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return model.archetypes.map(a => {
    const g = games.filter(x => x.archetype === a.key);
    if (!g.length) return null;
    const avg = k => g.reduce((s, x) => s + x[k], 0) / g.length;
    return {
      key: a.key,
      label: a.label,
      games: g.length,
      avgPlacement: +avg("placement").toFixed(2),
      top4Rate: +(g.filter(x => x.placement <= 4).length / g.length).toFixed(2),
      you: { level: median(g.map(x => x.level)), unitStarAvg: +avg("unitStarAvg").toFixed(2), goldLeft: median(g.map(x => x.goldLeft)) },
      pro: { level: a.benchmarks.level, unitStarAvg: a.benchmarks.unit_star_avg, goldLeft: a.benchmarks.gold_left,
             avgPlacement: a.benchmarks.avg_placement, games: a.benchmarks.games },
    };
  }).filter(Boolean);
}

module.exports = { loadArchetypes, avgUnitCost, classify, summarize };
