/**
 * UCB1 multi-armed bandit for per-player coaching focus.
 *
 * Each "arm" maps to a coaching emphasis area. The bandit tracks which focus
 * leads to placement improvement for a specific player and steers future
 * coaching sessions toward the most effective arm.
 *
 * State is persisted to data/bandits/{puuid}.json so it survives server
 * restarts and accumulates across sessions.
 */

const fs   = require("fs");
const path = require("path");

const BANDITS_DIR = path.join(__dirname, "../data/bandits");

// The five coaching arms and what each injects into the prompt
const ARMS = {
  economy: {
    label: "Gold Economy",
    focus: `ADAPTIVE FOCUS — this player's bandit selected ECONOMY this session:
Lead with gold management. Analyze whether they are hoarding (too much gold left) or panic-spending (too little). Give concrete round-interval targets: e.g., "hold 50g through 3-2, roll down to stabilize, push level on 4-1". If their gold-left number suggests a pattern, name it and prescribe the fix.`,
  },
  comp: {
    label: "Comp Flexibility",
    focus: `ADAPTIVE FOCUS — this player's bandit selected COMP FLEXIBILITY this session:
Lead with composition decisions. Address when to commit to a planned comp vs. pivot based on what's available. Highlight if they over-force one comp or, conversely, pivot too late. Reference the comps/traits in their data to give specific, not generic, advice.`,
  },
  items: {
    label: "Item Prioritization",
    focus: `ADAPTIVE FOCUS — this player's bandit selected ITEMS this session:
Lead with item strategy. Discuss how item components should influence early unit choices, when to slam vs. hold components, and how item priorities shift as the game progresses. Be specific about items that pair with their most-played comps.`,
  },
  consistency: {
    label: "Board Consistency",
    focus: `ADAPTIVE FOCUS — this player's bandit selected BOARD CONSISTENCY this session:
Lead with strongest-board discipline. Discuss whether the player commits to their strongest units each round or holds back trying to 3-star weaker units. Address star-level priorities: 2-starring carries before 3-starring cheap units. Connect to their level efficiency data.`,
  },
  meta: {
    label: "Meta Alignment",
    focus: `ADAPTIVE FOCUS — this player's bandit selected META ALIGNMENT this session:
Lead with current patch awareness. Use your Google Search access to look up what comps, augments, and carry units are S-tier on the current patch. Compare against the comps this player is playing and flag any mismatch between their tendencies and what is strong right now.`,
  },
};

const ARM_KEYS = Object.keys(ARMS);

function statePath(puuid) {
  return path.join(BANDITS_DIR, `${puuid}.json`);
}

function loadState(puuid) {
  const p = statePath(puuid);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  // Fresh state
  const arms = {};
  for (const k of ARM_KEYS) arms[k] = { n: 0, rewardSum: 0 };
  return { puuid, arms, totalTrials: 0, baselinePlacement: null, lastSession: null };
}

function saveState(state) {
  fs.mkdirSync(BANDITS_DIR, { recursive: true });
  fs.writeFileSync(statePath(state.puuid), JSON.stringify(state, null, 2));
}

/**
 * UCB1 arm selection.
 * First pass: try each arm once (exploration phase).
 * After that: pick arm with highest UCB1 score.
 */
function selectArm(state) {
  const total = state.totalTrials;

  // Exploration: each arm at least once
  for (const k of ARM_KEYS) {
    if (state.arms[k].n === 0) return k;
  }

  // UCB1
  let best = null;
  let bestScore = -Infinity;
  for (const k of ARM_KEYS) {
    const { n, rewardSum } = state.arms[k];
    const mean = rewardSum / n;
    const bonus = Math.sqrt((2 * Math.log(total)) / n);
    const score = mean + bonus;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best;
}

/**
 * Called at the START of a coaching session.
 * Returns the selected arm key and the focus-area string to inject into the prompt.
 * Also records the session so we can compute reward when the player returns.
 *
 * @param {string} puuid
 * @param {string} handle          - "Name#TAG" for display
 * @param {number} currentAvgPlace - player's avg placement in this session's games
 * @param {string[]} matchIds      - match IDs seen in this session (used to detect new games next time)
 */
function startSession(puuid, handle, currentAvgPlace, matchIds) {
  const state = loadState(puuid);

  // Update baseline on first session (or if no prior baseline)
  if (state.baselinePlacement === null) {
    state.baselinePlacement = currentAvgPlace;
  }

  const arm = selectArm(state);

  state.lastSession = {
    arm,
    handle,
    timestamp: new Date().toISOString(),
    matchIds: matchIds || [],
    placementAtAdvice: currentAvgPlace,
  };

  saveState(state);
  return { arm, armLabel: ARMS[arm].label, focus: ARMS[arm].focus };
}

/**
 * Called at the START of a new coaching session when a prior session exists.
 * Detects new games played since last advice and updates the bandit reward.
 *
 * @param {string} puuid
 * @param {number} newAvgPlace  - avg placement of games played SINCE last session
 * @param {string[]} newMatchIds - full match ID list from the current profile load
 */
function updateReward(puuid, newAvgPlace, newMatchIds) {
  const state = loadState(puuid);
  if (!state.lastSession) return state; // nothing to update

  const prev = state.lastSession;

  // Detect genuinely new games (not in the match list at advice time)
  const prevSet = new Set(prev.matchIds);
  const newGames = (newMatchIds || []).filter(id => !prevSet.has(id));
  if (newGames.length === 0) return state; // player hasn't played since last coaching

  // Reward = improvement in placement (positive = better).
  // We compare new session avg against baseline so the signal is absolute, not
  // relative to the possibly-already-bad session that triggered advice.
  const reward = state.baselinePlacement - newAvgPlace;

  const arm = prev.arm;
  state.arms[arm].n += 1;
  state.arms[arm].rewardSum += reward;
  state.totalTrials += 1;

  // Roll baseline toward new observed avg (exponential moving average, α=0.3)
  state.baselinePlacement = 0.7 * state.baselinePlacement + 0.3 * newAvgPlace;

  // Clear last session so we don't double-count this reward
  state.lastSession = null;

  saveState(state);
  return state;
}

/**
 * Returns a human-readable summary of bandit state for debugging / display.
 */
function summarize(puuid) {
  const state = loadState(puuid);
  const rows = ARM_KEYS.map(k => {
    const { n, rewardSum } = state.arms[k];
    const mean = n > 0 ? (rewardSum / n).toFixed(2) : "—";
    return `  ${ARMS[k].label}: tried=${n}, avg_reward=${mean}`;
  });
  return [
    `Bandit state for ${puuid}`,
    `  Baseline avg placement: ${state.baselinePlacement?.toFixed(2) ?? "none"}`,
    `  Total trials: ${state.totalTrials}`,
    ...rows,
  ].join("\n");
}

module.exports = { startSession, updateReward, summarize, ARMS, ARM_KEYS };
