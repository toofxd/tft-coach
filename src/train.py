"""
Train all TFT coaching models:
  Model A — MLP: predict placement from end-of-game features
  Model B — LSTM: predict placement from per-round sequence (live capture data)
  Model C — K-Means: cluster comps into archetypes
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.cluster import KMeans
from sklearn.metrics import accuracy_score, mean_absolute_error
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
import pickle

PROCESSED_DIR = Path(__file__).parent.parent / "data" / "processed"
MODELS_DIR = Path(__file__).parent.parent / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {DEVICE}")


# ---------------------------------------------------------------------------
# Shared preprocessing
# ---------------------------------------------------------------------------

# Only end-of-game state the player controls. Deliberately excluded:
#   last_round, level_efficiency — when you were eliminated *is* your placement, so the
#     model leans on them and counterfactuals on everything else go to ~0 (measured:
#     fixing gold or stars moved predicted placement by 0.01–0.02 places).
#   damage_to_players, players_eliminated — always 0 in Set 18 match data.
NUMERIC_COLS = [
    "level", "gold_left", "active_trait_count", "unit_star_avg",
    "unit_count", "item_concentration",
]
CATEGORICAL_COLS = ["top_trait"]

# Features the coach nudges to the Challenger/GM top-4 median, and which direction is "better"
COUNTERFACTUAL_FEATURES = {"gold_left": "lower", "level": "higher", "unit_star_avg": "higher"}


def load_and_prep(path: Path) -> tuple[np.ndarray, np.ndarray, dict, pd.DataFrame]:
    """
    Load match_features.csv, one-hot the top trait, scale numerics.
    Returns (X, y, encoders, df) where y is placement 0–7.
    """
    df = pd.read_csv(path).dropna(subset=["placement"])
    df["top_trait"] = df["top_trait"].fillna("unknown").astype(str)

    # One-hot, not label-encoded: trait IDs have no order, and a single integer column
    # made the model treat e.g. Rival as "between" two unrelated traits.
    traits = sorted(df["top_trait"].unique())
    trait_oh = (df["top_trait"].to_numpy(dtype=object)[:, None] == np.array(traits, dtype=object)[None, :]).astype(np.float32)

    scaler = StandardScaler()
    num_arr = scaler.fit_transform(df[NUMERIC_COLS].fillna(0))

    encoders = {
        "scaler": scaler,
        "numeric_cols": NUMERIC_COLS,
        "categorical_cols": CATEGORICAL_COLS,
        "traits": traits,
    }
    X = np.hstack([num_arr, trait_oh]).astype(np.float32)
    y = df["placement"].values.astype(np.int64) - 1  # 0-indexed for CrossEntropy
    return X, y, encoders, df


# ---------------------------------------------------------------------------
# Model A: MLP placement predictor
# ---------------------------------------------------------------------------

class PlacementMLP(nn.Module):
    def __init__(self, input_dim: int, n_classes: int = 8):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(64, n_classes),
        )

    def forward(self, x):
        return self.net(x)


def expected_placement(logits: torch.Tensor) -> torch.Tensor:
    """Probability-weighted placement (1–8) — smoother than argmax, so small nudges register."""
    ranks = torch.arange(1, 9, dtype=torch.float32, device=logits.device)
    return (torch.softmax(logits, dim=1) * ranks).sum(dim=1)


def train_mlp(df_path: Path, epochs: int = 20, lr: float = 1e-3, batch_size: int = 512) -> None:
    print("\n=== Model A: MLP Placement Predictor ===")
    torch.manual_seed(42)
    X, y, encoders, df = load_and_prep(df_path)

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    X_tr = torch.tensor(X_train).to(DEVICE)
    y_tr = torch.tensor(y_train).to(DEVICE)
    X_vl = torch.tensor(X_val).to(DEVICE)
    y_vl = torch.tensor(y_val).to(DEVICE)

    model = PlacementMLP(input_dim=X.shape[1]).to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    best_val_loss, best_mae = float("inf"), None
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(len(X_tr), device=DEVICE)
        for i in range(0, len(X_tr), batch_size):
            idx = perm[i:i + batch_size]
            optimizer.zero_grad()
            criterion(model(X_tr[idx]), y_tr[idx]).backward()
            optimizer.step()

        model.eval()
        with torch.no_grad():
            logits = model(X_vl)
            val_loss = criterion(logits, y_vl).item()
            acc = accuracy_score(y_val, logits.argmax(dim=1).cpu().numpy())
            mae = (expected_placement(logits) - (y_vl + 1)).abs().mean().item()
        print(f"  Epoch {epoch+1:3d} | val_loss={val_loss:.4f} | acc={acc:.3f} | MAE(expected)={mae:.2f}")
        if val_loss < best_val_loss:
            best_val_loss, best_mae = val_loss, mae
            torch.save(model.state_dict(), MODELS_DIR / "mlp_best.pt")

    # Save encoders alongside the model
    with open(MODELS_DIR / "mlp_encoders.pkl", "wb") as f:
        pickle.dump({**encoders, "input_dim": X.shape[1]}, f)
    print(f"  Best val_loss={best_val_loss:.4f} | MAE={best_mae:.2f} | Model saved.")

    export_mlp_json(df, val_mae=best_mae)


def export_mlp_json(df: pd.DataFrame, val_mae: float | None = None) -> None:
    """
    Write models/mlp_weights.json so server.js can run the MLP without Python.
    Includes the scaler, trait vocabulary, and the Challenger/GM top-4 medians the coach
    nudges each counterfactual feature toward.
    """
    with open(MODELS_DIR / "mlp_encoders.pkl", "rb") as f:
        enc = pickle.load(f)
    state = torch.load(MODELS_DIR / "mlp_best.pt", map_location="cpu")
    linear_keys = sorted({k.rsplit(".", 1)[0] for k in state}, key=lambda k: int(k.split(".")[1]))
    r = lambda a: np.round(a.astype(np.float64), 6).tolist()

    top4 = df[df["placement"] <= 4]
    targets = {
        f: {"value": float(top4[f].median()), "better": better}
        for f, better in COUNTERFACTUAL_FEATURES.items()
    }
    out = {
        "trained_on": int(len(df)),
        "val_mae": None if val_mae is None else round(val_mae, 3),
        "numeric_cols": enc["numeric_cols"],
        "scaler_mean": r(enc["scaler"].mean_),
        "scaler_scale": r(enc["scaler"].scale_),
        "traits": enc["traits"],
        "layers": [{"W": r(state[f"{k}.weight"].numpy()), "b": r(state[f"{k}.bias"].numpy())} for k in linear_keys],
        "counterfactual_targets": targets,
    }
    path = MODELS_DIR / "mlp_weights.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"  Exported {path.name} ({path.stat().st_size // 1024} KB) | targets: "
          + ", ".join(f"{f}={t['value']:.3f}" for f, t in targets.items()))


# ---------------------------------------------------------------------------
# Model B: LSTM economy sequence predictor
# ---------------------------------------------------------------------------

class EconomyLSTM(nn.Module):
    def __init__(self, input_dim: int = 5, hidden: int = 64, layers: int = 2, n_classes: int = 8):
        super().__init__()
        self.lstm = nn.LSTM(input_dim, hidden, layers, batch_first=True, dropout=0.2)
        self.attn = nn.Linear(hidden, 1)
        self.fc = nn.Linear(hidden, n_classes)

    def forward(self, x):
        # x: (batch, seq_len, input_dim)
        out, _ = self.lstm(x)  # (batch, seq_len, hidden)
        # Attention over time steps
        weights = torch.softmax(self.attn(out), dim=1)  # (batch, seq_len, 1)
        context = (weights * out).sum(dim=1)             # (batch, hidden)
        return self.fc(context), weights.squeeze(-1)


def load_live_sequences(live_dir: Path, target_len: int = 20) -> tuple[np.ndarray, np.ndarray]:
    """
    Load all live session JSONs. Each session must have a 'placement' field
    (add it manually after the game or infer from match history).

    Returns X (n_sessions, target_len, 5) and y (n_sessions,).
    """
    sessions = list(live_dir.glob("session_*.json"))
    X_list, y_list = [], []

    for path in sessions:
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            snaps = data.get("snapshots", [])
            placement = data.get("placement", None)
        else:
            snaps = data
            placement = None  # unknown — skip

        if placement is None:
            continue

        feats = []
        prev_gold = 0
        for snap in snaps:
            gold = snap.get("gold", 0)
            roll_delta = max(0, prev_gold - gold)
            prev_gold = gold
            feats.append([
                gold,
                snap.get("level", 1),
                snap.get("units_on_board", 0),
                roll_delta,
                snap.get("xp", 0),
            ])

        if not feats:
            continue

        # Pad or truncate to target_len
        if len(feats) < target_len:
            pad = [[0.0] * 5] * (target_len - len(feats))
            feats = feats + pad
        else:
            feats = feats[:target_len]

        X_list.append(feats)
        y_list.append(int(placement) - 1)

    if not X_list:
        return np.empty((0, target_len, 5)), np.empty(0)
    return np.array(X_list, dtype=np.float32), np.array(y_list, dtype=np.int64)


def train_lstm(live_dir: Path, epochs: int = 80, lr: float = 1e-3) -> None:
    print("\n=== Model B: LSTM Economy Sequence ===")
    X, y = load_live_sequences(live_dir)

    if len(X) < 10:
        print(f"  Only {len(X)} labeled sessions -- need >=10 to train LSTM. Skipping.")
        print("  Tip: add a 'placement' field to each session JSON after your game.")
        return

    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)

    X_tr = torch.tensor(X_train).to(DEVICE)
    y_tr = torch.tensor(y_train).to(DEVICE)
    X_vl = torch.tensor(X_val).to(DEVICE)
    y_vl = torch.tensor(y_val).to(DEVICE)

    model = EconomyLSTM().to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    best_val_loss = float("inf")
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        logits, _ = model(X_tr)
        loss = criterion(logits, y_tr)
        loss.backward()
        optimizer.step()

        if (epoch + 1) % 20 == 0:
            model.eval()
            with torch.no_grad():
                val_logits, _ = model(X_vl)
                val_loss = criterion(val_logits, y_vl).item()
                preds = val_logits.argmax(dim=1).cpu().numpy()
                mae = mean_absolute_error(y_val, preds)
            print(f"  Epoch {epoch+1:3d} | val_loss={val_loss:.4f} | MAE={mae:.2f}")
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                torch.save(model.state_dict(), MODELS_DIR / "lstm_best.pt")

    print(f"  Best val_loss={best_val_loss:.4f} | Model saved.")


# ---------------------------------------------------------------------------
# Model C: K-Means comp clustering
# ---------------------------------------------------------------------------

CALC_DATA = Path(__file__).parent.parent / "data" / "static" / "calculator_data.json"

# Board shape only. Final level is deliberately left out: it tracks how long you survived,
# so with it the clusters split winners from losers (avg place 3.4 vs 5.6) instead of
# reroll from fast-9. With cost + stars only, every archetype averages ~4.3–4.6.
ARCHETYPE_FEATURES = ["avg_unit_cost", "unit_star_avg"]
# Clusters are named by centroid cost, cheapest first
ARCHETYPE_NAMES = [
    ("reroll", "Reroll", "low-cost units 3-starred at a lower level"),
    ("flex",   "Flex",   "standard fast-8 boards of 3- and 4-costs"),
    ("fast9",  "Fast 9", "high-cost boards that level to 9 for 4- and 5-costs"),
]


def unit_costs() -> dict[str, int]:
    """Riot character_id (DA_*) → shop cost, from calculator_data.json."""
    calc = json.loads(CALC_DATA.read_text(encoding="utf-8"))
    return {u["cdId"]: u["cost"] for u in calc["units"].values() if u.get("cdId") and u.get("cost")}


def train_clustering(df_path: Path, n_clusters: int = 3) -> None:
    print("\n=== Model C: K-Means Comp Archetypes ===")
    costs = unit_costs()
    df = pd.read_csv(df_path).dropna(subset=["placement"])

    # _unit_items is {character_id: [items]}; units without a known cost (summons) are skipped
    def avg_cost(blob: str) -> float:
        known = [costs[c] for c in json.loads(blob) if c in costs]
        return float(np.mean(known)) if known else np.nan
    df["avg_unit_cost"] = df["_unit_items"].map(avg_cost)
    df = df.dropna(subset=ARCHETYPE_FEATURES)

    scaler = StandardScaler()
    X = scaler.fit_transform(df[ARCHETYPE_FEATURES])
    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    df["cluster"] = kmeans.fit_predict(X)

    # Name clusters by centroid cost so labels survive retraining
    cost_order = np.argsort(scaler.inverse_transform(kmeans.cluster_centers_)[:, 0])
    archetypes = []
    for rank, c in enumerate(cost_order):
        key, label, desc = ARCHETYPE_NAMES[rank]
        rows = df[df["cluster"] == c]
        win = rows[rows["placement"] <= 4]
        bench = {
            "games": int(len(rows)),
            "avg_placement": round(float(rows["placement"].mean()), 2),
            "top4_rate": round(float((rows["placement"] <= 4).mean()), 3),
            # What winning looks like in this archetype (top-4 games only, like challengerBench)
            "level": float(win["level"].median()),
            "unit_star_avg": round(float(win["unit_star_avg"].median()), 3),
            "gold_left": float(win["gold_left"].median()),
            "level_efficiency": round(float(win["level_efficiency"].mean()), 3),
            "avg_unit_cost": round(float(rows["avg_unit_cost"].mean()), 2),
        }
        top = rows["top_trait"].value_counts().head(4).index.tolist()
        archetypes.append({"key": key, "label": label, "description": desc,
                           "centroid": [round(float(v), 6) for v in kmeans.cluster_centers_[c]],
                           "benchmarks": bench, "top_traits": top})
        print(f"  {label:7s} n={bench['games']:6d}  cost={bench['avg_unit_cost']:.2f}  "
              f"top-4: level {bench['level']:.0f}, stars {bench['unit_star_avg']:.2f}, gold {bench['gold_left']:.0f}  "
              f"| avg place {bench['avg_placement']:.2f} | {', '.join(top)}")

    with open(MODELS_DIR / "kmeans.pkl", "wb") as f:
        pickle.dump({"kmeans": kmeans, "scaler": scaler, "features": ARCHETYPE_FEATURES,
                     "names": {int(c): ARCHETYPE_NAMES[r][0] for r, c in enumerate(cost_order)}}, f)

    # server.js classifies games from this file (nearest centroid in scaled space)
    out = {
        "trained_on": int(len(df)),
        "features": ARCHETYPE_FEATURES,
        "scaler_mean": [round(float(v), 6) for v in scaler.mean_],
        "scaler_scale": [round(float(v), 6) for v in scaler.scale_],
        "unit_costs": costs,
        "archetypes": archetypes,
    }
    path = MODELS_DIR / "archetypes.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"  Exported {path.name} ({path.stat().st_size // 1024} KB)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    features_path = PROCESSED_DIR / "match_features.csv"
    live_dir = Path(__file__).parent.parent / "data" / "live"

    # python src/train.py           → all models
    # python src/train.py mlp       → just the placement MLP (+ mlp_weights.json export)
    only = set(sys.argv[1:])
    if not features_path.exists():
        print("No feature file found. Run: python src/features.py first.")
    else:
        if not only or "mlp" in only:
            train_mlp(features_path)
        if not only or "kmeans" in only:
            train_clustering(features_path)
        if not only or "lstm" in only:
            train_lstm(live_dir)
