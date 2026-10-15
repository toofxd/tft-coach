/**
 * Counterfactual placement coach.
 *
 * Runs the placement MLP trained in src/train.py (exported to models/mlp_weights.json)
 * in plain JS. For each of a player's games it predicts placement, then re-predicts with
 * one habit fixed to the Challenger/GM top-4 median. The habit whose fix moves predicted
 * placement most is the player's biggest weakness.
 *
 * Model inputs are end-of-game state only (level, gold left, stars, traits, items) —
 * see the NUMERIC_COLS comment in train.py for why survival time is excluded.
 */

const fs   = require("fs");
const path = require("path");

const WEIGHTS_PATH = path.join(__dirname, "../models/mlp_weights.json");

// How each counterfactual feature is described to the player and the AI
const FEATURE_LABELS = {
  gold_left:     { label: "Gold left unspent", unit: "g",  digits: 0 },
  level:         { label: "Final level",       unit: "",   digits: 1 },
  unit_star_avg: { label: "Board star level",  unit: "★",  digits: 2 },
};

function loadModel(weightsPath = WEIGHTS_PATH) {
  if (!fs.existsSync(weightsPath)) return null;
  const m = JSON.parse(fs.readFileSync(weightsPath, "utf8"));
  m.traitIndex = new Map(m.traits.map((t, i) => [t, i]));
  return m;
}

// Linear → ReLU → Linear → ReLU → Linear (dropout is a no-op at inference)
function forward(model, x) {
  let h = x;
  model.layers.forEach((layer, li) => {
    const out = new Array(layer.b.length);
    for (let i = 0; i < layer.b.length; i++) {
      const w = layer.W[i];
      let s = layer.b[i];
      for (let j = 0; j < h.length; j++) s += w[j] * h[j];
      out[i] = li < model.layers.length - 1 ? Math.max(0, s) : s;
    }
    h = out;
  });
  return h;
}

/** Probability-weighted placement 1–8, matching expected_placement() in train.py. */
function predictPlacement(model, feats) {
  const x = model.numeric_cols.map((c, i) => ((feats[c] ?? 0) - model.scaler_mean[i]) / model.scaler_scale[i]);
  const oneHot = new Array(model.traits.length).fill(0);
  const ti = model.traitIndex.get(feats.top_trait);
  if (ti !== undefined) oneHot[ti] = 1;  // unseen trait → all zeros
  const logits = forward(model, x.concat(oneHot));
  const max = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.reduce((s, e, i) => s + (e / sum) * (i + 1), 0);
}

/**
 * @param games  [{ level, gold_left, active_trait_count, unit_star_avg, unit_count,
 *                  item_concentration, top_trait }]
 * @param targetsFor  optional (gameIndex) → { feature: value } overriding the overall
 *          Challenger target for that game (e.g. its archetype's top-4 benchmarks)
 * @returns { predicted: number[], weaknesses: [...] } — weaknesses sorted by placements
 *          gained per game, biggest first. A game only counts toward a feature when the
 *          player was on the wrong side of the Challenger value.
 */
function counterfactuals(model, games, targetsFor = () => ({})) {
  const predicted = games.map(g => predictPlacement(model, g));
  const weaknesses = Object.entries(model.counterfactual_targets).map(([feature, { value: overall, better }]) => {
    let totalGain = 0, affected = 0, playerSum = 0, targetSum = 0;
    games.forEach((g, i) => {
      const v = g[feature] ?? 0;
      const value = targetsFor(i)[feature] ?? overall;
      playerSum += v;
      targetSum += value;
      const worse = better === "lower" ? v > value : v < value;
      if (!worse) return;
      affected++;
      totalGain += predicted[i] - predictPlacement(model, { ...g, [feature]: value });
    });
    const value = targetSum / games.length;  // average target across games (varies by archetype)
    const meta = FEATURE_LABELS[feature] || { label: feature, unit: "", digits: 2 };
    return {
      feature,
      label: meta.label,
      playerAvg: +(playerSum / games.length).toFixed(meta.digits),
      target: +value.toFixed(meta.digits),
      unit: meta.unit,
      placesPerGame: +(totalGain / games.length).toFixed(2),
      gamesAffected: affected,
      games: games.length,
    };
  }).sort((a, b) => b.placesPerGame - a.placesPerGame);
  return { predicted: predicted.map(p => +p.toFixed(2)), weaknesses };
}

module.exports = { loadModel, predictPlacement, counterfactuals, FEATURE_LABELS };
