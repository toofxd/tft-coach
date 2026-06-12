"""
Generates calculator.html from calculator_data.json.
Run: python src/build_calculator.py
"""
import json
from pathlib import Path

DATA_PATH = Path(__file__).parent.parent / "data" / "static" / "calculator_data.json"
OUT_PATH = Path(__file__).parent.parent / "public" / "calculator.html"

data = json.load(open(DATA_PATH, encoding="utf-8"))
data_json = json.dumps(data, separators=(",", ":"), ensure_ascii=False)

NON_PLAYABLE = {"TFT_BlueGolem", "TFT_TrainingDummy", "TFT17_Summon Bia & Bayin", "TFT17_PVE_ElderDragon"}

# Unit list for JS — exclude non-playable units (no traits)
units_sorted = sorted(
    [(v["name"], k, v["cost"]) for k, v in data["units"].items()
     if v["cost"] > 0 and v["traits"] and k not in NON_PLAYABLE],
    key=lambda x: (x[2], x[0]),
)

# Item lists for JS
def item_list(tag):
    return sorted(
        [(v["name"], k) for k, v in data["items"].items() if tag in v["tags"] and v["name"]],
        key=lambda x: x[0],
    )

craftable = item_list("Craftable")
radiant   = item_list("Radiant")
artifact  = item_list("Artifact")

def js_array(lst):
    return json.dumps([{"name": n, "key": k} for n, k in lst])

units_js    = json.dumps([{"name": n, "key": k, "cost": c} for n, k, c in units_sorted])
craftable_js = js_array(craftable)
radiant_js   = js_array(radiant)
artifact_js  = js_array(artifact)

html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TFT Set 17 — Stat Calculator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d1520; color: #d4cfc7; font-family: 'Inter', 'Segoe UI', Arial, sans-serif; font-size: 14px; padding: 20px; min-height: 100vh; }
a { color: inherit; }

/* Cards */
.card { background: #111927; border: 1px solid #1e2d3e; border-radius: 6px; padding: 14px; }

/* Section label */
.sec-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #5a5868; font-weight: 600; margin-bottom: 8px; }

/* Inputs */
input {
  background: #0b1219;
  border: 1px solid #1e2d3e;
  color: #e0ddd8;
  border-radius: 4px;
  font-family: inherit;
  font-size: 14px;
}
input::placeholder { color: #3a3848; }
input:focus { outline: none; border-color: #4a9fe0; }

/* Star buttons */
.star-btn {
  padding: 5px 14px; border: 1px solid #1e2d3e; border-radius: 4px;
  font-size: 14px; cursor: pointer; background: #0b1219; color: #5a5868;
  font-family: inherit; transition: all 0.12s;
}
.star-btn.active { background: #4a9fe0; color: #fff; border-color: #4a9fe0; font-weight: 700; }
.star-btn:hover:not(.active) { border-color: #4a9fe0; color: #4a9fe0; }

/* Breakpoint buttons */
.bp-btn {
  padding: 4px 12px; border: 1px solid #1e2d3e; border-radius: 4px;
  font-size: 13px; cursor: pointer; background: #0b1219; color: #5a5868;
  font-family: inherit; transition: all 0.12s;
}
.bp-btn.active { background: #4a9fe0; color: #fff; border-color: #4a9fe0; font-weight: 700; }
.bp-btn:hover:not(.active) { border-color: #4a9fe0; color: #4a9fe0; }

/* Trait pill */
.trait-pill {
  display: inline-block; padding: 3px 9px; border-radius: 3px;
  font-size: 12px; background: #1e1e26; color: #8a8898;
  border: 1px solid #2a2a32; font-weight: 500;
}

/* Item slots */
.item-slot {
  border: 1px dashed #1e2d3e; border-radius: 4px; padding: 9px 11px; min-height: 52px;
  background: #0b1219;
}
.item-slot.has-item { border-style: solid; border-color: #4a9fe044; background: #0e1620; }

/* Cost colors */
.cost-1 { color: #777; }
.cost-2 { color: #3eb87a; }
.cost-3 { color: #4a9fe0; }
.cost-4 { color: #b054d4; }
.cost-5 { color: #e0b830; }

/* Stat table */
.stat-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.stat-table th {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: #5a5868; font-weight: 600; text-align: right;
  padding: 0 8px 9px 8px; border-bottom: 1px solid #2a2a32;
}
.stat-table th:first-child { text-align: left; }
.stat-table td {
  padding: 7px 8px; border-bottom: 1px solid #1c1c22;
  text-align: right; font-variant-numeric: tabular-nums; color: #b8b4c0;
}
.stat-table td:first-child { text-align: left; color: #9a98a8; }
.stat-table tr:last-child td { border-bottom: none; }
.stat-table .td-bonus { color: #4a9fe0; font-weight: 600; }
.stat-table .td-trait { color: #b054d4; font-weight: 600; }
.stat-table .td-total { font-weight: 700; color: #c8c4c0; font-size: 15px; }
.stat-table .td-zero { color: #1e2d3e; }
.stat-table tr:hover td { background: #ffffff05; }

/* Searchable dropdown */
.search-wrap { position: relative; }
.search-input { width: 100%; padding: 8px 11px; }
.search-drop {
  position: absolute; top: 100%; left: 0; right: 0;
  background: #111927; border: 1px solid #1e2d3e; border-top: none;
  border-radius: 0 0 5px 5px; max-height: 260px; overflow-y: auto;
  z-index: 100; display: none; box-shadow: 0 10px 30px rgba(0,0,0,0.6);
}
.search-drop.open { display: block; }
.search-opt { padding: 7px 11px; font-size: 14px; cursor: pointer; color: #d4cfc7; }
.search-opt:hover, .search-opt.focused { background: #1a2840; color: #4a9fe0; }
.search-opt .opt-sub { font-size: 12px; color: #4a4858; margin-left: 5px; }
.search-group {
  padding: 5px 11px 3px; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; color: #4a4858; background: #0b1219;
  border-top: 1px solid #1e2d3e; pointer-events: none; font-weight: 600;
}

/* Ability section */
.ability-card {
  background: #0b1219; border: 1px solid #1e2d3e; border-radius: 5px;
  padding: 12px 14px; margin-bottom: 14px;
}

/* Role tag */
.role-tag {
  font-size: 11px; padding: 2px 8px; border-radius: 3px;
  border: 1px solid currentColor; letter-spacing: 0.04em; font-weight: 600;
}

/* Scrollbar styling */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: #0b1219; }
::-webkit-scrollbar-thumb { background: #1e2d3e; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #2a3d52; }

/* Cost filter buttons */
.cost-btn {
  padding: 4px 9px; border: 1px solid #1e2d3e; border-radius: 4px;
  font-size: 12px; cursor: pointer; background: #0b1219; color: #5a5868;
  font-family: inherit; font-weight: 600; transition: all 0.12s;
}
.cost-btn.active { background: #4a9fe0; color: #fff; border-color: #4a9fe0; }
.cost-btn:hover:not(.active) { border-color: #4a9fe0; color: #4a9fe0; }
.cost-1-btn.active { background: #777; border-color: #777; color:#fff; }
.cost-2-btn.active { background: #3eb87a; border-color: #3eb87a; color:#fff; }
.cost-3-btn.active { background: #4a9fe0; border-color: #4a9fe0; color:#fff; }
.cost-4-btn.active { background: #b054d4; border-color: #b054d4; color:#fff; }
.cost-5-btn.active { background: #e0b830; border-color: #e0b830; color:#000; }
</style>
</head>
<body>
<div style="max-width:1060px;margin:0 auto;">

  <!-- Header -->
  <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid #2e2e36;">
    <span style="font-size:11px;color:#4a9fe0;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">Set 17</span>
    <h1 style="font-size:22px;font-weight:700;color:#e8e4de;letter-spacing:0.01em;">Stat Calculator</h1>
    <span style="font-size:12px;color:#3a3848;margin-left:auto;">Pick a champion · set star level · activate traits · equip items</span>
  </div>

  <div style="display:grid;grid-template-columns:270px 1fr;gap:12px;align-items:start;">

    <!-- LEFT COLUMN -->
    <div style="display:flex;flex-direction:column;gap:10px;">

      <!-- Cost filter -->
      <div class="card" style="padding:10px 14px;">
        <div class="sec-label">Filter by Cost</div>
        <div style="display:flex;gap:5px;">
          <button class="cost-btn active" data-cost="0" onclick="setCostFilter(0)">All</button>
          <button class="cost-btn cost-1-btn" data-cost="1" onclick="setCostFilter(1)">1g</button>
          <button class="cost-btn cost-2-btn" data-cost="2" onclick="setCostFilter(2)">2g</button>
          <button class="cost-btn cost-3-btn" data-cost="3" onclick="setCostFilter(3)">3g</button>
          <button class="cost-btn cost-4-btn" data-cost="4" onclick="setCostFilter(4)">4g</button>
          <button class="cost-btn cost-5-btn" data-cost="5" onclick="setCostFilter(5)">5g</button>
        </div>
      </div>

      <!-- Champion -->
      <div class="card">
        <div class="sec-label">Champion</div>
        <div class="search-wrap" id="unitWrap">
          <input class="search-input" id="unitInput" type="text" placeholder="Search champion..." autocomplete="off"
            oninput="filterDrop('unit')" onfocus="openDrop('unit')" onblur="delayClose('unit')" onkeydown="navDrop(event,'unit')">
          <div class="search-drop" id="unitDrop"></div>
        </div>

        <div id="starSection" style="display:none;margin-top:10px;">
          <div class="sec-label">Star Level</div>
          <div style="display:flex;gap:6px;">
            <button class="star-btn active" data-star="1" onclick="setStar(1)">★</button>
            <button class="star-btn" data-star="2" onclick="setStar(2)">★★</button>
            <button class="star-btn" data-star="3" onclick="setStar(3)">★★★</button>
          </div>
        </div>
      </div>

      <!-- Trait Breakpoints -->
      <div class="card" id="traitCard" style="display:none;">
        <div class="sec-label">Trait Breakpoints</div>
        <div id="traitList" style="display:flex;flex-direction:column;gap:9px;"></div>
      </div>

      <!-- Items -->
      <div class="card">
        <div class="sec-label">Items (up to 3)</div>
        <div id="itemSlots" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;"></div>
        <div class="search-wrap" id="itemWrap">
          <input class="search-input" id="itemInput" type="text" placeholder="Search item..." autocomplete="off"
            oninput="filterDrop('item')" onfocus="openDrop('item')" onblur="delayClose('item')" onkeydown="navDrop(event,'item')">
          <div class="search-drop" id="itemDrop"></div>
        </div>
      </div>

    </div>

    <!-- RIGHT COLUMN: Stat Panel -->
    <div class="card" style="position:sticky;top:20px;">
      <div id="noChampMsg" style="text-align:center;padding:40px 0;font-size:14px;color:#3a3848;">
        Select a champion to see stats
      </div>
      <div id="statPanel" style="display:none;">

        <!-- Champ header -->
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:5px;">
          <span id="champName" style="font-size:20px;font-weight:700;color:#e8e4de;letter-spacing:0.01em;"></span>
          <span id="champStar" style="font-size:15px;color:#4a9fe0;letter-spacing:2px;"></span>
          <span id="champRole" class="role-tag"></span>
        </div>
        <div id="champTraits" style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:4px;"></div>

        <!-- Ability -->
        <div class="ability-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span id="abilityName" style="font-size:15px;font-weight:700;color:#4a9fe0;"></span>
            <span id="abilityMana" style="font-size:12px;color:#5b8dd9;"></span>
          </div>
          <div id="abilityDesc" style="font-size:13px;color:#c8c4c0;line-height:1.7;margin-bottom:6px;white-space:pre-line;"></div>
          <div id="abilityDetails"></div>
        </div>

        <!-- Stat table -->
        <table class="stat-table">
          <thead>
            <tr>
              <th style="text-align:left;">Stat</th>
              <th>Base</th>
              <th>Item</th>
              <th>Trait</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody id="statRows"></tbody>
        </table>

        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #2e2e36;">
          <div class="sec-label">Derived</div>
          <table class="stat-table">
            <tbody id="derivedRows"></tbody>
          </table>
        </div>

      </div>
    </div>

  </div>
</div>

<script>
const DATA = """ + data_json + """;
const UNITS_LIST  = """ + units_js + """;
const ITEMS_CRAFTABLE = """ + craftable_js + """;
const ITEMS_RADIANT   = """ + radiant_js + """;
const ITEMS_ARTIFACT  = """ + artifact_js + """;
const ALL_ITEMS = [
  ...ITEMS_CRAFTABLE.map(x => ({...x, group:'Craftable'})),
  ...ITEMS_RADIANT.map(x => ({...x, group:'Radiant'})),
  ...ITEMS_ARTIFACT.map(x => ({...x, group:'Artifact'})),
];

let state = { unitKey: null, star: 1, traitBPs: {}, items: [], costFilter: 0 };

// ── Searchable dropdown ───────────────────────────────────────────────
const dropState = {
  unit: { open: false, focused: -1, filtered: [] },
  item: { open: false, focused: -1, filtered: [] },
};

function buildDropItems(type) {
  if (type === 'unit') {
    let list = UNITS_LIST;
    if (state.costFilter > 0) list = list.filter(u => u.cost === state.costFilter);
    return list.map(u => ({ key: u.key, label: u.name, sub: u.cost, group: null }));
  }
  return ALL_ITEMS.map(x => ({ key: x.key, label: x.name, sub: null, group: x.group }));
}

function setCostFilter(cost) {
  state.costFilter = cost;
  document.querySelectorAll('.cost-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.cost === cost));
  filterDrop('unit');
}

function filterDrop(type) {
  const input = document.getElementById(type + 'Input');
  const q = input.value.toLowerCase();
  const all = buildDropItems(type);
  dropState[type].filtered = q ? all.filter(x => x.label.toLowerCase().includes(q)) : all;
  dropState[type].focused = -1;
  renderDrop(type);
  openDrop(type);
}

function renderDrop(type) {
  const drop = document.getElementById(type + 'Drop');
  const items = dropState[type].filtered;
  if (!items.length) { drop.innerHTML = '<div class="search-opt" style="color:#aaa;">No results</div>'; return; }

  let html = '';
  let lastGroup = '__none__';
  items.forEach((item, i) => {
    if (type === 'item' && item.group !== lastGroup) {
      html += `<div class="search-group">${item.group}</div>`;
      lastGroup = item.group;
    }
    const focused = i === dropState[type].focused ? ' focused' : '';
    const subHtml = item.sub != null
      ? `<span class="opt-sub">${type === 'unit' ? item.sub + icon('goldCoins') : item.sub}</span>`
      : '';
    html += `<div class="search-opt${focused}" data-key="${item.key}" data-idx="${i}"
      onmousedown="selectOpt('${type}', '${item.key}', event)">
      ${item.label}${subHtml}
    </div>`;
  });
  drop.innerHTML = html;
}

function openDrop(type) {
  if (!dropState[type].filtered.length) filterDrop(type);
  dropState[type].open = true;
  document.getElementById(type + 'Drop').classList.add('open');
}

function delayClose(type) {
  setTimeout(() => {
    dropState[type].open = false;
    document.getElementById(type + 'Drop').classList.remove('open');
    dropState[type].focused = -1;
  }, 150);
}

function navDrop(e, type) {
  const ds = dropState[type];
  if (!ds.open) { openDrop(type); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    ds.focused = Math.min(ds.focused + 1, ds.filtered.length - 1);
    renderDrop(type);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    ds.focused = Math.max(ds.focused - 1, 0);
    renderDrop(type);
  } else if (e.key === 'Enter' && ds.focused >= 0) {
    e.preventDefault();
    selectOpt(type, ds.filtered[ds.focused].key);
  } else if (e.key === 'Escape') {
    delayClose(type);
  }
}

function selectOpt(type, key, e) {
  if (e) e.preventDefault();
  delayClose(type);
  if (type === 'unit') {
    const unit = DATA.units[key];
    document.getElementById('unitInput').value = unit ? unit.name : '';
    state.unitKey = key;
    state.star = 1;
    state.traitBPs = {};
    renderAll();
  } else {
    if (state.items.length >= 3 || state.items.includes(key)) return;
    state.items.push(key);
    document.getElementById('itemInput').value = '';
    dropState.item.filtered = [];
    renderItems();
    renderStats();
  }
}

// ── State helpers ─────────────────────────────────────────────────────
function traitKey(name) {
  return Object.keys(DATA.traits).find(k => DATA.traits[k].name === name) || null;
}

function renderAbilityDetails(ab, star) {
  const el = document.getElementById('abilityDetails');
  if (!el) return;
  const rows = (ab.details || []).filter(d => d && d.values);
  if (!rows.length) { el.innerHTML = ''; return; }
  let html = '<table style="width:100%;border-collapse:collapse;margin-top:4px;">';
  rows.forEach(row => {
    const labelHtml = cleanScaleTokens(row.label || '');
    const vals = row.values;
    const inner = vals.map((v, i) =>
      i === star - 1
        ? `<strong style="color:#4a9fe0;font-weight:700;">${v}</strong>`
        : `<span style="opacity:0.35">${v}</span>`
    ).join(' / ');
    html += `<tr>
      <td style="font-size:12px;color:#8a9bb0;padding:2px 0;padding-right:12px;white-space:nowrap;">${labelHtml}</td>
      <td style="font-size:12px;color:#c8c4c0;text-align:right;white-space:nowrap;">[${inner}]</td>
    </tr>`;
  });
  html += '</table>';
  el.innerHTML = html;
}

function setStar(n) {
  state.star = n;
  document.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', +b.dataset.star === n));
  document.getElementById('champStar').textContent = '★'.repeat(n);
  if (state.unitKey) {
    const ab = DATA.units[state.unitKey].ability || {};
    document.getElementById('abilityDesc').innerHTML = cleanScaleTokens(pickStarValues(ab.desc || '', n));
    renderAbilityDetails(ab, n);
  }
  renderStats();
}


function toggleBP(tKey, minUnits) {
  state.traitBPs[tKey] = (state.traitBPs[tKey] === minUnits) ? 0 : minUnits;
  DATA.traits[tKey].breakpoints.forEach(bp => {
    const btn = document.getElementById('bp_' + tKey + '_' + bp.minUnits);
    if (btn) btn.classList.toggle('active', state.traitBPs[tKey] === bp.minUnits);
  });
  renderStats();
}

function removeItem(i) {
  state.items.splice(i, 1);
  renderItems();
  renderStats();
}

function itemBonuses() {
  // Non-adaptive items only — adaptive items handled separately in renderStats
  const b = {};
  state.items.forEach(k => {
    const item = DATA.items[k];
    if (!item || item.isAdaptive) return;
    Object.entries(item.statBonuses || {}).forEach(([s, v]) => { b[s] = (b[s] || 0) + v; });
  });
  return b;
}

// Returns {ad, ap} bonus from adaptive items, picking winner per item based on current base
function adaptiveItemBonuses(baseAD) {
  let ad = 0, ap = 0, adPct = 0;
  const winners = {};
  state.items.forEach(k => {
    const item = DATA.items[k];
    if (!item || !item.isAdaptive) return;
    const adGain = Math.round(baseAD * (item.statBonuses.ad || 0));
    const apGain = item.statBonuses.ap || 0;
    if (adGain >= apGain) { adPct += (item.statBonuses.ad || 0); winners[k] = 'ad'; }
    else                  { ap += apGain;                        winners[k] = 'ap'; }
  });
  return { adPct, ap, winners };
}

function traitBonuses() {
  const b = {};
  if (!state.unitKey) return b;
  DATA.units[state.unitKey].traits.forEach(name => {
    const tk = traitKey(name);
    if (!tk) return;
    const sel = state.traitBPs[tk] || 0;
    if (!sel) return;
    const bp = DATA.traits[tk].breakpoints.find(x => x.minUnits === sel);
    if (bp) Object.entries(bp.bonuses || {}).forEach(([s, v]) => { b[s] = (b[s] || 0) + v; });
  });
  return b;
}

// ── Render ────────────────────────────────────────────────────────────
function renderAll() {
  const unit = state.unitKey ? DATA.units[state.unitKey] : null;
  document.getElementById('starSection').style.display = unit ? 'block' : 'none';
  document.getElementById('traitCard').style.display = unit ? 'block' : 'none';
  document.getElementById('statPanel').style.display = unit ? 'block' : 'none';
  document.getElementById('noChampMsg').style.display = unit ? 'none' : 'block';

  document.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', +b.dataset.star === state.star));

  if (unit) {
    document.getElementById('champName').textContent = unit.name;
    document.getElementById('champStar').textContent = '★'.repeat(state.star);
    document.getElementById('champTraits').innerHTML = unit.traits.map(t => `<span class="trait-pill">${t}</span>`).join(' ');
    // Role tag
    const rt = unit.roleTag || {};
    const roleEl = document.getElementById('champRole');
    roleEl.textContent = rt.label || '';
    roleEl.style.color = rt.color || '#666';
    roleEl.style.borderColor = rt.color || '#666';
    // Ability
    const ab = unit.ability || {};
    document.getElementById('abilityName').textContent = ab.name || '';
    document.getElementById('abilityMana').innerHTML = ab.mana ? icon('scaleMana') + ' ' + ab.mana : '';
    document.getElementById('abilityDesc').innerHTML = cleanScaleTokens(pickStarValues(ab.desc || '', state.star));
    renderAbilityDetails(ab, state.star);
    const traitList = document.getElementById('traitList');
    traitList.innerHTML = '';
    unit.traits.forEach(name => {
      const tk = traitKey(name);
      const trait = tk ? DATA.traits[tk] : null;
      const row = document.createElement('div');
      if (!trait || !trait.breakpoints.length) {
        row.innerHTML = `<span style="font-size:13px;color:#3a3848;">${name} <em>(no stat bonuses)</em></span>`;
      } else {
        const bpBtns = trait.breakpoints.map(bp => {
          const tip = Object.entries(bp.bonuses || {}).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ') || 'No direct stat bonus';
          return `<button id="bp_${tk}_${bp.minUnits}" class="bp-btn" title="${tip}" onclick="toggleBP('${tk}', ${bp.minUnits})">${bp.minUnits}</button>`;
        }).join('');
        row.innerHTML = `<div style="font-size:13px;font-weight:600;color:#a0a0b0;margin-bottom:5px;">${name}</div><div style="display:flex;gap:5px;">${bpBtns}</div>`;
      }
      traitList.appendChild(row);
    });
  }

  renderItems();
  renderStats();
}

function renderItems() {
  const slots = document.getElementById('itemSlots');
  slots.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const key = state.items[i];
    const item = key ? DATA.items[key] : null;
    const div = document.createElement('div');
    div.className = 'item-slot' + (item ? ' has-item' : '');
    if (item) {
      const stats = Object.entries(item.statBonuses || {}).filter(([,v]) => v !== 0)
        .map(([k, v]) => {
          if (k === 'ad' && v < 2) return `+${(v*100).toFixed(0)}% AD`;
          if (k === 'as') return `+${v}% AS`;
          const short = {hp:'HP',ad:'AD',ap:'AP',armor:'Armor',mr:'MR',manaRegen:'Mana/s',critChance:'Crit',omnivamp:'Vamp',lifeSteal:'LS'};
          return `+${Number.isInteger(v)?v:v.toFixed(1)} ${short[k]||k}`;
        }).join(' · ');
      div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:start;">
        <span style="font-size:14px;font-weight:600;color:#4a9fe0;">${item.name}</span>
        <button onclick="removeItem(${i})" style="font-size:0.7rem;color:#bbb;background:none;border:none;cursor:pointer;padding:0;line-height:1;">✕</button>
      </div>
      <div style="font-size:12px;color:#6b6870;margin-top:3px;">${stats || 'Special effects only'}</div>`;
    } else {
      div.innerHTML = `<div style="font-size:13px;color:#2a2a38;text-align:center;padding:8px 0;">Empty slot ${i+1}</div>`;
    }
    slots.appendChild(div);
  }
}

// Stat icons from ap.tft.tools (same source tactics.tools uses)
const TFT_ICONS = {
  scaleAD:     'https://ap.tft.tools/img/general/ad.png',
  scaleAP:     'https://ap.tft.tools/img/general/ap.png',
  scaleArmor:  'https://ap.tft.tools/img/general/armor.png',
  scaleMR:     'https://ap.tft.tools/img/general/mr.png',
  scaleHealth: 'https://ap.tft.tools/img/general/hp.png',
  scaleAS:     'https://ap.tft.tools/img/general/as.png',
  scaleMana:   'https://ap.tft.tools/img/general/mana.png',
  goldCoins:   'https://cdn.tft.tools/general/gold.png',
};

function icon(name) {
  const url = TFT_ICONS[name];
  if (!url) return '';
  return `<img src="${url}?w=14" width="14" height="14" style="display:inline;vertical-align:-3px;margin:0 2px" alt="${name}">`;
}

// Replace %i:scaleXX% tokens with inline SVG icons
function pickStarValues(s, star) {
  // Show [1★val / 2★val / 3★val] with current star highlighted in blue
  return (s || '').replace(/([0-9]+(?:[.][0-9]+)?)[/]([0-9]+(?:[.][0-9]+)?)[/]([0-9]+(?:[.][0-9]+)?)/g, (_, a, b, c) => {
    const vals = [a, b, c];
    const inner = vals.map((v, i) =>
      i === star - 1
        ? `<strong style="color:#4a9fe0;font-weight:700;">${v}</strong>`
        : `<span style="opacity:0.35">${v}</span>`
    ).join(' / ');
    return '[' + inner + ']';
  });
}

function cleanScaleTokens(s) {
  return (s || '')
    .replace(/%i:scaleAD%/g,     icon('scaleAD'))
    .replace(/%i:scaleArmor%/g,  icon('scaleArmor'))
    .replace(/%i:scaleMR%/g,     icon('scaleMR'))
    .replace(/%i:scaleAP%/g,     icon('scaleAP'))
    .replace(/%i:scaleHealth%/g, icon('scaleHealth'))
    .replace(/%i:scaleMana%/g,   icon('scaleMana'))
    .replace(/%i:scaleAS%/g,     icon('scaleAS'))
    .replace(/%i:goldCoins%/g,   icon('goldCoins'))
    .replace(/%i:[^%]+%/g,       '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const STAT_LABELS = {
  hp:            () => icon('scaleHealth') + '<span style="color:#c8c4c0"> Health</span>',
  ad:            () => icon('scaleAD')     + '<span style="color:#c8c4c0"> Attack Damage</span>',
  ap:            () => icon('scaleAP')     + '<span style="color:#c8c4c0"> Ability Power</span>',
  armor:         () => icon('scaleArmor')  + '<span style="color:#c8c4c0"> Armor</span>',
  mr:            () => icon('scaleMR')     + '<span style="color:#c8c4c0"> Magic Resist</span>',
  as:            () => icon('scaleAS')     + '<span style="color:#c8c4c0"> Attack Speed</span>',
  mana:          () => icon('scaleMana')   + '<span style="color:#c8c4c0"> Mana</span>',
  initialMana:   () => icon('scaleMana')   + '<span style="color:#c8c4c0"> Starting Mana</span>',
  range:         () => '<span style="color:#c8c4c0">&#x25CE; Range</span>',
  critChance:    () => '<span style="color:#c8c4c0">&#x2694; Crit Chance</span>',
  critMultiplier:() => '<span style="color:#c8c4c0">&#x2694; Crit Multiplier</span>',
  manaRegen:     () => icon('scaleMana')   + '<span style="color:#c8c4c0"> Mana Regen/s</span>',
  omnivamp:      () => icon('scaleHealth') + '<span style="color:#c8c4c0"> Omnivamp</span>',
  lifeSteal:     () => icon('scaleHealth') + '<span style="color:#c8c4c0"> Life Steal</span>',
  dmgReduction:  () => icon('scaleArmor')  + '<span style="color:#c8c4c0"> Dmg Reduction</span>',
};
function statLabel(s) { return (STAT_LABELS[s] ? STAT_LABELS[s]() : s); }

function commaFmt(n) {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

function fmt(s, v) {
  if (v === undefined) return '—';
  if (v === 0) {
    // Show 0 for stats that are intentionally zero (e.g. Riven base AD/AP)
    if (s === 'ad') return '0';
    if (s === 'ap') return '0';
    return '—';
  }
  if (s === 'hp') return Math.round(v).toLocaleString();
  if (s === 'as') return v.toFixed(3);
  if (s === 'critChance') return v.toFixed(0) + '%';
  if (s === 'critMultiplier') return v.toFixed(2) + 'x';
  if (s === 'manaRegen' || s === 'omnivamp' || s === 'lifeSteal' || s === 'dmgReduction') return v.toFixed(0) + '%';
  if (s === 'ad' && v > 0 && v < 2) return (v*100).toFixed(0) + '%';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtBonus(s, v) {
  if (!v) return '<td class="td-zero">—</td>';
  const str = (v > 0 ? '+' : '') + fmt(s, v);
  return `<td class="td-bonus">${str}</td>`;
}

function renderStats() {
  if (!state.unitKey) return;
  const unit = DATA.units[state.unitKey];
  const mult = [1, 1.8, 3.24][state.star - 1];
  const ib = itemBonuses();
  const tb = traitBonuses();

  const baseRawAD = Math.round(unit.stats.ad * mult);

  // For adaptive units (base AD = 0), use ability detail value as displayed base
  let abilityBase = null;
  if (baseRawAD === 0 && unit.ability && unit.ability.details && unit.ability.details.length > 0) {
    const firstDetail = unit.ability.details[0];
    if (firstDetail && firstDetail.values) {
      abilityBase = parseFloat(firstDetail.values[state.star - 1]) || null;
    }
  }

  const base = {
    hp: Math.round(unit.stats.hp * mult),
    ad: abilityBase !== null ? abilityBase : baseRawAD,
    ap: 0,
    armor: unit.stats.armor,
    mr: unit.stats.mr,
    as: unit.stats.as,
    mana: unit.stats.mana,
    initialMana: unit.stats.initialMana,
    range: unit.stats.range,
    critChance: unit.stats.critChance * 100,
    critMultiplier: unit.stats.critMultiplier,
  };

  // Non-adaptive item bonuses
  const adPct  = ib.ad && ib.ad < 2 ? ib.ad : 0;
  const adFlat = ib.ad && ib.ad >= 2 ? ib.ad : 0;

  // Adaptive item bonuses — compare winner based on effective base AD
  const adapt = adaptiveItemBonuses(base.ad);
  const totalAdPct = adPct + adapt.adPct;

  const iCol = {
    hp: ib.hp || 0,
    ad: adFlat + (totalAdPct ? Math.round(base.ad * totalAdPct) : 0),
    ap: (ib.ap || 0) + adapt.ap,
    armor: (ib.armor || 0) + (ib.armorMR || 0),
    mr: (ib.mr || 0) + (ib.armorMR || 0),
    as: (ib.as || 0) / 100,
    critChance: ib.critChance || 0,
    critMultiplier: 0, mana: 0, initialMana: 0, range: 0,
  };
  // Include non-adaptive stats from adaptive items (e.g. Bloodthirster MR, lifeSteal)
  state.items.forEach(k => {
    const item = DATA.items[k];
    if (!item || !item.isAdaptive) return;
    Object.entries(item.statBonuses || {}).forEach(([s, v]) => {
      if (s !== 'ad' && s !== 'ap') iCol[s] = (iCol[s] || 0) + (s === 'as' ? v / 100 : v);
    });
  });

  const tCol = {
    hp: tb.hp || 0, ad: tb.ad || 0, ap: tb.ap || 0,
    armor: tb.armor || 0, mr: tb.mr || 0,
    as: tb.as || 0, critChance: tb.critChance || 0,
    critMultiplier: 0, mana: 0, initialMana: 0, range: 0,
  };

  const total = {
    hp: base.hp + iCol.hp + tCol.hp,
    ad: Math.round(base.ad * (1 + totalAdPct) + adFlat + (tb.ad || 0)),
    ap: iCol.ap + tCol.ap,
    armor: Math.round(base.armor + iCol.armor + tCol.armor),
    mr: Math.round(base.mr + iCol.mr + tCol.mr),
    as: parseFloat((base.as + iCol.as + tCol.as).toFixed(3)),
    mana: base.mana, initialMana: base.initialMana, range: base.range,
    critChance: Math.min(100, base.critChance + iCol.critChance),
    critMultiplier: base.critMultiplier,
  };

  const STAT_COLOR = {
    hp:'#56c774', ad:'#e8873a', ap:'#3d9ae8', armor:'#c8a850',
    mr:'#4fc4cf', as:'#d4b84a', critChance:'#c8c4c0', critMultiplier:'#c8c4c0',
    mana:'#5b8dd9', range:'#c8c4c0'
  };

  const baseNote = (s) => {
    if (abilityBase !== null && (s === 'ad' || s === 'ap'))
      return `<span title="Adaptive — scales with ability" style="font-size:10px;color:#4a9fe0;margin-left:3px;">~</span>`;
    return '';
  };

  const STATS = ['hp','ad','ap','armor','mr','as','critChance','critMultiplier','range'];
  const rows = STATS.map(s => {
    const hasChange = iCol[s] || tCol[s];
    const totalColor = STAT_COLOR[s] || '#c8c4c0';
    const totalStyle = hasChange ? `style="color:${totalColor}"` : '';
    const totalClass = hasChange ? 'td-total' : '';
    return `<tr>
      <td>${statLabel(s)}</td>
      <td>${fmt(s, base[s])}${baseNote(s)}</td>
      ${fmtBonus(s, iCol[s])}
      ${fmtBonus(s, tCol[s])}
      <td class="${totalClass}" ${totalStyle}>${fmt(s, total[s])}</td>
    </tr>`;
  });

  // Combined mana row
  const manaDisplay = base.initialMana + '/' + base.mana;
  rows.push(`<tr>
    <td>${statLabel('mana')}</td>
    <td>${manaDisplay}</td>
    <td class="td-zero">—</td><td class="td-zero">—</td>
    <td style="color:#5b8dd9;">${manaDisplay}</td>
  </tr>`);

  document.getElementById('statRows').innerHTML = rows.join('');

  // Extra item-only stats (manaRegen etc)
  const allIb = { ...ib };
  state.items.forEach(k => {
    const item = DATA.items[k];
    if (!item || !item.isAdaptive) return;
    Object.entries(item.statBonuses || {}).forEach(([s, v]) => {
      if (s !== 'ad' && s !== 'ap') allIb[s] = (allIb[s] || 0) + v;
    });
  });
  const extras = ['manaRegen','omnivamp','lifeSteal','dmgReduction']
    .filter(k => allIb[k])
    .map(k => `<tr><td>${statLabel(k)}</td><td>—</td><td class="td-bonus">+${fmt(k, allIb[k])}</td><td>—</td><td class="td-total">${fmt(k, allIb[k])}</td></tr>`)
    .join('');

  const dps = (total.ad * total.as).toFixed(1);
  const eHP_p = Math.round(total.hp * (1 + total.armor / 100));
  const eHP_m = Math.round(total.hp * (1 + total.mr / 100));
  document.getElementById('derivedRows').innerHTML = extras + `
    <tr><td>DPS (AD × AS)</td><td style="color:#3a3848;font-size:12px;">${total.ad}</td><td style="color:#3a3848;font-size:12px;">× ${total.as}</td><td></td><td class="td-total">${dps}</td></tr>
    <tr><td>Eff. HP (Physical)</td><td></td><td></td><td></td><td class="td-total">${eHP_p.toLocaleString()}</td></tr>
    <tr><td>Eff. HP (Magic)</td><td></td><td></td><td></td><td class="td-total">${eHP_m.toLocaleString()}</td></tr>`;
}

// Pre-build and pre-render dropdown HTML — don't open them yet
dropState.unit.filtered = buildDropItems('unit');
dropState.item.filtered = buildDropItems('item');
renderDrop('unit');
renderDrop('item');
renderItems();
</script>
</body>
</html>"""

# Inject data into the existing public/calculator.html rather than overwriting
# the whole file. This preserves all hand-edits to the UI.
if OUT_PATH.exists():
    existing = OUT_PATH.read_text(encoding="utf-8")
    pre  = existing.split('const DATA = ')[0]
    post = existing.split('const UNITS_LIST')[1]
    new_html = pre + 'const DATA = ' + data_json + ';\nconst UNITS_LIST' + post
    OUT_PATH.write_text(new_html, encoding="utf-8")
    print(f"Injected data into existing: {OUT_PATH}  ({OUT_PATH.stat().st_size // 1024}KB)")
else:
    OUT_PATH.write_text(html, encoding="utf-8")
    print(f"Written (new file): {OUT_PATH}  ({OUT_PATH.stat().st_size // 1024}KB)")
